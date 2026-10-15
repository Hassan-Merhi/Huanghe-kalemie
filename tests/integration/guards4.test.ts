import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A9: what the fourth accounting audit found after A8. */
describe.skipIf(!hasDb)("Guards found by the fourth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const userId = 1;
  const staff = { owner: false };
  let db: Db;
  let cashUsd: number, locationId: number, oil: number, supplierId: number, customerId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Yuan Parts" }).returning();
    [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Garage Mwamba" }).returning();
    await db.insert(exchangeRates).values([{ date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7" }]);
    await db.transaction((tx) =>
      ops.manualJournal(
        tx,
        {
          date: "2026-08-01",
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "5000" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "5000" },
          ],
        },
        userId,
      ),
    );
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", variants: [{ attributes: {}, sellPrice: "10" }] }))).variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: oil, qtyChange: "100", unitCost: "2" }] }, userId));
  });

  it("does not let counts raise an item's cost count after count", async () => {
    await expect(
      db.transaction((tx) =>
        ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "count", reason: "Comptage", lines: [{ variantId: oil, qtyChange: "-100" }, { variantId: oil, qtyChange: "100", unitCost: "2.2" }] }, userId, staff),
      ),
    ).rejects.toThrow(/twice/);
    // Out at average, back in at 10% above purchase cost: allowed once, and the next step is measured from the purchase again.
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "loss", reason: "Perdu", lines: [{ variantId: oil, qtyChange: "-50" }] }, userId, staff));
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "50", unitCost: "2.2" }] }, userId, staff));
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "1", unitCost: "2.42" }] }, userId, staff)),
    ).rejects.toThrow(/far from its cost/);
  });

  it("keeps container costs and suppliers on suppliers and agents", async () => {
    const [c] = await db.insert(containers).values({ number: "C-1", supplierId: customerId, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "10", unitPrice: "2" }]));
    await expect(
      db.transaction((tx) => containersSvc.addExpense(tx, c.id, { date: "2026-08-03", type: "freight", method: "value", amount: "50", currency: "USD", payablePartyId: customerId }, userId)),
    ).rejects.toThrow(/supplier or an agent/);
    await expect(db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-03", userId))).rejects.toThrow(/not a supplier/);
  });

  it("uses a dollar advance against yuan owed, and refuses a reversal dated before the offload", async () => {
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-04", partyId: supplierId, accountId: cashUsd, amount: "300" }, userId));
    const [c] = await db.insert(containers).values({ number: "Y-1", supplierId, locationId, currency: "CNY", rateToUsd: "0.142857", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "710", unitPrice: "10" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-05", userId));
    // 7,100 CNY owed (about $1,014), $300 already advanced: paying $714 clears it.
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-06", partyId: supplierId, accountId: cashUsd, amount: "714.29" }, userId));
    const st = await reports.partyStatement(db, supplierId);
    expect(st.foreign.find((f) => f.currency === "CNY")?.native ?? "0.00").toBe("0.00");
    expect(Math.abs(Number(st.balance))).toBeLessThan(0.05);
    await expect(db.transaction((tx) => containersSvc.reverseContainer(tx, c.id, "2026-08-04", userId))).rejects.toThrow(/before the offload/);
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });
});
