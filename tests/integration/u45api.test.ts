import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U45: a salary paid by an ordinary payment voucher is not an advance "déjà déduit"; a franc payroll run gives the
 * francs its advances took by their own amount; the till's search finds a motorcycle by its chassis number; the
 * analytics give the goods bought in containers still on the way. Read only: what is posted is unchanged.
 */
describe.skipIf(!hasDb)("Thirty-ninth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const userId = 1;
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, cashCdf: number, salaries: number, locationId: number, today: string, month: string;
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
  const employee = async (name: string, monthlySalary: string) => (await db.insert(parties).values({ type: "employee", name, monthlySalary }).returning())[0].id;
  const staff = async (id: number) => (await call("GET", "/api/payroll")).body.employees.find((x: any) => x.id === id);
  const pay = (accountId: number, memo: string | undefined, lines: { partyId: number; amount: string; memo?: string }[]) =>
    call("POST", "/api/vouchers/payment", { date: today, accountId, memo, lines });

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    month = today.slice(0, 7);
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.12" })).status).toBeLessThan(300);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "5000" }] })).status).toBe(201);
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, rate: "2808", lines: [{ accountId: otherIncome, amount: "2000000" }] })).status).toBe(201);
    salaries = (await payroll.salaryAccountId(db))!;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
  });
  afterAll(() => server?.close());

  it("does not call a salary paid by an ordinary payment voucher an advance already deducted", async () => {
    const e = await employee("Amani U45", "250");
    expect((await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, lines: [{ partyId: e, salary: "250" }] })).status).toBe(201);
    // "Salaires …" on the voucher, the line named after the employee (as the demo's salary voucher is).
    expect((await pay(cashUsd, `Salaires ${month}`, [{ partyId: e, amount: "250" }])).status).toBe(201);
    expect(await staff(e)).toMatchObject({ balance: "0.00", advanceDeducted: null });
    // A real advance once the salary is paid stays an advance to repay, not "déjà déduite".
    expect((await pay(cashUsd, "Avance sur salaire", [{ partyId: e, amount: "50", memo: "Avance sur salaire" }])).status).toBe(201);
    expect(await staff(e)).toMatchObject({ balance: "50.00", advanceDeducted: null });
    expect((await call("POST", `/api/payroll/runs/${month}/cancel`, {})).status).toBe(200);
  });

  it("gives a franc run's advances by the francs they took, not their dollars at the run's rate", async () => {
    const jean = await employee("Jean U45", "150");
    const bahati = await employee("Bahati U45", "250");
    // 200 000 FC paid in francs (71,23 $ at 2 808), and 50 $ paid in dollars.
    expect((await pay(cashCdf, "Avance sur salaire", [{ partyId: jean, amount: "200000", memo: "Avance sur salaire" }])).status).toBe(201);
    expect((await pay(cashUsd, "Avance sur salaire", [{ partyId: bahati, amount: "50", memo: "Avance sur salaire" }])).status).toBe(201);
    const run = await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, currency: "CDF", rate: "2808", lines: [{ partyId: jean, salary: "421200" }, { partyId: bahati, salary: "702000" }] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const posted = (await call("GET", "/api/payroll")).body.runs.find((r: any) => r.month === month && r.status === "posted");
    const line = (id: number) => posted.lines.find((l: any) => l.partyId === id);
    expect(line(jean)).toMatchObject({ advanceUsd: "71.23", advanceNative: "200000.00" });
    expect(line(bahati)).toMatchObject({ advanceUsd: "50.00", advanceNative: "140400.00" });
    // What is still owed is the same francs: 421 200 − 200 000.
    expect((await staff(jean)).foreign).toEqual([{ currency: "CDF", native: "-221200.00", usd: "-78.77" }]);
    expect((await call("POST", `/api/payroll/runs/${month}/cancel`, {})).status).toBe(200);
  });

  it("finds a motorcycle in stock by its chassis number, with that bike", async () => {
    const bike = await db.transaction((tx) => catalog.createProduct(tx, { name: "Moto U45", unit: "pcs", tracksSerials: true, variants: [{ attributes: {}, sellPrice: "1450" }] }));
    const variantId = bike.variants[0].id;
    await db.transaction((tx) =>
      ops.adjustStock(tx, { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "2", unitCost: "900", serials: [{ chassisNo: "LHJPCK200003", engineNo: "E1", color: "Rouge" }, { chassisNo: "LHJPCK200004", engineNo: null, color: null }] }] }, userId),
    );
    const scan = (await call<any[]>("GET", `/api/variants?search=lhjpck200003&locationId=${locationId}&limit=30`)).body;
    expect(scan[0]).toMatchObject({ id: variantId, matchedUnit: { chassisNo: "LHJPCK200003", engineNo: "E1", color: "Rouge" } });
    // Six characters or more of it list each bike; fewer find nothing by chassis.
    const typed = (await call<any[]>("GET", `/api/variants?search=PCK2000&locationId=${locationId}`)).body;
    expect(typed.filter((v) => v.matchedUnit).map((v) => v.matchedUnit.chassisNo)).toEqual(["LHJPCK200003", "LHJPCK200004"]);
    expect((await call<any[]>("GET", `/api/variants?search=PCK20&locationId=${locationId}`)).body.some((v) => v.matchedUnit)).toBe(false);
    // Not at another location.
    const other = (await call("POST", "/api/locations", { name: "Dépôt U45" })).body.id;
    expect((await call<any[]>("GET", `/api/variants?search=LHJPCK200003&locationId=${other}`)).body.some((v) => v.matchedUnit)).toBe(false);
  });

  it("gives the analytics the goods bought in containers on the way", async () => {
    const supplier = (await call("POST", "/api/parties", { type: "supplier", name: "Fournisseur U45" })).body.id;
    const product = await call("POST", "/api/products", { name: "Pneu U45", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] });
    const box = await call("POST", "/api/containers", { number: "U45-1", supplierId: supplier, locationId, currency: "USD", rateToUsd: "1", status: "in_transit" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "100", unitPrice: "14.025" }] })).status).toBe(200);
    const a = (await call("GET", `/api/reports/analytics?from=${today}&to=${today}`)).body;
    expect(a.goodsOnTheWayUsd).toBe("1402.50");
    const dash = (await call("GET", "/api/reports/dashboard")).body;
    expect(dash.openContainers.map((c: any) => c.purchaseUsd)).toEqual(["1402.50"]);
  });
});
