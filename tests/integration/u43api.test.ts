import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, exchangeRates, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U43: a packing list for a franc container refuses franc centimes in a unit price (a tightened guard), and the
 * payroll's runs say, read only, what part of each net came off an advance the employee already had. No
 * posting changes.
 */
describe.skipIf(!hasDb)("Thirty-seventh UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const NB = " ";
  const userId = 1;
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, locationId: number, supplierId: number, today: string;
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

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    await db.insert(exchangeRates).values({ date: today, cdfPerUsd: "2808" });
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    const capital = accs.find((a) => a.type === "equity")!.id;
    await db.transaction((tx) => ops.manualJournal(tx, { date: today, memo: "Ouverture", lines: [{ accountId: cashUsd, debit: "30000" }, { accountId: capital, credit: "30000" }] }, userId));
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Fournisseur U43" })).body.id;
  });
  afterAll(() => server?.close());

  it("refuses franc centimes in a packing list's unit price for a franc container", async () => {
    const c = await call("POST", "/api/containers", { number: "CDF-U43", supplierId, locationId, currency: "CDF", rateToUsd: (1 / 2808).toFixed(12) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    // "8 400,5" FC × 20 would go into stock as 8 401 FC each but 168 010 FC for the line.
    const cents = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Casque U43", unit: "pcs", quantity: "20", unitPrice: "8400.5" }] });
    expect(cents.status).toBe(400);
    expect(cents.body.messageFr).toBe(`Ligne 2${NB}: Les montants en FC sont des nombres entiers (8${NB}400,5${NB}FC a des décimales)`);
    expect((await call("GET", `/api/containers/${c.body.id}`)).body.lines).toHaveLength(0);
    // Whole francs go through as before, and a dollar container still takes cents.
    const whole = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Casque U43", unit: "pcs", quantity: "20", unitPrice: "8400" }] });
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body.container.lines.map((l: any) => Number(l.unitPrice))).toEqual([8400]);
    const usd = await call("POST", "/api/containers", { number: "USD-U43", supplierId, locationId, currency: "USD" });
    const dollars = await call("POST", `/api/containers/${usd.body.id}/import-lines`, { mode: "append", rows: [{ name: "Casque U43", unit: "pcs", quantity: "2", unitPrice: "3.25" }] });
    expect(dollars.status, JSON.stringify(dollars.body)).toBe(200);
  });

  it("says which part of each salary came off an advance the employee already had", async () => {
    const [{ id: jean }] = await db.insert(parties).values({ type: "employee", name: "Jean U43", monthlySalary: "150" }).returning();
    const [{ id: paul }] = await db.insert(parties).values({ type: "employee", name: "Paul U43", monthlySalary: "100" }).returning();
    const salaries = (await payroll.salaryAccountId(db))!;
    const month = today.slice(0, 7);
    // Jean had 150 $ ahead; Paul nothing.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, memo: "Avance sur salaire", lines: [{ partyId: jean, amount: "150", memo: "Avance sur salaire" }] })).status).toBe(201);
    // 421 200 FC is 150,00 $ at 2 808; 280 800 FC is 100,00 $.
    const run = await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, currency: "CDF", rate: "2808", lines: [{ partyId: jean, salary: "421200" }, { partyId: paul, salary: "280800" }] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const lines = async () => (await call("GET", "/api/payroll")).body.runs.find((r: any) => r.month === month && r.status === "posted").lines;
    const of = (ls: any[], id: number) => ls.find((l) => l.partyId === id);
    expect(of(await lines(), jean)).toMatchObject({ netUsd: "150.00", advanceUsd: "150.00" });
    expect(of(await lines(), paul)).toMatchObject({ netUsd: "100.00", advanceUsd: "0.00" });
    // Paying Paul in cash later changes nothing in it: only what stood before the run counts.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, memo: `Salaire ${month}`, lines: [{ partyId: paul, amount: "100" }] })).status).toBe(201);
    expect(of(await lines(), paul).advanceUsd).toBe("0.00");
    // The run as stored is unchanged; cancelled runs carry no such figure.
    expect((await call("POST", `/api/payroll/runs/${month}/cancel`, {})).status).toBe(200);
    const cancelled = (await call("GET", "/api/payroll")).body.runs.find((r: any) => r.month === month);
    expect(cancelled.status).toBe("cancelled");
    expect(of(cancelled.lines, jean).advanceUsd).toBeUndefined();
  });
});
