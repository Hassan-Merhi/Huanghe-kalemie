import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { locations, motorcycleUnits, stockLevels } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

describe.skipIf(!hasDb)("Transfers", async () => {
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const { transferStock } = await import("../../server/services/stock");
  const userId = 1;
  let db: Db;
  let shop: number, depot: number, bike: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: shop }] = await db.select().from(locations).limit(1);
    [{ id: depot }] = await db.insert(locations).values({ name: "Depot" }).returning();
    const p = await db.transaction((tx) => catalog.createProduct(tx, { name: "HH150", unit: "unit", tracksSerials: true, variants: [{ attributes: { Colour: "Red" }, sellPrice: "1450" }] }));
    bike = p.variants[0].id;
    await db.transaction((tx) =>
      ops.adjustStock(
        tx,
        {
          date: "2026-08-01",
          locationId: shop,
          kind: "opening",
          reason: "Opening",
          lines: [{ variantId: bike, qtyChange: "2", unitCost: "1100", serials: [{ chassisNo: "CH1", engineNo: null, color: null }, { chassisNo: "CH2", engineNo: null, color: null }] }],
        },
        userId,
      ),
    );
  });

  it("moves a motorcycle together with its chassis record", async () => {
    const units = await db.select().from(motorcycleUnits);
    const ch1 = units.find((u) => u.chassisNo === "CH1")!;
    await expect(db.transaction((tx) => transferStock(tx, { date: "2026-08-02", type: "transfer_out", variantId: bike, fromLocationId: shop, toLocationId: depot, qty: "1", userId }))).rejects.toThrow();
    await db.transaction((tx) => transferStock(tx, { date: "2026-08-02", type: "transfer_out", variantId: bike, fromLocationId: shop, toLocationId: depot, qty: "1", unitIds: [ch1.id], userId }));
    const [moved] = await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.id, ch1.id));
    expect(moved.locationId).toBe(depot);
    const levels = await db.select().from(stockLevels).where(eq(stockLevels.variantId, bike));
    expect(levels.find((l) => l.locationId === depot)?.qty).toBe("1.000");
    expect(levels.find((l) => l.locationId === shop)?.qty).toBe("1.000");
  });
});
