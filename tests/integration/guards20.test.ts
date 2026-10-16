import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, parties } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A25: what the twentieth accounting audit found after A24. */
describe.skipIf(!hasDb)("Guards found by the twentieth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const payroll = await import("../../server/services/payroll");
  const operations = await import("../../server/services/operations");
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
  let cashUsd: number, cashCdf: number, openingEquity: number, rentId: number, otherIncome: number, fx: number, payables: number, locationId: number;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  async function item(name: string, sellPrice = "10", unit = "pcs") {
    const p = await call("POST", "/api/products", { name: `${name} ${uniq()}`, unit, variants: [{ attributes: {}, sellPrice }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const id = p.body.variants[0].id as number;
    const o = await call("POST", "/api/stock/adjustments", { date: dayOffset(-1), locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: id, qtyChange: "100", unitCost: "2" }] });
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
    rentId = accs.find((a) => a.type === "expense")!.id;
    for (const date of [dayOffset(-2), dayOffset(-1), today]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    }
    expect(
      (
        await call("POST", "/api/journals", {
          date: dayOffset(-2),
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
  /** A contact's balance on payables in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CDF" | "CNY") {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  const avoirOn = async (date: string) => (await call("GET", `/api/reports/daily?date=${date}`)).body.creditOnAvoirUsd as string;

  it("F1: the daily report's \"dont sur l'avoir\" reads the receivable in date order, as the sale page does", async () => {
    const v = await item("Pièce F1", "60");
    const yesterday = dayOffset(-1);
    // A: 100 $ paid ahead today, then a 60 $ credit sale back-dated to yesterday: it used no avoir.
    const a = await customer("Client F1a");
    const beforeA = Number(await avoirOn(yesterday));
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: a, accountId: cashUsd, amount: "100" })).status).toBe(201);
    const saleA = await call("POST", "/api/sales", { date: yesterday, locationId, customerId: a, lines: [{ variantId: v, qty: "1", unitPrice: "60" }], payments: [] });
    expect(saleA.status, JSON.stringify(saleA.body)).toBe(201);
    expect(saleA.body.avoirUsedUsd).toBeNull();
    expect((Number(await avoirOn(yesterday)) - beforeA).toFixed(2)).toBe("0.00");
    // B: a 60 $ credit sale today, then 100 $ paid ahead back-dated to yesterday: the sale used 60 $ of it.
    const b = await customer("Client F1b");
    const beforeB = Number(await avoirOn(today));
    const saleB = await call("POST", "/api/sales", { date: today, locationId, customerId: b, lines: [{ variantId: v, qty: "1", unitPrice: "60" }], payments: [] });
    expect(saleB.status, JSON.stringify(saleB.body)).toBe(201);
    expect((await call("POST", "/api/money/customer-receipt", { date: yesterday, partyId: b, accountId: cashUsd, amount: "100" })).status).toBe(201);
    expect((await call("GET", `/api/sales/${saleB.body.id}`)).body.avoirUsedUsd).toBe("60.00");
    expect((Number(await avoirOn(today)) - beforeB).toFixed(2)).toBe("60.00");
    // A line naming the customer on another account is not an avoir; a cancelled sale gave its avoir back.
    await db.transaction((tx) => ledger.postJournal(tx, { date: yesterday, type: "manual", memo: "Autre compte", lines: [{ accountId: cashUsd, debit: "40" }, { accountId: otherIncome, credit: "40", partyId: a }] }));
    expect((Number(await avoirOn(yesterday)) - beforeA).toFixed(2)).toBe("0.00");
    expect((await call("POST", `/api/sales/${saleB.body.id}/void`, { reason: "Erreur" })).status).toBe(200);
    expect((Number(await avoirOn(today)) - beforeB).toFixed(2)).toBe("0.00");
  });

  it("F2: a dollar advance applied to francs owed leaves whole francs, so they can all be paid", async () => {
    const e = await party("employee", "Employé F2");
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: e, accountId: cashUsd, amount: "37.13" })).status).toBe(201);
    const salaries = (await payroll.salaryAccountId(db))!;
    const month = today.slice(0, 7);
    const run = await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, currency: "CDF", rate: "2808", lines: [{ partyId: e, salary: "333333", withheld: "3333" }] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    // 37,13 $ at 2 808 FC is 104 261,04 FC: 104 261 FC are applied, so 225 739 FC are owed, not 225 738,96.
    const [fcOwed] = await owed(e, "CDF");
    expect(fcOwed).toBe("-225739.00");
    expect((await owed(e, "USD"))[1]).toBe("0.00");
    const pay = await call("POST", "/api/money/party-payment", { date: today, partyId: e, accountId: cashCdf, amount: "225739" });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(await owed(e, "CDF")).toEqual(["0.00", "0.00"]);
    expect((await call("POST", `/api/payroll/runs/${month}/cancel`, {})).status).toBe(200);

    // Dollars paid to someone owed francs settle whole francs too: 10,01 $ is 28 108 FC, not 28 108,08.
    const s = await party("supplier", "Fournisseur F2");
    await db.transaction((tx) =>
      ledger.postJournal(tx, { date: today, type: "manual", memo: "Facture FC", lines: [{ accountId: rentId, debit: "35.61" }, { accountId: payables, partyId: s, credit: "35.61", currency: "CDF", nativeAmount: "100000", rate: "2808" }] }),
    );
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashUsd, amount: "10.01" })).status).toBe(201);
    expect((await owed(s, "CDF"))[0]).toBe("-71892.00");
  });

  it("F2: francs paid ahead and applied to yuan leave whole francs on the deposit", async () => {
    const yuanBill = (partyId: number) =>
      db.transaction((tx) =>
        ledger.postJournal(tx, { date: today, type: "manual", memo: "Facture CNY", lines: [{ accountId: rentId, debit: "14.08" }, { accountId: payables, partyId, credit: "14.08", currency: "CNY", nativeAmount: "100", rate: "7.1" }] }),
      );
    // A franc deposit of 100 001 FC, then a bill of 100 CNY (14,08 $): 39 536 FC go to it, not 39 536,64.
    const s = await party("supplier", "Fournisseur F2b");
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashCdf, amount: "100001" })).status).toBe(201);
    await yuanBill(s);
    const lines = await db.transaction((tx) => operations.advanceToYuanLines(tx, payables, s, today));
    const francs = lines.find((l) => l.currency === "CDF")!;
    expect(String(francs.nativeAmount)).toBe("39536");
    expect(lines.find((l) => l.currency === "CNY")!.nativeAmount!.toString()).toBe("100");

    // Francs paid to a contact owed yuan: what is beyond the yuan stays as whole francs paid ahead.
    const t = await party("supplier", "Fournisseur F2c");
    await yuanBill(t);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: t, accountId: cashCdf, amount: "100001" })).status).toBe(201);
    expect(await owed(t, "CNY")).toEqual(["0.00", "0.00"]);
    const [left] = await owed(t, "CDF");
    expect(Number(left) % 1).toBe(0);
    expect(Number(left)).toBeGreaterThan(60000);
  });

  it("F3: francs given back from the same drawer are netted with the payment before they are valued", async () => {
    const v = await item("Moto F3", "120");
    // 337 000 FC taken, 100 FC back: the 336 900 FC kept are worth 119,98 $ (each side rounded alone gave 119,97).
    const s = await call(
      "POST",
      "/api/sales",
      { locationId, lines: [{ variantId: v, qty: "1", unitPrice: "120" }], payments: [{ accountId: cashCdf, amount: "337000" }], change: { accountId: cashCdf, amount: "100" } },
      "caisse",
    );
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect([s.body.paidKeptUsd, s.body.creditUsd, s.body.saleFcRoundingUsd]).toEqual(["119.98", "0.00", "-0.02"]);
    // The drawer books the francs kept at that value, with no exchange difference; the daybook says the same.
    const j = await journalSums(s.body.journalId);
    expect(j.net(cashCdf)).toBe("119.98");
    expect(j.by(cashCdf).reduce((n, l) => n + Number(l.nativeAmount), 0)).toBe(336900);
    expect(j.net(fx)).toBe("0.02");
    const row = (await call("GET", `/api/daybook?from=${today}&to=${today}`)).body.rows.find((r: any) => r.id === s.body.journalId);
    expect([row.amount, row.received, row.changeGiven, row.fxRounding, row.fxDiff]).toEqual(["120.00", "120.01", "0.03", "0.02", undefined]);
    // Dollar change stays exact to the cent: 28 080 FC for a 9,50 $ sale gives 0,50 $ back.
    const usd = await call("POST", "/api/sales", { locationId, lines: [{ variantId: v, qty: "1", unitPrice: "9.5" }], payments: [{ accountId: cashCdf, amount: "28080" }], change: { accountId: cashUsd, amount: "0.50" } });
    expect(usd.status, JSON.stringify(usd.body)).toBe(201);
    expect([usd.body.paidKeptUsd, usd.body.saleFcRoundingUsd]).toEqual(["9.50", "0.00"]);
  });
});
