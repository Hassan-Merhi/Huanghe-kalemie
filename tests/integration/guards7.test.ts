import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties, users, variants } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A12: what the seventh accounting audit found after A11. */
describe.skipIf(!hasDb)("Guards found by the seventh audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const reports = await import("../../server/services/reports");
  const vouchers = await import("../../server/services/vouchers");
  const managerId = 999;
  const staff = { owner: false };
  let db: Db;
  let ownerId: number, cashUsd: number, cashCdf: number, locationId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
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
            { accountId: cashCdf, debit: "2000", nativeAmount: "5600000", rate: "2800" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "22000" },
          ],
        },
        ownerId,
      ),
    );
  });

  const product = async (name: string, sellPrice: string, unit = "pcs") => (await db.transaction((tx) => catalog.createProduct(tx, { name, unit, variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;

  it("applies a dollar deposit to a container billed in francs", async () => {
    const [{ id: s }] = await db.insert(parties).values({ type: "supplier", name: "Kalemie Fournitures" }).returning();
    const v = await product("Chaîne", "20");
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-02", partyId: s, accountId: cashUsd, amount: "500" }, ownerId));
    const [c] = await db.insert(containers).values({ number: "F-1", supplierId: s, locationId, currency: "CDF", rateToUsd: "0.000357142857", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: v, quantity: "100", unitPrice: "28000" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-03", ownerId));
    // 2,800,000 FC billed; $500 at 2,800 covers 1,400,000 FC of it.
    const st = await reports.partyStatement(db, s);
    expect(st.foreign.find((x) => x.currency === "CDF")!.native).toBe("-1400000.00");
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("takes a dollar salary advance off salaries owed in francs", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Amani", monthlySalary: "560000" }).returning();
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-10", partyId: e, accountId: cashUsd, amount: "100" }, ownerId));
    const accountId = (await db.transaction((tx) => payroll.salaryAccountId(tx)))!;
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", accountId, currency: "CDF", lines: [{ partyId: e, salary: "560000" }] }, ownerId));
    const st = await reports.partyStatement(db, e);
    expect(st.foreign.find((x) => x.currency === "CDF")!.native).toBe("-280000.00");
  });

  it("keeps the owner's name on a rate a manager saves unchanged", async () => {
    const today = ledger.shopToday();
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2810", cnyPerUsd: "7.05" }, ownerId));
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2810", cnyPerUsd: "7.05" }, managerId, staff));
    const [row] = await db.select().from(exchangeRates).where(eq(exchangeRates.date, today));
    expect(row.createdBy).toBe(ownerId);
    await expect(
      db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2810", cnyPerUsd: "9" }, managerId, staff)),
    ).rejects.toThrow(/away from the last yuan rate \(7\.05\)/);
  });

  it("refuses a franc voucher line worth less than a cent", async () => {
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "receipt", { date: "2026-08-11", accountId: cashCdf, lines: [{ accountId: cashUsd, amount: "10" }] }, ownerId, { owner: true })),
    ).rejects.toThrow(/less than one cent/);
  });

  it("refuses switching to a whole-piece unit while part of a unit is in stock", async () => {
    const v = await product("Graisse", "5", "kg");
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-12", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: v, qtyChange: "2.5", unitCost: "2" }] }, ownerId, { owner: true }));
    const [{ productId }] = await db.select().from(variants).where(eq(variants.id, v));
    await expect(db.transaction((tx) => catalog.updateProduct(tx, productId, { unit: "pcs" }))).rejects.toThrow(/whole pieces/);
  });
});
