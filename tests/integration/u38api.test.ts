import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U38: read-only figures the pages say before or after the server's own checks: a back-dated sale's stock as
 * of its day, what a cancelled sale gave back to the customer's avoir, the advances a saved payroll already
 * netted, and the container yuan check's French wording. No posting or guard changes.
 */
describe.skipIf(!hasDb)("Thirty-third UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const salesSvc = await import("../../server/services/sales");
  const payroll = await import("../../server/services/payroll");
  const NB = " ";
  const userId = 1;
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, locationId: number, today: string, yesterday: string;
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
  const product = async (name: string, sellPrice: string) =>
    (await db.transaction((tx) => catalog.createProduct(tx, { name, unit: "pcs", variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;
  const opening = (variantId: number, qty: string, date: string) =>
    db.transaction((tx) => ops.adjustStock(tx, { date, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: qty, unitCost: "5" }] }, userId));

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    const dt = new Date(`${today}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    yesterday = dt.toISOString().slice(0, 10);
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    const capital = accs.find((a) => a.type === "equity")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values({ date: yesterday, cdfPerUsd: "2808" });
    await db.transaction((tx) => ops.manualJournal(tx, { date: yesterday, memo: "Ouverture", lines: [{ accountId: cashUsd, debit: "30000" }, { accountId: capital, credit: "30000" }] }, userId));
  });
  afterAll(() => server?.close());

  it("gives a back-dated cart the stock that could leave on that day", async () => {
    const tyre = await product("Pneu U38", "22");
    await opening(tyre, "265", today);
    const now = (await call<any[]>("GET", `/api/variants?ids=${tyre}&locationId=${locationId}`)).body[0];
    expect(Number(now.locationQty)).toBe(265);
    const before = (await call<any[]>("GET", `/api/variants?ids=${tyre}&locationId=${locationId}&asOf=${yesterday}`)).body[0];
    expect(Number(before.locationQty)).toBe(0);
    const onDay = (await call<any[]>("GET", `/api/variants?ids=${tyre}&locationId=${locationId}&asOf=${today}`)).body[0];
    expect(Number(onDay.locationQty)).toBe(265);
    expect((await call("GET", `/api/variants?ids=${tyre}&locationId=${locationId}&asOf=2026-02-30`)).status).toBe(400);
    // And the sale the till would then refuse is refused by the server too.
    const sale = await call("POST", "/api/sales", { date: yesterday, locationId, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }], payments: [{ accountId: cashUsd, amount: "22" }] });
    expect(sale.status).toBe(409);
  });

  it("says what a cancelled credit sale gave back to the customer's avoir", async () => {
    const pads = await product("Plaquettes U38", "110");
    await opening(pads, "5", yesterday);
    const [{ id: customer }] = await db.insert(parties).values({ type: "customer", name: "Garage U38" }).returning();
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: today, partyId: customer, accountId: cashUsd, amount: "100" }, userId));
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: today, locationId, customerId: customer, lines: [{ variantId: pads, qty: "1", unitPrice: "110" }], payments: [] }, userId));
    const live = (await call("GET", `/api/sales/${sale.id}`)).body;
    expect(live.avoirAtSaleUsd).toBe("100.00");
    expect(live.avoirGivenBackUsd).toBeNull();
    expect((await call("POST", `/api/sales/${sale.id}/void`, { reason: "Erreur" })).status).toBe(200);
    const voided = (await call("GET", `/api/sales/${sale.id}`)).body;
    expect(voided.creditUsd).toBe("110.00");
    expect(voided.avoirGivenBackUsd).toBe("100.00");
    expect(voided.avoirUsedUsd).toBeNull();
    // The avoir is whole again.
    const c = (await call<any[]>("GET", "/api/parties?type=customer")).body.find((p) => p.id === customer);
    expect(c.balance).toBe("-100.00");
  });

  it("names the advances a saved payroll already took off the salary", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Employé U38", monthlySalary: "250" }).returning();
    const salaries = (await payroll.salaryAccountId(db))!;
    const month = today.slice(0, 7);
    expect((await call("POST", "/api/payroll/runs", { month, date: today, accountId: salaries, lines: [{ partyId: e, salary: "250" }] })).status).toBe(201);
    const employee = async () => (await call("GET", "/api/payroll")).body.employees.find((x: any) => x.id === e);
    expect((await employee()).advanceDeducted).toBeNull();
    const pay = (amount: string, memo: string) => call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, memo, lines: [{ partyId: e, amount, memo }] });
    expect((await pay("50", "Avance sur salaire")).status).toBe(201);
    expect(await employee()).toMatchObject({ balance: "-200.00", advanceDeducted: { month, usd: "50.00" } });
    // The salary payment is not an advance; what is paid beyond the salary stays an advance to repay.
    expect((await pay("200", `Salaire ${month}`)).status).toBe(201);
    expect(await employee()).toMatchObject({ balance: "0.00", advanceDeducted: { month, usd: "50.00" } });
    expect((await pay("30", "Avance")).status).toBe(201);
    expect(await employee()).toMatchObject({ balance: "30.00", advanceDeducted: { month, usd: "50.00" } });
  });

  it("refuses a yuan rate typed upside down with French spacing", async () => {
    const [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Fournisseur U38" }).returning();
    const res = await call("POST", "/api/containers", { number: "CNY-U38", supplierId, locationId, currency: "CNY", rateToUsd: "7.246376811594" });
    expect(res.status).toBe(400);
    expect(res.body.messageFr).toBe(`0,138${NB}¥ pour 1${NB}$ semble faux${NB}: un dollar vaut environ 7,1${NB}¥. Indiquez combien de yuans vaut 1${NB}$.`);
  });
});
