import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U44: a payment that also applies an advance the supplier held reads, on the daybook and the voucher, as the
 * money paid with the advance apart (not their sum); a payroll run's cancelled advances are named as such, not as
 * an invoice; the analytics position gives the contacts' sides as the dashboard does. Read only and memo text:
 * what is posted is unchanged.
 */
describe.skipIf(!hasDb)("Thirty-eighth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const NB = " ";
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, transport: number, locationId: number, variantId: number, today: string;
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const daybookRow = async (id: number) => (await call("GET", `/api/daybook?from=${today}&to=${today}`)).body.rows.find((r: any) => r.id === id);
  async function offload(number: string, supplierId: number, yuan: string) {
    const box = await call("POST", "/api/containers", { number, supplierId, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId, quantity: "7", unitPrice: (Number(yuan) / 7).toFixed(2) }] })).status).toBe(200);
    const off = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: today });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
  }

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.12" })).status).toBeLessThan(300);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    transport = accounts.find((a) => a.name === "Transport local").id;
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "20000" }] })).status).toBe(201);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const product = await call("POST", "/api/products", { name: "Pneu U44", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] });
    variantId = product.body.variants[0].id;
  });
  afterAll(() => server?.close());

  it("shows a payment that also applied an advance as the money paid, the advance apart", async () => {
    const supplier = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe U44" })).body.id;
    await offload("U44-1", supplier, "7000");
    // 280 800 FC owed too (100 $): a 600 $ payment settles the francs, the rest is an advance, the yuan stay owed.
    expect((await call("POST", "/api/expenses", { date: today, accountId: transport, description: "Transport U44", amount: "280800", currency: "CDF", rate: "2808", payablePartyId: supplier })).status).toBe(201);
    const first = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: supplier, amount: "600" }] });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await daybookRow(first.body.id)).advance).toBeUndefined();
    const held = (await call<any[]>("GET", "/api/parties")).body.find((p) => p.id === supplier);
    expect(held.foreign.find((f: any) => f.currency === "CNY").native).toBe("-7000.00");

    // 100 $ more: 712 ¥ by the payment at 7,12, and the 500 $ advance settles 3 560 ¥ of the 6 288 ¥ left (as before).
    // Those yuan leave at their cost (7,10): the advance used is its 500 $, not the yuan's book value.
    const second = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: supplier, amount: "100" }] });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const row = await daybookRow(second.body.id);
    expect(row.amount).toBe("100.00");
    expect(row.advance).toEqual({ usd: "500.00", cny: "3560.00" });
    const voucher = (await call("GET", `/api/vouchers/${second.body.id}`)).body;
    expect(voucher.amount).toBe("100.00");
    expect(voucher.advance).toEqual({ usd: "500.00", cny: "3560.00" });
    // The journal itself is as it was: the advance's pair, and 100 $ out of the box.
    const applied = voucher.lines.filter((l: any) => l.memo === "Avance imputée");
    expect(applied.map((l: any) => [l.currency, l.nativeAmount, l.credit])).toEqual([
      ["CNY", "3560.00", "0.00"],
      ["USD", null, "500.00"],
    ]);
    expect(voucher.lines.filter((l: any) => l.isMoney).map((l: any) => l.credit)).toEqual(["100.00"]);
    const after = (await call<any[]>("GET", "/api/parties")).body.find((p) => p.id === supplier);
    expect(after.foreign.find((f: any) => f.currency === "CNY").native).toBe("-2728.00");
  });

  it("keeps the amount of a journal that only applies an advance to a bill", async () => {
    const supplier = (await call("POST", "/api/parties", { type: "supplier", name: "Transit U44" })).body.id;
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: supplier, amount: "200" }] })).status).toBe(201);
    await offload("U44-2", supplier, "7000");
    const rows = (await call("GET", `/api/daybook?from=${today}&to=${today}`)).body.rows;
    const applied = rows.find((r: any) => r.sourceType === "advance_container" && r.lines.some((l: any) => l.partyName === "Transit U44"));
    // Every debit but the exchange difference, as before: nothing in it is money paid.
    const debits = applied.lines.filter((l: any) => !l.memo?.startsWith("Écart de change")).reduce((x: number, l: any) => x + Number(l.debit), 0);
    expect(applied.amount).toBe(debits.toFixed(2));
    expect(Number(applied.amount)).toBeGreaterThan(0);
    expect(applied.advance).toBeUndefined();
  });

  it("names a cancelled payroll's advances given back as the payroll, in French and as before in the books", async () => {
    const [{ id: jean }] = await db.insert(parties).values({ type: "employee", name: "Jean U44", monthlySalary: "150" }).returning();
    const salaries = (await call<any[]>("GET", "/api/accounts")).body.find((a) => a.name === "Salaires").id;
    const month = today.slice(0, 7);
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, memo: "Avance sur salaire", lines: [{ partyId: jean, amount: "150" }] })).status).toBe(201);
    const run = await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, currency: "CDF", rate: "2808", lines: [{ partyId: jean, salary: "421200" }] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await call("POST", `/api/payroll/runs/${month}/cancel`, {})).status).toBe(200);
    const rows = (await call("GET", `/api/daybook?from=${today}&to=${today}`)).body.rows;
    const back = rows.filter((r: any) => r.memo?.startsWith("Avance rendue"));
    expect(back.length).toBeGreaterThan(0);
    const { deMonth } = await import("@shared/french");
    for (const r of back) expect(r.memo).toBe(`Avance rendue${NB}: la paie ${deMonth(month)} est annulée`);
    // Jean holds his 150 $ advance again.
    const jeanNow = (await call<any[]>("GET", "/api/parties")).body.find((p) => p.id === jean);
    expect(Number(jeanNow.balance)).toBeCloseTo(150, 2);
  });

  it("gives the analytics position each contact's side, salary advances apart", async () => {
    const a = (await call("GET", `/api/reports/analytics?from=${today}&to=${today}`)).body;
    const dash = (await call("GET", "/api/reports/dashboard")).body;
    expect(a.contactBalances).toEqual(dash.contactBalances);
    expect(a.contactBalances.salaryAdvances).toBe("150.00");
  });
});
