import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, parties } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A24: what the nineteenth accounting audit found after A23. */
describe.skipIf(!hasDb)("Guards found by the nineteenth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const payroll = await import("../../server/services/payroll");
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
  let cashUsd: number, cashCdf: number, openingEquity: number, rentId: number, otherIncome: number, fx: number, locationId: number;
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

  it("N1: francs split into many payments are valued once per drawer, and must cover the sale", async () => {
    const v = await item("Pièce N1");
    const line = [{ variantId: v, qty: "1", unitPrice: "10" }];
    // 1 000 legs of 15 FC: refused outright.
    const many = await call("POST", "/api/sales", { locationId, lines: line, payments: Array(1000).fill({ accountId: cashCdf, amount: "15" }) }, "caisse");
    expect(many.status, JSON.stringify(many.body)).toBe(400);
    // Ten legs of 1 500 FC are 15 000 FC (5,34 $), not ten times 0,53 $ rounded each: 4,66 $ is still owed.
    const ten = Array(10).fill({ accountId: cashCdf, amount: "1500" });
    const anon = await call("POST", "/api/sales", { locationId, lines: line, payments: ten }, "caisse");
    expect(anon.status, JSON.stringify(anon.body)).toBe(400);
    const c = await customer("Client N1");
    const credit = await call("POST", "/api/sales", { locationId, customerId: c, lines: line, payments: ten }, "caisse");
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    expect([credit.body.paidUsd, credit.body.creditUsd]).toEqual(["5.34", "4.66"]);
    expect(credit.body.payments.map((p: any) => [p.amountNative, p.amountUsd])).toEqual([["15000.00", "5.34"]]);
    // A normal mixed payment still goes through: 5 $ and 14 040 FC, the francs typed in two parts.
    const mixed = await call(
      "POST",
      "/api/sales",
      { locationId, lines: line, payments: [{ accountId: cashUsd, amount: "5" }, { accountId: cashCdf, amount: "7020" }, { accountId: cashCdf, amount: "7020" }] },
      "caisse",
    );
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
    expect([mixed.body.paidUsd, mixed.body.creditUsd]).toEqual(["10.00", "0.00"]);
    expect(mixed.body.payments.map((p: any) => [p.accountId, p.amountNative])).toEqual([[cashUsd, "5.00"], [cashCdf, "14040.00"]]);
    // The till's 100 FC rounding is untouched: 28 000 FC for 28 080 FC is 0,03 $ short.
    const round = await call("POST", "/api/sales", { locationId, lines: line, payments: [{ accountId: cashCdf, amount: "28000" }] }, "caisse");
    expect(round.status, JSON.stringify(round.body)).toBe(201);
    expect([round.body.paidUsd, round.body.creditUsd, round.body.saleFcRoundingUsd]).toEqual(["10.00", "0.00", "-0.03"]);
  });

  it("N2: a line worth less than a cent is refused, and the discount limit counts the cent lost to rounding", async () => {
    const v = await item("Pièce N2");
    const oil = await item("Huile N2", "4", "litre");
    const free = await call(
      "POST",
      "/api/sales",
      { locationId, lines: [{ variantId: v, qty: "1", unitPrice: "10" }, ...Array(150).fill({ variantId: oil, qty: "0.001", unitPrice: "4" })], payments: [{ accountId: cashUsd, amount: "10" }] },
      "caisse",
    );
    expect(free.status, JSON.stringify(free.body)).toBe(400);
    // 0,003 L at 4 $ is 0,012 $, sold for 0,01 $: 17 % off, over a cashier's 10 %. The owner may.
    const small = { locationId, lines: [{ variantId: oil, qty: "0.003", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "0.01" }] };
    expect((await call("POST", "/api/sales", small, "caisse")).status).toBe(403);
    expect((await call("POST", "/api/sales", { ...small, date: today })).status).toBe(201);
    // At most 200 lines on a sale.
    const long = await call("POST", "/api/sales", { locationId, lines: Array(201).fill({ variantId: oil, qty: "0.01", unitPrice: "4" }), payments: [{ accountId: cashUsd, amount: "8.04" }] }, "caisse");
    expect(long.status, JSON.stringify(long.body)).toBe(400);
    const ok = await call("POST", "/api/sales", { locationId, lines: Array(200).fill({ variantId: oil, qty: "0.01", unitPrice: "4" }), payments: [{ accountId: cashUsd, amount: "8" }] }, "caisse");
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("N3: a franc voucher of many lines books what the francs are worth, with no exchange difference", async () => {
    // 100 lines of 30 FC: 3 000 FC, 1,07 $ (each line alone would round to 0,01 $, 1,00 $ in all).
    const v = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: Array.from({ length: 100 }, (_, i) => ({ accountId: rentId, amount: "30", memo: `l${i}` })) }, "gerant");
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const j = await journalSums(v.body.id);
    expect(j.net(rentId)).toBe("1.07");
    expect(j.net(cashCdf)).toBe("-1.07");
    expect(j.by(fx)).toHaveLength(0);
    // Lines worth less than a cent each are refused, even though they add up to more.
    const tiny = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: Array(100).fill({ accountId: rentId, amount: "15" }) }, "gerant");
    expect(tiny.status, JSON.stringify(tiny.body)).toBe(400);
    // Receipts the same way.
    const r = await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, lines: Array(50).fill({ accountId: otherIncome, amount: "30" }) }, "gerant");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rj = await journalSums(r.body.id);
    expect([rj.net(cashCdf), rj.net(otherIncome)]).toEqual(["0.53", "-0.53"]);
    expect(rj.by(fx)).toHaveLength(0);
  });

  it("N3: a franc payroll costs what all its francs are worth", async () => {
    const emps = await db.insert(parties).values([0, 1, 2].map((i) => ({ type: "employee" as const, name: `Employé N3 ${i} ${uniq()}`, monthlySalary: "1" }))).returning();
    const salaries = (await payroll.salaryAccountId(db))!;
    const month = today.slice(0, 7);
    // 1 000 FC each is 0,356 $, 0,36 $ rounded; the 3 000 FC are 1,07 $.
    const run = await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, currency: "CDF", rate: "2808", lines: emps.map((e) => ({ partyId: e.id, salary: "1000" })) });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.totalUsd).toBe("1.07");
    const j = await journalSums(run.body.journalId);
    expect(j.net(salaries)).toBe("1.07");
    expect(j.rows.filter((l) => l.partyId).map((l) => l.credit).sort()).toEqual(["0.35", "0.36", "0.36"]);
    expect((await call("POST", `/api/payroll/runs/${month}/cancel`, {})).status).toBe(200);
  });

  it("N4: a cancelled sale shows no franc rounding and no avoir used, like the list and the ledger", async () => {
    const v = await item("Pièce N4");
    // 28 150 FC for 28 080 FC: 70 FC over, 0,02 $ kept by the shop.
    const s = await call("POST", "/api/sales", { date: today, locationId, lines: [{ variantId: v, qty: "1", unitPrice: "10" }], payments: [{ accountId: cashCdf, amount: "28150" }] });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.saleFcRoundingUsd).toBe("0.02");
    expect((await call("POST", `/api/sales/${s.body.id}/void`, { reason: "Erreur" })).status).toBe(200);
    const voided = (await call("GET", `/api/sales/${s.body.id}`)).body;
    expect([voided.saleFcRoundingUsd, voided.fcRoundingUsd]).toEqual(["0.00", "0.00"]);
    const listed = (await call<any[]>("GET", `/api/sales?from=${today}&to=${today}`)).body.find((x) => x.id === s.body.id);
    expect(listed.fcRoundingUsd).toBe("0.00");

    // 50 $ paid ahead, then a 30 $ sale on credit: it used 30 $ of the avoir, until cancelled.
    const c = await customer("Client N4");
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c, accountId: cashUsd, amount: "50" })).status).toBe(201);
    const credit = await call("POST", "/api/sales", { date: today, locationId, customerId: c, lines: [{ variantId: v, qty: "3", unitPrice: "10" }], payments: [] });
    expect([credit.body.avoirUsedUsd, credit.body.avoirLeftUsd]).toEqual(["30.00", "20.00"]);
    expect((await call("POST", `/api/sales/${credit.body.id}/void`, { reason: "Erreur" })).status).toBe(200);
    const back = (await call("GET", `/api/sales/${credit.body.id}`)).body;
    expect([back.avoirUsedUsd, back.avoirLeftUsd]).toEqual([null, null]);
    const listedBack = (await call<any[]>("GET", `/api/sales?from=${today}&to=${today}`)).body.find((x) => x.id === credit.body.id);
    expect(listedBack.avoirUsedUsd).toBe("0.00");
  });

  it("N4: the avoir a sale used is read from the customer's receivable, in date order", async () => {
    const v = await item("Pièce N4b");
    const c = await customer("Client N4b");
    // A line naming the customer on another account is not money they paid ahead.
    await db.transaction((tx) =>
      ledger.postJournal(tx, { date: dayOffset(-1), type: "manual", memo: "Autre compte", lines: [{ accountId: cashUsd, debit: "40" }, { accountId: otherIncome, credit: "40", partyId: c }] }),
    );
    // An avoir paid today, posted before a credit sale dated yesterday: the sale did not use it.
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c, accountId: cashUsd, amount: "50" })).status).toBe(201);
    const early = await call("POST", "/api/sales", { date: dayOffset(-1), locationId, customerId: c, lines: [{ variantId: v, qty: "1", unitPrice: "10" }], payments: [] });
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    expect(early.body.avoirUsedUsd).toBeNull();
    const listed = (await call<any[]>("GET", `/api/sales?from=${dayOffset(-1)}&to=${dayOffset(-1)}`)).body.find((x) => x.id === early.body.id);
    expect(listed.avoirUsedUsd).toBe("0.00");
    // A sale today does use it: 50 $ paid less the 10 $ owed from yesterday leaves 40 $.
    const later = await call("POST", "/api/sales", { date: today, locationId, customerId: c, lines: [{ variantId: v, qty: "1", unitPrice: "10" }], payments: [] });
    expect([later.body.avoirUsedUsd, later.body.avoirLeftUsd]).toEqual(["10.00", "30.00"]);
  });
});
