import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, containers, locations, motorcycleUnits, parties, variants } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

describe.skipIf(!hasDb)("Container reversal and party balances", async () => {
  const catalog = await import("../../server/services/catalog");
  const svc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const userId = 1;
  let db: Db;
  let supplierId: number, locationId: number, bike: number, cashUsd: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Huanghe" }).returning();
    cashUsd = (await db.select().from(accounts)).find((a) => a.systemKey === "cash_usd")!.id;
    const opening = (await db.select().from(accounts)).find((a) => a.systemKey === "opening_equity")!.id;
    await db.transaction((tx) => ops.manualJournal(tx, { date: "2026-08-01", memo: "Caisse d'ouverture", type: "opening", lines: [{ accountId: cashUsd, debit: "1000" }, { accountId: opening, credit: "1000" }] }, userId));
    const p = await db.transaction((tx) => catalog.createProduct(tx, { name: "HH150", unit: "unit", tracksSerials: true, variants: [{ attributes: { Couleur: "Noir" }, sellPrice: "1450" }] }));
    bike = p.variants[0].id;
    // Two bikes already in the shop at $900 each.
    await db.transaction((tx) =>
      ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Opening", lines: [{ variantId: bike, qtyChange: "2", unitCost: "900", serials: [{ chassisNo: "OLD1", engineNo: null, color: null }, { chassisNo: "OLD2", engineNo: null, color: null }] }] }, userId),
    );
  });

  it("undoes an offload at its own landed value and keeps chassis numbers", async () => {
    const [c] = await db.insert(containers).values({ number: "R-1", supplierId, locationId, status: "arrived" }).returning();
    await db.transaction((tx) => svc.replaceLines(tx, c.id, [{ variantId: bike, quantity: "2", unitPrice: "800" }]));
    await db.transaction((tx) => svc.addExpense(tx, c.id, { date: "2026-08-02", type: "freight", amount: "345", currency: "USD", method: "value", paidFromAccountId: cashUsd }, userId));
    await db.transaction((tx) => svc.finalizeContainer(tx, c.id, "2026-08-03", userId));
    let [v] = await db.select().from(variants).where(eq(variants.id, bike));
    expect(v.stockValue).toBe("3745.00");

    const fresh = (await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.containerId, c.id)));
    expect(fresh.every((u) => u.color === "Noir")).toBe(true);
    await db.transaction((tx) => catalog.updateUnit(tx, fresh[0].id, { chassisNo: "NEW1" }));

    await db.transaction((tx) => svc.reverseContainer(tx, c.id, "2026-08-04", userId));
    [v] = await db.select().from(variants).where(eq(variants.id, bike));
    expect(v.stockQty).toBe("2.000");
    expect(v.stockValue).toBe("1800.00");
    const tb = await reports.trialBalance(db);
    expect(tb.rows.find((r) => r.systemKey === "stock_adjustments")).toBeUndefined();
    expect((await db.transaction((tx) => catalog.listUnits(tx, {}))).map((u) => u.chassisNo).sort()).toEqual(["OLD1", "OLD2"]);

    await db.transaction((tx) => svc.finalizeContainer(tx, c.id, "2026-08-05", userId));
    [v] = await db.select().from(variants).where(eq(variants.id, bike));
    expect(v.stockValue).toBe("3745.00");
    const again = await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.containerId, c.id));
    expect(again).toHaveLength(2);
    expect(again.map((u) => u.chassisNo)).toContain("NEW1");
    expect((await reports.stockValuation(db)).reconciled).toBe(true);
  });

  it("lists each contact's balance", async () => {
    const list = await db.transaction((tx) => reports.partyBalances(tx, "supplier"));
    expect(list.find((p) => p.id === supplierId)!.balance).toBe("-1600.00");
    expect(list.find((p) => p.id === supplierId)!.balance).toBe((await reports.partyStatement(db, supplierId)).balance);
  });

  it("finds an item by a variant's code and counts its variants", async () => {
    const found = await db.transaction((tx) => catalog.listProducts(tx, { search: "HH150" }));
    expect(found[0].variantCount).toBe(1);
  });
});
