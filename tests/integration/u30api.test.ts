import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U30: Analyses' "Ventes à crédit" reads the credit as the Sales list does, after returns and apart from what a
 * customer's avoir covered. Read only: no posting changes.
 */
describe.skipIf(!hasDb)("Twenty-fifth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const insights = await import("../../server/services/insights");
  const ops = await import("../../server/services/operations");
  const salesSvc = await import("../../server/services/sales");
  const userId = 1;
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, locationId: number;
  const api = async (method: string, path: string, body?: unknown) => {
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
  const product = async (name: string, sellPrice: string, unit: string) =>
    (await db.transaction((tx) => catalog.createProduct(tx, { name, unit, variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;
  const opening = (variantId: number, qty: string, unitCost: string) =>
    db.transaction((tx) => ops.adjustStock(tx, { date: "2026-09-02", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: qty, unitCost }] }, userId));
  const customer = async (name: string) => (await db.insert(parties).values({ type: "customer", name }).returning())[0].id;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    const capital = accs.find((a) => a.type === "equity")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values({ date: "2026-09-01", cdfPerUsd: "2808" });
    await db.transaction((tx) => ops.manualJournal(tx, { date: "2026-09-01", memo: "Ouverture", lines: [{ accountId: cashUsd, debit: "30000" }, { accountId: capital, credit: "30000" }] }, userId));
    expect((await api("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
  });
  afterAll(() => server?.close());

  it("counts the credit after returns, and the part an avoir covered apart", async () => {
    const tyre = await product("Pneu U30", "22", "pcs");
    const pads = await product("Plaquettes U30", "6", "set");
    await opening(tyre, "10", "12");
    await opening(pads, "10", "2");
    // 23 $ paid ahead, then 28 $ on credit: 23 $ from the avoir, 5 $ owed.
    const bahati = await customer("Atelier Bahati U30");
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-09-04", partyId: bahati, accountId: cashUsd, amount: "23" }, userId));
    await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-09-05", locationId, customerId: bahati, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }, { variantId: pads, qty: "1", unitPrice: "6" }], payments: [] }, userId));
    // 22 $ on credit brought back the same day: nothing is owed on it any more.
    const kasongo = await customer("Garage Kasongo U30");
    const back = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-09-05", locationId, customerId: kasongo, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }], payments: [] }, userId));
    await db.transaction((tx) => salesSvc.returnSale(tx, back.id, { date: "2026-09-05", reason: "Erreur", refundAccountId: null, lines: [{ saleLineId: back.lines[0].id, qty: "1" }] }, userId));
    // 12 $ on credit, nothing ahead: all of it owed.
    const moise = await customer("Moïse U30");
    await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-09-06", locationId, customerId: moise, lines: [{ variantId: pads, qty: "2", unitPrice: "6" }], payments: [] }, userId));

    const a = await db.transaction((tx) => insights.analytics(tx, "2026-09-01", "2026-09-30"));
    // As given at the till, before returns and avoirs (kept for older pages).
    expect(a.sales.credit).toBe("62.00");
    expect(a.sales.creditOwed).toBe("17.00");
    expect(a.sales.creditOnAvoir).toBe("23.00");

    // The same figures as the Sales list's "Accordé à crédit" and "Sur l'avoir" for the period.
    const list = (await api("GET", "/api/sales?from=2026-09-01&to=2026-09-30")).body as { status: string; creditLeftUsd: string; avoirUsedUsd: string }[];
    const live = list.filter((r) => r.status !== "voided");
    const left = live.reduce((s, r) => s + Number(r.creditLeftUsd), 0);
    const avoir = live.reduce((s, r) => s + Number(r.avoirUsedUsd), 0);
    expect((left - avoir).toFixed(2)).toBe(a.sales.creditOwed);
    expect(avoir.toFixed(2)).toBe(a.sales.creditOnAvoir);
    const res = await api("GET", "/api/reports/analytics?from=2026-09-01&to=2026-09-30");
    expect(res.status).toBe(200);
    expect(res.body.sales).toMatchObject({ creditOwed: "17.00", creditOnAvoir: "23.00" });
  });
});
