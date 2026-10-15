import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties, variants } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A10: what the fifth accounting audit found after A9. */
describe.skipIf(!hasDb)("Guards found by the fifth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const vouchers = await import("../../server/services/vouchers");
  const userId = 1;
  const managerId = 2;
  const staff = { owner: false };
  let db: Db;
  let cashUsd: number, locationId: number, oil: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values([{ date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7" }]);
    await db.transaction((tx) =>
      ops.manualJournal(
        tx,
        {
          date: "2026-08-01",
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "20000" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "20000" },
          ],
        },
        userId,
      ),
    );
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", variants: [{ attributes: {}, sellPrice: "10" }] }))).variants[0].id;
  });

  async function offload(number: string, supplierId: number, currency: string, rate: string, lines: { variantId: number; quantity: string; unitPrice: string }[], date: string) {
    const [c] = await db.insert(containers).values({ number, supplierId, locationId, currency, rateToUsd: rate, status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, lines));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, date, userId));
    return c.id;
  }

  it("brings found stock back at its average cost, and a tiny purchase cannot set the cost of an item with none", async () => {
    const [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Kin Parts" }).returning();
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: oil, qtyChange: "100", unitCost: "10" }] }, userId));
    await offload("C-1", supplierId, "USD", "1", [{ variantId: oil, quantity: "100", unitPrice: "7" }], "2026-08-02");
    // Average 8.50, last purchase 7: a count with no cost goes in at the average.
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-03", locationId, kind: "count", reason: "Comptage", lines: [{ variantId: oil, qtyChange: "3" }] }, userId, staff));
    const [v] = await db.select().from(variants).where(eq(variants.id, oil));
    expect(Number(v.stockValue) / Number(v.stockQty)).toBeCloseTo(8.5, 2);

    const filter = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Filtre", variants: [{ attributes: {}, sellPrice: "4" }] }))).variants[0].id;
    await offload("C-2", supplierId, "USD", "1", [{ variantId: filter, quantity: "50", unitPrice: "2" }, { variantId: filter, quantity: "0.001", unitPrice: "5000" }], "2026-08-03");
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-04", locationId, kind: "loss", reason: "Perdu", lines: [{ variantId: filter, qtyChange: "-50.001" }] }, userId, staff));
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-04", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: filter, qtyChange: "10", unitCost: "5000" }] }, userId, staff)),
    ).rejects.toThrow(/far from its cost/);
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-04", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: filter, qtyChange: "10" }] }, userId, staff));
    const [f] = await db.select().from(variants).where(eq(variants.id, filter));
    expect(Number(f.stockValue)).toBeLessThan(25);
  });

  it("applies a dollar deposit to a yuan invoice when it is offloaded, and before a payment in yuan", async () => {
    const [{ id: s1 }] = await db.insert(parties).values({ type: "supplier", name: "Prepaid" }).returning();
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-05", partyId: s1, accountId: cashUsd, amount: "1000" }, userId));
    await offload("Y-1", s1, "CNY", "0.142857", [{ variantId: oil, quantity: "710", unitPrice: "10" }], "2026-08-06");
    // $1,000 at 7 CNY per dollar covers 7,000 of the 7,100 CNY.
    let st = await reports.partyStatement(db, s1);
    expect(st.foreign.find((x) => x.currency === "CNY")!.native).toBe("-100.00");
    await expect(
      db.transaction((tx) => ops.payParty(tx, { date: "2026-08-07", partyId: s1, accountId: cashUsd, amount: "1000", settleNative: "7100" }, userId)),
    ).rejects.toThrow(/owed only 100.00 CNY/);

    const [{ id: s2 }] = await db.insert(parties).values({ type: "supplier", name: "Half" }).returning();
    await offload("Y-2", s2, "CNY", "0.142857", [{ variantId: oil, quantity: "710", unitPrice: "10" }], "2026-08-06");
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-07", partyId: s2, accountId: cashUsd, amount: "500" }, userId));
    // A later deposit is used before a payment in yuan: $500 at 7 settled 3,500, so 3,600 CNY are left.
    await expect(
      db.transaction((tx) => ops.payParty(tx, { date: "2026-08-08", partyId: s2, accountId: cashUsd, amount: "1014.29", settleNative: "7100" }, userId)),
    ).rejects.toThrow(/owed only/);
    st = await reports.partyStatement(db, s2);
    expect(st.foreign.find((x) => x.currency === "CNY")!.native).toBe("-3600.00");
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("keeps a pending voucher in its author's hands", async () => {
    const draft = await db.transaction((tx) => vouchers.saveDraft(tx, { kind: "adjustment", date: "2026-08-08", payload: { kind: "opening" } }, userId));
    await expect(
      db.transaction((tx) => vouchers.saveDraft(tx, { id: draft.id, kind: "adjustment", date: "2026-08-08", payload: { kind: "opening", lines: [] } }, managerId, staff)),
    ).rejects.toThrow(/Only the person/);
    await expect(db.transaction((tx) => vouchers.deleteDraft(tx, draft.id, managerId, staff))).rejects.toThrow(/Only the person/);
  });

  it("measures tomorrow's rate from before today too, and lets staff keep a rate as it is", async () => {
    const today = ledger.shopToday();
    const tomorrow = new Date(Date.parse(today) + 86400_000).toISOString().slice(0, 10);
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2940", cnyPerUsd: "7" }, managerId, staff));
    await expect(db.transaction((tx) => ledger.setExchangeRate(tx, { date: tomorrow, cdfPerUsd: "3080" }, managerId, staff))).rejects.toThrow(/Only the owner/);
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "3200" }, userId));
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "3200", cnyPerUsd: "7" }, managerId, staff));
  });
});
