import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, containers, exchangeRates, locations, parties, salePayments } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A8: what the third accounting audit found after A7. */
describe.skipIf(!hasDb)("Guards against the remaining bypasses", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const sales = await import("../../server/services/sales");
  const vouchers = await import("../../server/services/vouchers");
  const userId = 1;
  const staff = { owner: false };
  let db: Db;
  let cashUsd: number, cashCdf: number, locationId: number, oil: number, supplierId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Yuan Parts" }).returning();
    await db.insert(exchangeRates).values([{ date: "2026-08-01", cdfPerUsd: "2800" }]);
    await db.transaction((tx) =>
      ops.manualJournal(
        tx,
        {
          date: "2026-08-01",
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "5000" },
            { accountId: cashCdf, debit: "1000", nativeAmount: "2800000", rate: "2800" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "6000" },
          ],
        },
        userId,
      ),
    );
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", variants: [{ attributes: {}, sellPrice: "10" }] }))).variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: oil, qtyChange: "100", unitCost: "2" }] }, userId));
  });

  it("measures a manager's rate change from the day before, so overwriting a day cannot walk it", async () => {
    const today = ledger.shopToday();
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2900" }, userId, staff));
    await expect(db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "3000" }, userId, staff))).rejects.toThrow(/Only the owner/);
    await expect(db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2800", cnyPerUsd: "70" }, userId, staff))).rejects.toThrow(/first yuan rate/);
    // Back days are the owner's: rewriting them one by one would walk today's rate anywhere.
    await expect(db.transaction((tx) => ledger.setExchangeRate(tx, { date: "2026-08-02", cdfPerUsd: "2800" }, userId, staff))).rejects.toThrow(/past day/);
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2800" }, userId));
  });

  it("values every franc of a staff sale at the day's rate", async () => {
    const sale = await db.transaction((tx) =>
      sales.createSale(
        tx,
        {
          date: "2026-08-03",
          locationId,
          lines: [{ variantId: oil, qty: "1", unitPrice: "10" }],
          payments: [{ accountId: cashCdf, amount: "30000", rate: "2880" }],
          change: { accountId: cashCdf, amount: "2000", rate: "2720" },
        },
        userId,
        { role: "cashier" },
      ),
    );
    const rows = await db.select().from(salePayments).where(eq(salePayments.saleId, sale.id));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.rate === "2800.0000")).toBe(true);
  });

  it("refuses a container in a currency the books do not keep", async () => {
    await expect(containersSvc.assertContainerRate(db, "EUR", "1.1", "2026-08-03")).rejects.toThrow(/USD, CDF or CNY/);
  });

  it("settles yuan at the yuan rate on file, in payments and in vouchers", async () => {
    const [c] = await db.insert(containers).values({ number: "Y-1", supplierId, locationId, currency: "CNY", rateToUsd: "0.14", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "100", unitPrice: "10" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-04", userId));
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: "2026-08-05", cdfPerUsd: "2800", cnyPerUsd: "7" }, userId));
    // $70 at 7 CNY per dollar buys 490 of the 1,000 CNY owed.
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-05", partyId: supplierId, accountId: cashUsd, amount: "70" }, userId));
    let st = await reports.partyStatement(db, supplierId);
    expect(st.foreign.find((f) => f.currency === "CNY")!.native).toBe("-510.00");
    // Two voucher lines for the same supplier settle as one: $35 buys 245 CNY.
    await db.transaction((tx) =>
      vouchers.postVoucher(tx, "payment", { date: "2026-08-05", accountId: cashUsd, lines: [{ partyId: supplierId, amount: "17.50" }, { partyId: supplierId, amount: "17.50" }] }, userId, staff),
    );
    st = await reports.partyStatement(db, supplierId);
    expect(st.foreign.find((f) => f.currency === "CNY")!.native).toBe("-265.00");
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("does not let an earlier day's sale take stock that arrived later", async () => {
    const filter = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Filtre", variants: [{ attributes: {}, sellPrice: "4" }] }))).variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-10", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: filter, qtyChange: "5", unitCost: "1" }] }, userId));
    await expect(
      db.transaction((tx) => sales.createSale(tx, { date: "2026-08-06", locationId, lines: [{ variantId: filter, qty: "1", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "4" }] }, userId)),
    ).rejects.toThrow(/Not enough stock/);
    await db.transaction((tx) => sales.createSale(tx, { date: "2026-08-10", locationId, lines: [{ variantId: filter, qty: "1", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "4" }] }, userId));
  });

  it("refuses new stock activity at a switched-off location", async () => {
    const [closed] = await db.insert(locations).values({ name: "Ancien dépôt", active: false }).returning();
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-10", locationId: closed.id, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "1" }] }, userId)),
    ).rejects.toThrow(/switched off/);
  });
});
