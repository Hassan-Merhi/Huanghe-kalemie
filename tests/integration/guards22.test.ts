import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, parties } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A27: what the twenty-second accounting audit found after A26. */
describe.skipIf(!hasDb)("Guards found by the twenty-second audit", async () => {
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

  /** USD balance (debit − credit) of an account. */
  async function usdOf(accountId: number) {
    const [r] = await db.select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` }).from(journalLines).where(eq(journalLines.accountId, accountId));
    return r.usd;
  }
  /** A residue left the old way, by a journal posted exactly as given. */
  async function oldResidue(accountId: number, partyId: number, currency: "CDF" | "CNY", native: string, usd: string, rate: string, date = today) {
    await db.transaction((tx) =>
      ledger.postJournal(tx, {
        date,
        type: "manual",
        memo: "Reste",
        exactValues: true,
        lines: [
          { accountId, partyId, credit: usd, currency, nativeAmount: native, rate },
          { accountId: cashUsd, debit: usd },
        ],
      }),
    );
  }
  async function supplier(name: string) {
    const r = await call("POST", "/api/parties", { type: "supplier", name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** An arrived yuan container of one piece at `price` CNY, offloaded today. */
  async function yuanBill(supplierId: number, price: string) {
    const c = await call("POST", "/api/containers", { number: `A27-${uniq()}`, supplierId, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${c.body.id}/lines`, { lines: [{ variantId: await item("Pièce L2"), quantity: "1", unitPrice: price }] })).status).toBe(200);
    const f = await call("POST", `/api/containers/${c.body.id}/finalize`, { offloadDate: today });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
  }
  const pay = (partyId: number, amount: string, settleNative?: string, who = "gerant") =>
    call("POST", "/api/money/party-payment", { date: today, partyId, accountId: cashUsd, amount, ...(settleNative ? { settleNative } : {}) }, who);
  const residueLine = async (journalId: number) => (await journalSums(journalId)).rows.find((l) => l.memo === ledger.RESIDUE_MEMO);

  it("L1: francs worth under half a cent are cleared with no money, and no cent goes out for them", async () => {
    const odd = dayOffset(-3);
    expect((await call("POST", "/api/exchange-rates", { date: odd, cdfPerUsd: "2833.3333" })).status).toBeLessThan(300);
    // 57 FC in, 56 FC back: the 1 FC left (worth 0,035 cent) is cleared in the refund itself, so the cent
    // that cleared it (A26) is refused, cycle after cycle, and no dollar leaves the till.
    const c = await customer("Client L1");
    const [usd0, fx0] = [await usdOf(cashUsd), await usdOf(fx)];
    for (let i = 0; i < 3; i++) {
      expect((await call("POST", "/api/money/customer-receipt", { date: odd, partyId: c, accountId: cashCdf, amount: "57" }, "gerant")).status).toBe(201);
      const back = await call("POST", "/api/vouchers/payment", { date: odd, accountId: cashCdf, lines: [{ partyId: c, amount: "56" }] }, "gerant");
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      const line = await residueLine(back.body.id);
      expect([line?.nativeAmount, line?.debit, line?.credit]).toEqual(["1.00", "0.00", "0.00"]);
      expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
      expect((await call("POST", "/api/vouchers/payment", { date: odd, accountId: cashUsd, lines: [{ partyId: c, amount: "0.01" }] }, "gerant")).status).toBe(403);
    }
    expect([await usdOf(cashUsd), await usdOf(fx)]).toEqual([usd0, fx0]);

    // 28 334 FC held against a 10 $ debt are worth 0,01 cent net: nothing to refund.
    const v = await item("Pièce L1", "10");
    const c2 = await customer("Client L1b");
    expect((await call("POST", "/api/money/customer-receipt", { date: odd, partyId: c2, accountId: cashCdf, amount: "28334" }, "gerant")).status).toBe(201);
    const sale = await call("POST", "/api/sales", { date: odd, locationId, customerId: c2, lines: [{ variantId: v, qty: "1", unitPrice: "10" }], payments: [] }, "gerant");
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect((await call("POST", "/api/vouchers/payment", { date: odd, accountId: cashUsd, lines: [{ partyId: c2, amount: "0.01" }] }, "gerant")).status).toBe(403);

    // A residue left by an older posting goes the next time the contact is touched, at its book value
    // against exchange differences (here a 0,01 $ gain), with no money for it.
    const c3 = await customer("Client L1c");
    await oldResidue(receivables, c3, "CDF", "10", "0.01", "2808");
    expect(await owed(c3, "CDF", receivables)).toEqual(["-10.00", "-0.01"]);
    const paid = await call("POST", "/api/money/customer-receipt", { date: today, partyId: c3, accountId: cashUsd, amount: "5" }, "gerant");
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await owed(c3, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect(await owed(c3, "USD", receivables)).toEqual(["0.00", "-5.00"]);
    const j = await journalSums(paid.body.id);
    expect([j.net(fx), j.net(cashUsd)]).toEqual(["-0.01", "5.00"]);
    // A balance with something dated later is left alone: clearing it on an earlier day would change what
    // the later posting settled.
    const c4 = await customer("Client L1d");
    await oldResidue(receivables, c4, "CDF", "10", "0.01", "2808", dayOffset(-1));
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c4, accountId: cashCdf, amount: "100" }, "gerant")).status).toBe(201);
    expect((await call("POST", "/api/money/customer-receipt", { date: dayOffset(-1), partyId: c4, accountId: cashUsd, amount: "5" }, "gerant")).status).toBe(201);
    expect(await owed(c4, "CDF", receivables)).toEqual(["-110.00", "-0.05"]);
  });

  it("L2: the dollars shown settle all the yuan owed, and yuan worth under half a cent are cleared", async () => {
    // 71,03 ¥ show as 10,00 $ at 7,1: paying that settles every yuan (it left 0,03 ¥ at 0 $ before).
    const s1 = await supplier("Fournisseur L2");
    await yuanBill(s1, "71.03");
    expect((await pay(s1, "10.00")).status).toBe(201);
    expect([await owed(s1, "CNY"), await owed(s1, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
    // Settling all but 0,03 ¥ (0,4 cent) clears them in the same payment.
    const s2 = await supplier("Fournisseur L2b");
    await yuanBill(s2, "71");
    const p2 = await pay(s2, "10.00", "70.97");
    expect(p2.status, JSON.stringify(p2.body)).toBe(201);
    expect((await residueLine(p2.body.id))?.nativeAmount).toBe("0.03");
    expect(await owed(s2, "CNY")).toEqual(["0.00", "0.00"]);
    // 0,04 ¥ are worth half a cent or more, so they stay owed, and their 0,01 $ settles them, the 5 % check
    // notwithstanding (0,04 ¥ for 0,01 $ is 4 ¥ to the dollar).
    const s3 = await supplier("Fournisseur L2c");
    await yuanBill(s3, "71.04");
    expect((await pay(s3, "10.00", "71.00")).status).toBe(201);
    expect(await owed(s3, "CNY")).toEqual(["-0.04", "-0.01"]);
    const p3 = await pay(s3, "0.01", "0.04");
    expect(p3.status, JSON.stringify(p3.body)).toBe(201);
    expect([await owed(s3, "CNY"), await owed(s3, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
    // A wrong rate is still refused, by the owner too.
    const s4 = await supplier("Fournisseur L2d");
    await yuanBill(s4, "71");
    expect((await pay(s4, "1.00", "71")).status).toBe(400);
    expect((await pay(s4, "10.00", "7.10", "admin")).status).toBe(400);
    expect((await pay(s4, "10.50", "71")).status).toBe(201);
    // 0,03 ¥ left by an older posting: nothing to pay in yuan, and a dollar payment clears them (the dollars
    // are an advance; the 0,01 $ they were booked at is an exchange gain).
    const s5 = await supplier("Fournisseur L2e");
    await oldResidue(payables, s5, "CNY", "0.03", "0.01", "3");
    const refused = await pay(s5, "0.01", "0.03", "admin");
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/half a cent/);
    const p5 = await pay(s5, "0.01");
    expect(p5.status, JSON.stringify(p5.body)).toBe(201);
    expect([await owed(s5, "CNY"), await owed(s5, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.01"]]);
    expect((await journalSums(p5.body.id)).net(fx)).toBe("-0.01");
    // A dollar advance of at least the yuan's shown value settles all of them.
    const s6 = await supplier("Fournisseur L2f");
    expect((await pay(s6, "10.00")).status).toBe(201);
    await yuanBill(s6, "71.03");
    expect([await owed(s6, "CNY"), await owed(s6, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
  });

  it("L3: the avoir used on a sale page is capped at the credit left after returns", async () => {
    const v = await item("Pièce L3", "60");
    const day = dayOffset(-2);
    // 100 $ avoir, 2 × 60 $ on credit, one brought back: 60 $ left on credit, all of it on the avoir.
    const c = await customer("Client L3");
    const d0 = await daily(day);
    expect((await call("POST", "/api/money/customer-receipt", { date: dayOffset(-4), partyId: c, accountId: cashUsd, amount: "100" }, "gerant")).status).toBe(201);
    const sale = await call("POST", "/api/sales", { date: day, locationId, customerId: c, lines: [{ variantId: v, qty: "2", unitPrice: "60" }], payments: [] }, "gerant");
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.avoirUsedUsd).toBe("100.00");
    const back = (id: number, lineId: number, qty: string) => call("POST", `/api/sales/${id}/returns`, { date: today, lines: [{ saleLineId: lineId, qty }], refundAccountId: cashUsd, reason: "Retour" }, "gerant");
    expect((await back(sale.body.id, sale.body.lines[0].id, "1")).status).toBe(200);
    const page = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect([page.creditUsd, page.creditLeftUsd, page.avoirUsedUsd, page.avoirAtSaleUsd]).toEqual(["120.00", "60.00", "60.00", "100.00"]);
    // Accordé 120 − retours 60 − sur l'avoir 60 = reste 0: the rows add up, as the list and the day's report read it.
    expect(Number(page.creditUsd) - (Number(page.creditUsd) - Number(page.creditLeftUsd)) - Number(page.avoirUsedUsd)).toBe(0);
    expect((await listRow(sale.body.id, day)).avoirUsedUsd).toBe("60.00");
    const d1 = await daily(day);
    expect([diff(d1.credit, d0.credit), diff(d1.creditOnAvoirUsd, d0.creditOnAvoirUsd)]).toEqual(["60.00", "60.00"]);
    // All of an avoir sale brought back: no credit left, so none of it on the avoir; the receipt keeps what it was.
    const c2 = await customer("Client L3b");
    expect((await call("POST", "/api/money/customer-receipt", { date: day, partyId: c2, accountId: cashUsd, amount: "60" }, "gerant")).status).toBe(201);
    const s2 = await call("POST", "/api/sales", { date: day, locationId, customerId: c2, lines: [{ variantId: v, qty: "1", unitPrice: "60" }], payments: [] }, "gerant");
    expect(s2.status, JSON.stringify(s2.body)).toBe(201);
    expect((await back(s2.body.id, s2.body.lines[0].id, "1")).status).toBe(200);
    const page2 = (await call("GET", `/api/sales/${s2.body.id}`)).body;
    expect([page2.creditLeftUsd, page2.avoirUsedUsd, page2.avoirAtSaleUsd]).toEqual(["0.00", "0.00", "60.00"]);
    expect((await listRow(s2.body.id, day)).avoirUsedUsd).toBe("0.00");
  });
});
