import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, parties } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A26: what the twenty-first accounting audit found after A25. */
describe.skipIf(!hasDb)("Guards found by the twenty-first audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  let db: Db;
  let server: Server;
  let base = "";
  const jar: Record<string, string> = {};
  async function call<T = any>(method: string, path: string, body?: unknown, who = "admin"): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jar[who] ? { cookie: jar[who] } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) jar[who] = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const dayOffset = (n: number) => new Date(Date.now() + 2 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const today = dayOffset(0);
  let cashUsd: number, cashCdf: number, openingEquity: number, rentId: number, otherIncome: number, fx: number, payables: number, receivables: number, locationId: number;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  async function item(name: string, sellPrice = "10", unit = "pcs") {
    const p = await call("POST", "/api/products", { name: `${name} ${uniq()}`, unit, variants: [{ attributes: {}, sellPrice }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const id = p.body.variants[0].id as number;
    const o = await call("POST", "/api/stock/adjustments", { date: dayOffset(-4), locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: id, qtyChange: "100", unitCost: "2" }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    return id;
  }
  async function customer(name: string) {
    const r = await call("POST", "/api/parties", { type: "customer", name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  async function journalSums(journalId: number) {
    const rows = await db.select().from(journalLines).where(eq(journalLines.journalId, journalId));
    const by = (accountId: number) => rows.filter((l) => l.accountId === accountId);
    const net = (accountId: number) => by(accountId).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0).toFixed(2);
    return { rows, by, net };
  }

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" }, "caisse")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    otherIncome = accs.find((a) => a.systemKey === "other_income")!.id;
    fx = accs.find((a) => a.systemKey === "fx")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    receivables = accs.find((a) => a.systemKey === "receivables")!.id;
    rentId = accs.find((a) => a.type === "expense")!.id;
    for (const date of [dayOffset(-4), dayOffset(-2), dayOffset(-1), today]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    }
    expect(
      (
        await call("POST", "/api/journals", {
          date: dayOffset(-4),
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "20000" },
            { accountId: cashCdf, debit: "20000", nativeAmount: "56160000", rate: "2808" },
            { accountId: openingEquity, credit: "40000" },
          ],
        })
      ).status,
    ).toBeLessThan(300);
  });

  afterAll(() => {
    server?.close();
  });

  async function party(type: "supplier" | "employee", name: string) {
    const [p] = await db.insert(parties).values({ type, name: `${name} ${uniq()}`, ...(type === "employee" ? { monthlySalary: "1" } : {}) }).returning();
    return p.id;
  }
  /** A contact's balance on payables (or another account) in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CDF" | "CNY", accountId = payables) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, accountId), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  const daily = async (date: string) => (await call("GET", `/api/reports/daily?date=${date}`)).body as { credit: string; creditOnAvoirUsd: string };
  const listRow = async (saleId: number, date: string) => (await call<any[]>("GET", `/api/sales?from=${date}&to=${date}`)).body.find((r) => r.id === saleId);
  const diff = (after: string, before: string) => (Number(after) - Number(before)).toFixed(2);

  it("N1: the dollars shown for francs owed settle all of them, and a few francs left can be cleared with a cent", async () => {
    // At 2833.3333, 100 001 FC owed show as 35.29 $: paying that settles every franc (it left 13 FC before).
    const odd = dayOffset(-3);
    expect((await call("POST", "/api/exchange-rates", { date: odd, cdfPerUsd: "2833.3333" })).status).toBeLessThan(300);
    const s = await party("supplier", "Fournisseur N1");
    expect((await call("POST", "/api/expenses", { date: odd, accountId: rentId, description: "Loyer N1", amount: "100001", currency: "CDF", payablePartyId: s }, "gerant")).status).toBe(201);
    expect((await call("POST", "/api/money/party-payment", { date: odd, partyId: s, accountId: cashUsd, amount: "35.29" }, "gerant")).status).toBe(201);
    expect(await owed(s, "CDF")).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD")).toEqual(["0.00", "0.00"]);
    // A prepayment in francs refunded with the dollars it shows is refunded in full, by a manager too.
    const c = await customer("Client N1");
    expect((await call("POST", "/api/money/customer-receipt", { date: odd, partyId: c, accountId: cashCdf, amount: "100001" }, "gerant")).status).toBe(201);
    const refund = await call("POST", "/api/vouchers/payment", { date: odd, accountId: cashUsd, lines: [{ partyId: c, amount: "35.29" }] }, "gerant");
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    // At 2808, 100 000 FC paid as the 35.61 $ shown leave nothing (8 FC before); a smaller payment still
    // settles whole francs only.
    const s2 = await party("supplier", "Fournisseur N1b");
    expect((await call("POST", "/api/expenses", { date: today, accountId: rentId, description: "Loyer N1b", amount: "100000", currency: "CDF", payablePartyId: s2 }, "gerant")).status).toBe(201);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s2, accountId: cashUsd, amount: "20" }, "gerant")).status).toBe(201);
    expect(await owed(s2, "CDF")).toEqual(["-43840.00", "-15.61"]);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s2, accountId: cashUsd, amount: "15.61" }, "gerant")).status).toBe(201);
    expect(await owed(s2, "CDF")).toEqual(["0.00", "0.00"]);
    expect(await owed(s2, "USD")).toEqual(["0.00", "0.00"]);

    // 13 FC worth nothing in dollars, left on a balance the old way: one cent clears them, paid or refunded.
    // 13 of 100 001 FC owed left on the balance, with all their dollars gone.
    const residue = async (accountId: number, partyId: number) => {
      const [, usd] = await owed(partyId, "CDF", accountId);
      const value = (-Number(usd)).toFixed(2);
      await db.transaction((tx) =>
        ledger.postJournal(tx, {
          date: today,
          type: "manual",
          memo: "Reste",
          exactValues: true,
          lines: [
            { accountId, partyId, debit: value, currency: "CDF", nativeAmount: "99988", rate: "2808" },
            { accountId: cashUsd, credit: value },
          ],
        }),
      );
    };
    const s3 = await party("supplier", "Fournisseur N1c");
    expect((await call("POST", "/api/expenses", { date: today, accountId: rentId, description: "Loyer N1c", amount: "100001", currency: "CDF", payablePartyId: s3 }, "gerant")).status).toBe(201);
    await residue(payables, s3);
    expect(await owed(s3, "CDF")).toEqual(["-13.00", "0.00"]);
    // In francs it is still refused as worth less than a cent; a cent settles it.
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s3, accountId: cashCdf, amount: "13" }, "gerant")).status).toBe(400);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s3, accountId: cashUsd, amount: "0.01" }, "gerant")).status).toBe(201);
    expect(await owed(s3, "CDF")).toEqual(["0.00", "0.00"]);
    expect(await owed(s3, "USD")).toEqual(["0.00", "0.00"]);
    const c2 = await customer("Client N1b");
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c2, accountId: cashCdf, amount: "100001" }, "gerant")).status).toBe(201);
    await residue(receivables, c2);
    expect(await owed(c2, "CDF", receivables)).toEqual(["-13.00", "0.00"]);
    const cent = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: c2, amount: "0.01" }] }, "gerant");
    expect(cent.status, JSON.stringify(cent.body)).toBe(201);
    expect(await owed(c2, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect(await owed(c2, "USD", receivables)).toEqual(["0.00", "0.00"]);
    // Nothing is held for them any more, so a second cent is a payment nobody approved.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: c2, amount: "0.01" }] }, "gerant")).status).toBe(403);
  });

  it("N2: a cancelled sale's avoir part stays on its day and comes off on the cancellation's, as its credit does", async () => {
    const v = await item("Pièce N2", "60");
    const yesterday = dayOffset(-1);
    const c = await customer("Client N2");
    const [y0, t0] = [await daily(yesterday), await daily(today)];
    expect((await call("POST", "/api/money/customer-receipt", { date: yesterday, partyId: c, accountId: cashUsd, amount: "100" }, "gerant")).status).toBe(201);
    const sale = await call("POST", "/api/sales", { date: yesterday, locationId, customerId: c, lines: [{ variantId: v, qty: "1", unitPrice: "60" }], payments: [] }, "gerant");
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.avoirUsedUsd).toBe("60.00");
    expect((await call("POST", `/api/sales/${sale.body.id}/void`, { date: today, reason: "Erreur" }, "gerant")).status).toBe(200);
    const [y1, t1] = [await daily(yesterday), await daily(today)];
    expect([diff(y1.credit, y0.credit), diff(y1.creditOnAvoirUsd, y0.creditOnAvoirUsd)]).toEqual(["60.00", "60.00"]);
    expect([diff(t1.credit, t0.credit), diff(t1.creditOnAvoirUsd, t0.creditOnAvoirUsd)]).toEqual(["-60.00", "-60.00"]);
    // The sale page and the list show no avoir used on a cancelled sale.
    expect((await call("GET", `/api/sales/${sale.body.id}`)).body.avoirUsedUsd).toBeNull();
    expect((await listRow(sale.body.id, yesterday)).avoirUsedUsd).toBe("0.00");
  });

  it("N3: a returned sale's credit is gone however the return was refunded", async () => {
    const v = await item("Pièce N3", "30");
    const day = dayOffset(-2);
    const c = await customer("Client N3");
    const d0 = await daily(day);
    // All of a 60 $ credit sale on a 60 $ avoir, brought back and refunded from the till.
    expect((await call("POST", "/api/money/customer-receipt", { date: day, partyId: c, accountId: cashUsd, amount: "60" }, "gerant")).status).toBe(201);
    const sale = await call("POST", "/api/sales", { date: day, locationId, customerId: c, lines: [{ variantId: v, qty: "2", unitPrice: "30" }], payments: [] }, "gerant");
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.creditLeftUsd).toBe("60.00");
    const back = (qty: string) => call("POST", `/api/sales/${sale.body.id}/returns`, { date: today, lines: [{ saleLineId: sale.body.lines[0].id, qty }], refundAccountId: cashUsd, reason: "Retour" }, "gerant");
    // Half of it first: half the credit is left, half of it on the avoir.
    const half = await back("1");
    expect(half.status, JSON.stringify(half.body)).toBe(200);
    expect(half.body.creditLeftUsd).toBe("30.00");
    expect((await listRow(sale.body.id, day)).creditLeftUsd).toBe("30.00");
    let d1 = await daily(day);
    expect([diff(d1.credit, d0.credit), diff(d1.creditOnAvoirUsd, d0.creditOnAvoirUsd)]).toEqual(["30.00", "30.00"]);
    // Then the rest: nothing is left on credit on the list, the sale page or the day's report.
    expect((await back("1")).status).toBe(200);
    expect((await listRow(sale.body.id, day)).creditLeftUsd).toBe("0.00");
    expect((await call("GET", `/api/sales/${sale.body.id}`)).body.creditLeftUsd).toBe("0.00");
    d1 = await daily(day);
    expect([diff(d1.credit, d0.credit), diff(d1.creditOnAvoirUsd, d0.creditOnAvoirUsd)]).toEqual(["0.00", "0.00"]);
    expect(await owed(c, "USD", receivables)).toEqual(["0.00", "0.00"]);
    // A credit sale still unpaid: its return comes off the receivable, and the credit with it, as before.
    const c2 = await customer("Client N3b");
    const unpaid = await call("POST", "/api/sales", { date: day, locationId, customerId: c2, lines: [{ variantId: v, qty: "2", unitPrice: "30" }], payments: [] }, "gerant");
    const r = await call("POST", `/api/sales/${unpaid.body.id}/returns`, { date: today, lines: [{ saleLineId: unpaid.body.lines[0].id, qty: "1" }], refundAccountId: cashUsd, reason: "Retour" }, "gerant");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.returns[0].refundToBalanceUsd).toBe("30.00");
    expect((await listRow(unpaid.body.id, day)).creditLeftUsd).toBe("30.00");
  });
});
