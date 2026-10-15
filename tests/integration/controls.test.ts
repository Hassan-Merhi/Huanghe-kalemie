import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { accounts, journalLines, motorcycleUnits, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Who may do what: owner-only accounts, price limits, what cashiers and partners see, records kept. */
describe.skipIf(!hasDb)("Controls and permissions", async () => {
  const { createApp } = await import("../../server/index");
  const payroll = await import("../../server/services/payroll");
  const reports = await import("../../server/services/reports");
  let db: Db;
  let server: Server;
  let base = "";

  function client() {
    let cookie = "";
    return async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  }

  const owner = client();
  const manager = client();
  const cashier = client();
  const partner = client();
  let today = "";
  let locationId = 0;
  let variantId = 0;
  let cashUsd = 0;
  let partnerA: { capitalAccountId: number; currentAccountId: number };
  let partnerB: { id: number; capitalAccountId: number; currentAccountId: number };

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await owner("POST", "/api/auth/login", { username: "admin", password: "test-password-123" });
    const ps = (await owner("GET", "/api/partners")).body;
    partnerA = ps[0];
    partnerB = ps[1];
    await owner("POST", "/api/users", { username: "gerant", fullName: "Gérant", role: "manager", password: "manager-pass" });
    await owner("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" });
    await owner("POST", "/api/users", { username: "assocb", fullName: "Associé B", role: "partner", partnerId: partnerB.id, password: "partner-pass" });
    await manager("POST", "/api/auth/login", { username: "gerant", password: "manager-pass" });
    await cashier("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" });
    await partner("POST", "/api/auth/login", { username: "assocb", password: "partner-pass" });

    today = (await owner("GET", "/api/settings")).body.today;
    locationId = (await owner("GET", "/api/locations")).body[0].id;
    const product = await owner("POST", "/api/products", { name: "Pneu", variants: [{ attributes: { Taille: "2.75-17" }, sellPrice: "25" }] });
    variantId = product.body.variants[0].id;
    // The owner enters opening stock at $15 a tyre.
    const adj = await owner("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "15" }] });
    expect(adj.status).toBe(201);
    cashUsd = (await owner("GET", "/api/accounts")).body.find((a: any) => a.systemKey === "cash_usd").id;
  });

  afterAll(() => {
    server?.close();
  });

  it("keeps partner, equity, opening and exchange accounts for the owner", async () => {
    const accs = (await owner("GET", "/api/accounts")).body as any[];
    const opening = accs.find((a) => a.systemKey === "opening_equity").id;
    const fx = accs.find((a) => a.systemKey === "fx").id;
    for (const accountId of [partnerA.currentAccountId, partnerB.capitalAccountId, opening, fx]) {
      const r = await manager("POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ accountId, amount: "10" }] });
      expect(r.status).toBe(403);
    }
    // The owner may: a partner putting money in.
    expect((await owner("POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ accountId: partnerA.capitalAccountId, amount: "500" }] })).status).toBe(201);
    // Ordinary accounts stay open to the manager.
    const rent = accs.find((a) => a.code === "6000").id;
    expect((await manager("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ accountId: rent, amount: "20" }] })).status).toBe(201);
  });

  it("keeps opening stock and stock imports for the owner", async () => {
    expect((await manager("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId, qtyChange: "1", unitCost: "1" }] })).status).toBe(403);
    expect((await manager("POST", "/api/stock/adjustments", { date: today, locationId, kind: "found", reason: "Recompté", lines: [{ variantId, qtyChange: "1" }] })).status).toBe(201);
    const withQty = await manager("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Chambre à air", qty: "5", unitCost: "2" }] });
    expect(withQty.status).toBe(403);
    expect((await manager("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Chambre à air", sellPrice: "4" }] })).status).toBe(201);
    // A draft cannot get around it either.
    const draft = await manager("POST", "/api/voucher-drafts", { kind: "adjustment", date: today, payload: { locationId, kind: "opening", reason: "x", lines: [{ variantId, qtyChange: "1", unitCost: "1" }] } });
    expect((await manager("POST", `/api/voucher-drafts/${draft.body.id}/finalize`)).status).toBe(403);
  });

  it("limits discounts by role and never lets a cashier sell below cost", async () => {
    const sell = (who: typeof cashier, unitPrice: string, extra: Record<string, unknown> = {}) =>
      who("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "1", unitPrice }], payments: [{ accountId: cashUsd, amount: String(Number(unitPrice) - Number(extra.discount ?? 0)) }], ...extra });
    // 10% for a cashier by default: 22.50 is the floor on a $25 tyre.
    expect((await sell(cashier, "22.50")).status).toBe(201);
    const tooMuch = await sell(cashier, "20");
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.message).toMatch(/10/);
    // A sale-level discount counts too.
    expect((await sell(cashier, "25", { discount: "5" })).status).toBe(403);
    // Managers get 20%.
    expect((await sell(manager, "20")).status).toBe(201);
    expect((await sell(manager, "19")).status).toBe(403);
    // With a wide limit, cost is still the floor, and the cashier is not told the cost.
    expect((await owner("PATCH", "/api/settings", { cashierDiscountPct: "100", managerDiscountPct: "100" })).status).toBe(200);
    const low = await sell(cashier, "10");
    expect(low.status).toBe(403);
    expect(low.body.message).not.toMatch(/15/);
    const lowManager = await sell(manager, "10");
    expect(lowManager.status).toBe(403);
    expect(lowManager.body.message).toMatch(/15/);
    // The owner can sell below cost, and can let managers do it.
    expect((await sell(owner, "10")).status).toBe(201);
    await owner("PATCH", "/api/settings", { managerBelowCost: true });
    expect((await sell(manager, "10")).status).toBe(201);
    expect((await sell(cashier, "10")).status).toBe(403);
  });

  it("sells today for a cashier and hides the cost of returns", async () => {
    const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    const sale = await cashier("POST", "/api/sales", { date: yesterday, locationId, lines: [{ variantId, qty: "2", unitPrice: "25" }], payments: [{ accountId: cashUsd, amount: "50" }] });
    expect(sale.status).toBe(201);
    expect(sale.body.date).toBe(today);
    const ret = await owner("POST", `/api/sales/${sale.body.id}/returns`, { reason: "Mauvaise taille", refundAccountId: cashUsd, lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status).toBe(200);
    expect(ret.body.returns[0].cogs).toBe("15.00");
    const seen = await cashier("GET", `/api/sales/${sale.body.id}`);
    expect(seen.body.returns).toHaveLength(1);
    expect(seen.body.returns[0].cogs).toBeUndefined();
    expect(JSON.stringify(seen.body)).not.toMatch(/"cogs"/);
  });

  it("shows a partner their own partner accounts only", async () => {
    expect((await partner("GET", `/api/accounts/${partnerA.capitalAccountId}/ledger?from=${today}&to=${today}`)).status).toBe(404);
    expect((await partner("GET", `/api/accounts/${partnerA.currentAccountId}/monthly?year=${today.slice(0, 4)}`)).status).toBe(404);
    expect((await partner("GET", `/api/accounts/${partnerB.capitalAccountId}/ledger?from=${today}&to=${today}`)).status).toBe(200);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, partnerA.capitalAccountId));
    for (const path of ["/api/accounts", "/api/accounts/balances"]) {
      const rows = (await partner("GET", path)).body as any[];
      expect(rows.some((r) => r.name === a.name)).toBe(false);
      expect(rows.some((r) => r.id === partnerB.capitalAccountId)).toBe(true);
      expect(rows.find((r) => r.name === "Autres associés").balance).toBe("-500.00");
    }
    const tb = (await partner("GET", "/api/reports/trial-balance")).body;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.some((r: any) => r.name === a.name)).toBe(false);
    expect((await owner("GET", "/api/reports/trial-balance")).body.rows.some((r: any) => r.name === a.name)).toBe(true);
  });

  it("keeps a removed motorcycle's record and brings it back when found", async () => {
    const moto = await owner("POST", "/api/products", { name: "Moto HJ125", tracksSerials: true, variants: [{ attributes: { Couleur: "Rouge" }, sellPrice: "1200" }] });
    const motoId = moto.body.variants[0].id;
    await owner("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: motoId, qtyChange: "1", unitCost: "900", serials: [{ chassisNo: "lbm123" }] }] });
    const [unit] = await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.chassisNo, "LBM123"));
    expect((await manager("POST", "/api/stock/adjustments", { date: today, locationId, kind: "loss", reason: "Volée", lines: [{ variantId: motoId, qtyChange: "-1", unitIds: [unit.id] }] })).status).toBe(201);
    const [gone] = await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.id, unit.id));
    expect(gone.status).toBe("removed");
    expect(gone.chassisNo).toBe("LBM123");
    expect((await owner("GET", "/api/units?status=removed")).body.map((u: any) => u.id)).toEqual([unit.id]);
    const found = await manager("POST", "/api/stock/adjustments", { date: today, locationId, kind: "found", reason: "Retrouvée", lines: [{ variantId: motoId, qtyChange: "1", unitCost: "900", serials: [{ chassisNo: "LBM123" }] }] });
    expect(found.status).toBe(201);
    const units = await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.variantId, motoId));
    expect(units).toHaveLength(1);
    expect(units[0].status).toBe("in_stock");
  });

  it("books withheld pay as a cost owed to others and penalties as less cost", async () => {
    const [emp] = await db.insert(parties).values({ type: "employee", name: "Amani", monthlySalary: "200" }).returning();
    const salaries = (await payroll.salaryAccountId(db))!;
    const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const run = await owner("POST", "/api/payroll/runs", { month: lastMonth, accountId: salaries, lines: [{ partyId: emp.id, salary: "200", bonus: "10", withheld: "15", penalty: "5" }] });
    expect(run.status).toBe(201);
    // Cost = 200 + 10 − 5 penalty = 205; the employee is owed 190; 15 waits for the tax office.
    expect(run.body.totalUsd).toBe("205.00");
    const lines = await db.select().from(journalLines).where(eq(journalLines.journalId, run.body.journalId));
    const withheldAcc = (await db.select().from(accounts).where(eq(accounts.systemKey, "payroll_withheld")))[0].id;
    expect(lines.find((l) => l.accountId === withheldAcc)!.credit).toBe("15.00");
    expect(lines.find((l) => l.partyId === emp.id)!.credit).toBe("190.00");

    // Cancelled runs are kept, and the month can be booked again, this time in francs.
    expect((await owner("POST", `/api/payroll/runs/${lastMonth}/cancel`, {})).status).toBe(200);
    await owner("POST", "/api/exchange-rates", { date: `${lastMonth}-28`, cdfPerUsd: "2800" });
    const fc = await owner("POST", "/api/payroll/runs", { month: lastMonth, date: `${lastMonth}-28`, accountId: salaries, currency: "CDF", lines: [{ partyId: emp.id, salary: "560000" }] });
    expect(fc.status).toBe(201);
    expect(fc.body.totalUsd).toBe("200.00");
    const runs = (await owner("GET", "/api/payroll")).body.runs as any[];
    expect(runs.map((r) => [r.status, r.currency])).toEqual([["cancelled", "USD"], ["posted", "CDF"]]);
    // The employee is owed francs, kept in francs.
    const staff = await payroll.employees(db);
    const owed = staff.find((e) => e.id === emp.id)!;
    expect(owed.foreign).toEqual([{ currency: "CDF", native: "-560000.00", usd: "-200.00" }]);
    expect((await reports.trialBalance(db)).balanced).toBe(true);
  });
});
