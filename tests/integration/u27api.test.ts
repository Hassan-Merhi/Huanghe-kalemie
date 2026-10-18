import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U27: the return slip's split of a credit-sale return between the debt and the avoir; the Sales list's avoir
 * before returns; the per-location unit cost by the valuation's rule; the transfer list's unit. All read only.
 */
describe.skipIf(!hasDb)("Twenty-second UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const insights = await import("../../server/services/insights");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const salesSvc = await import("../../server/services/sales");
  const { shownUnitCost } = await import("@shared/money");
  const { variantUnitCost } = await import("../../client/src/lib/format");
  const userId = 1;
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, customerId: number, locationId: number;
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
    db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: qty, unitCost }] }, userId));
  const balanceOf = async (id: number) => (await reports.partyBalances(db)).find((p) => p.id === id)!.balance;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    const capital = accs.find((a) => a.type === "equity")!.id;
    [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Atelier Bahati" }).returning();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values({ date: "2026-08-01", cdfPerUsd: "2808" });
    await db.transaction((tx) => ops.manualJournal(tx, { date: "2026-08-01", memo: "Ouverture", lines: [{ accountId: cashUsd, debit: "30000" }, { accountId: capital, credit: "30000" }] }, userId));
    expect((await api("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
  });
  afterAll(() => server?.close());

  it("splits a credit-sale return on the slip as the dialog did: off the debt, then the avoir", async () => {
    // 23 $ paid ahead, then 28 $ on credit (23 $ from the avoir, 5 $ owed); the 22 $ tyre comes back.
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-08-04", partyId: customerId, accountId: cashUsd, amount: "23" }, userId));
    const tyre = await product("Pneu", "22", "pcs");
    const pads = await product("Plaquettes", "6", "set");
    await opening(tyre, "5", "12");
    await opening(pads, "5", "2");
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-05", locationId, customerId, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }, { variantId: pads, qty: "1", unitPrice: "6" }], payments: [] }, userId));
    const before = await balanceOf(customerId);
    await db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-05", reason: "Erreur de taille", refundAccountId: null, lines: [{ saleLineId: sale.lines.find((l) => l.variantId === tyre)!.id, qty: "1" }] }, userId));
    expect(before).toBe("5.00");
    expect(await balanceOf(customerId)).toBe("-17.00");
    const full = await db.transaction((tx) => salesSvc.getSale(tx, sale.id));
    expect(full.returns[0]).toMatchObject({ total: "22.00", refundToBalanceUsd: "22.00", offDebtUsd: "5.00" });
    // A second return the same day finds the customer already in credit: all of it goes on the avoir.
    await db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-05", reason: "Pas besoin", refundAccountId: null, lines: [{ saleLineId: sale.lines.find((l) => l.variantId === pads)!.id, qty: "1" }] }, userId));
    const again = await db.transaction((tx) => salesSvc.getSale(tx, sale.id));
    expect(again.returns.map((r) => r.offDebtUsd)).toEqual(["5.00", "0.00"]);

    // The Sales list keeps the avoir's part at the sale beside the one after returns.
    const list = (await api("GET", "/api/sales?from=2026-08-01&to=2026-08-31")).body as { id: number; avoirUsedUsd: string; avoirAtSaleUsd: string }[];
    const row = list.find((r) => r.id === sale.id)!;
    expect(Number(row.avoirAtSaleUsd)).toBe(23);
    expect(Number(row.avoirUsedUsd)).toBe(0);
  });

  it("gives a return refunded from a drawer no debt/avoir split (its refundToBalanceUsd says it)", async () => {
    const item = await product("Casque", "10", "pcs");
    await opening(item, "3", "4");
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-06", locationId, lines: [{ variantId: item, qty: "1", unitPrice: "10" }], payments: [{ accountId: cashUsd, amount: "10" }] }, userId));
    await db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-06", reason: "Défaut", refundAccountId: cashUsd, lines: [{ saleLineId: sale.lines[0].id, qty: "1" }] }, userId));
    const full = await db.transaction((tx) => salesSvc.getSale(tx, sale.id));
    expect(full.returns[0].offDebtUsd).toBeNull();
  });

  it("shows the unit cost by the valuation's rule per location, the value staying exact", async () => {
    // 2,25 L at 0,125 $ kept as 0,28 $: 0,125 $ on the valuation, per location and on the count form.
    const fluid = await product("Liquide U26", "3", "litre");
    await opening(fluid, "2.25", "0.125");
    const [{ id: depot }] = await db.insert(locations).values({ name: "Dépôt Lac" }).returning();
    const moved = await api("POST", "/api/stock/transfers", { date: "2026-08-07", fromLocationId: locationId, toLocationId: depot, lines: [{ variantId: fluid, qty: "1" }] });
    expect(moved.status).toBe(201);
    const rows = (await db.transaction((tx) => insights.inventoryByLocation(tx))).filter((r) => r.variantId === fluid);
    expect(rows.map((r) => r.avgCost)).toEqual(["0.125000", "0.125000"]);
    // Each place's value is still the exact average times its quantity (0,1244 × 1,25 and × 1).
    expect(rows.map((r) => r.value).sort()).toEqual(["0.12", "0.16"]);
    const val = (await reports.stockValuation(db)).items.find((i) => i.variantId === fluid)!;
    expect(val.avgCost).toBe("0.125000");
    // The variant search still serves value ÷ qty (the count form's cost prefill), shown by the same rule.
    const [v] = await db.transaction((tx) => catalog.searchVariants(tx, { search: "Liquide U26" }));
    expect(v.avgCost).toBe("0.124444");
    expect(variantUnitCost(v).replace(/\s/g, " ")).toBe("0,125 $");
    expect(shownUnitCost("0.28", "2.25").toString()).toBe("0.125");
    // The transfer list says the unit with the quantity.
    const transfers = (await api("GET", "/api/stock/transfers")).body as { qty: string; unit: string; productName: string }[];
    expect(transfers.find((t) => t.productName === "Liquide U26")).toMatchObject({ unit: "litre" });
  });
});
