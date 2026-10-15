import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties, users, variants } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A11: what the sixth accounting audit found after A10. */
describe.skipIf(!hasDb)("Guards found by the sixth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const vouchers = await import("../../server/services/vouchers");
  const managerId = 999;
  const staff = { owner: false };
  let db: Db;
  let ownerId: number, cashUsd: number, cashCdf: number, locationId: number, supplierId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Kin Parts" }).returning();
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
            { accountId: cashCdf, debit: "2000", nativeAmount: "5600000", rate: "2800" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "22000" },
          ],
        },
        ownerId,
      ),
    );
  });

  async function offload(number: string, sup: number, currency: string, rate: string, lines: { variantId: number; quantity: string; unitPrice: string }[], date: string) {
    const [c] = await db.insert(containers).values({ number, supplierId: sup, locationId, currency, rateToUsd: rate, status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, lines));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, date, ownerId));
    return c.id;
  }
  const product = async (name: string, sellPrice: string) => (await db.transaction((tx) => catalog.createProduct(tx, { name, variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;

  it("never lets staff value found stock above its selling price", async () => {
    const y = await product("Bouchon", "3");
    // A big cost pinned on one unit.
    await offload("C-1", supplierId, "USD", "1", [{ variantId: y, quantity: "1", unitPrice: "2000" }], "2026-08-02");
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-03", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: y, qtyChange: "100" }] }, ownerId, staff)),
    ).rejects.toThrow(/above its selling price/);
  });

  it("leaves reversed containers out of an item's purchase cost, and does not average a fraction of a unit", async () => {
    const w = await product("Phare", "30");
    const typo = await offload("C-2", supplierId, "USD", "1", [{ variantId: w, quantity: "100", unitPrice: "1420" }], "2026-08-02");
    await db.transaction((tx) => containersSvc.reverseContainer(tx, typo, "2026-08-02", ownerId));
    await offload("C-3", supplierId, "USD", "1", [{ variantId: w, quantity: "100", unitPrice: "14.20" }], "2026-08-02");
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-03", locationId, kind: "loss", reason: "Perdu", lines: [{ variantId: w, qtyChange: "-99.997" }] }, ownerId, staff));
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-03", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: w, qtyChange: "5" }] }, ownerId, staff));
    const [v] = await db.select().from(variants).where(eq(variants.id, w));
    expect(Number(v.stockValue)).toBeLessThan(5 * 14.2 + 1);
  });

  it("applies a deposit paid in francs to a yuan invoice", async () => {
    const [{ id: s }] = await db.insert(parties).values({ type: "supplier", name: "SupFC" }).returning();
    const oil = await product("Huile", "10");
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-04", partyId: s, accountId: cashCdf, amount: "1400000" }, ownerId));
    await offload("Y-1", s, "CNY", "0.142857", [{ variantId: oil, quantity: "710", unitPrice: "10" }], "2026-08-05");
    // 1,400,000 FC is $500 at 2,800: 3,500 of the 7,100 CNY.
    const st = await reports.partyStatement(db, s);
    expect(st.foreign.find((x) => x.currency === "CNY")!.native).toBe("-3600.00");
    expect(st.foreign.find((x) => x.currency === "CDF")?.native ?? "0.00").toBe("0.00");
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("lets staff pay a customer only what the customer has paid ahead", async () => {
    const [{ id: c }] = await db.insert(parties).values({ type: "customer", name: "Client fantôme" }).returning();
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-06", accountId: cashUsd, lines: [{ partyId: c, amount: "300" }] }, managerId, staff)),
    ).rejects.toThrow(/to get back/);
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-08-06", partyId: c, accountId: cashUsd, amount: "100" }, ownerId));
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-06", accountId: cashUsd, lines: [{ partyId: c, amount: "100" }] }, managerId, staff));
  });

  it("lets a manager correct a rate the owner just set", async () => {
    const today = ledger.shopToday();
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "3090", cnyPerUsd: "7.1" }, ownerId));
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "3085", cnyPerUsd: "7.12" }, managerId, staff));
  });
});
