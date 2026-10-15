import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties, users, variants } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A13: what the eighth accounting audit found after A12. */
describe.skipIf(!hasDb)("Guards found by the eighth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const stock = await import("../../server/services/stock");
  const vouchers = await import("../../server/services/vouchers");
  const managerId = 999;
  const staff = { owner: false };
  let db: Db;
  let ownerId: number, cashUsd: number, cashCdf: number, locationId: number, depotId: number, fuel: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    fuel = accs.find((a) => a.type === "expense" && a.code !== "6010")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    [{ id: depotId }] = await db.insert(locations).values({ name: "Dépôt" }).returning();
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
  const cdfOwed = async (partyId: number) => (await reports.partyStatement(db, partyId)).foreign.find((x) => x.currency === "CDF")?.native ?? "0.00";

  it("applies a dollar advance to a franc bill left unpaid", async () => {
    const [{ id: agent }] = await db.insert(parties).values({ type: "agent", name: "Transitaire" }).returning();
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-02", partyId: agent, accountId: cashUsd, amount: "100" }, ownerId));
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-03", accountId: fuel, description: "Carburant", amount: "560000", currency: "CDF", payablePartyId: agent }, ownerId));
    expect(await cdfOwed(agent)).toBe("-280000.00");
  });

  it("applies a dollar advance to franc container costs owed to an agent", async () => {
    const [{ id: sup }] = await db.insert(parties).values({ type: "supplier", name: "Fournisseur" }).returning();
    const [{ id: agent }] = await db.insert(parties).values({ type: "agent", name: "Dédouaneur" }).returning();
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-02", partyId: agent, accountId: cashUsd, amount: "100" }, ownerId));
    const [c] = await db.insert(containers).values({ number: "A-1", supplierId: sup, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.addExpense(tx, c.id, { date: "2026-08-03", type: "customs", amount: "280000", currency: "CDF", method: "value", payablePartyId: agent }, ownerId));
    expect(await cdfOwed(agent)).toBe("0.00");
  });

  it("applies a deposit paid after the date of a back-dated offload", async () => {
    const [{ id: sup }] = await db.insert(parties).values({ type: "supplier", name: "Retard" }).returning();
    const v = await product("Phare", "30");
    const today = ledger.shopToday();
    await db.transaction((tx) => ops.payParty(tx, { date: today, partyId: sup, accountId: cashUsd, amount: "500" }, ownerId));
    const [c] = await db.insert(containers).values({ number: "F-9", supplierId: sup, locationId, currency: "CDF", rateToUsd: "0.000357142857", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: v, quantity: "100", unitPrice: "28000" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-05", ownerId));
    const owed = Number(await cdfOwed(sup));
    expect(owed).toBeGreaterThan(-2800000);
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("refuses a whole-piece unit when one location holds part of a unit", async () => {
    const v = await product("Fil", "5", "kg");
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-06", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: v, qtyChange: "3", unitCost: "2" }] }, ownerId, { owner: true }));
    await db.transaction((tx) => stock.transferStock(tx, { date: "2026-08-06", type: "transfer_out", variantId: v, fromLocationId: locationId, toLocationId: depotId, qty: "1.5", userId: ownerId }));
    const [{ productId }] = await db.select().from(variants).where(eq(variants.id, v));
    await expect(db.transaction((tx) => catalog.updateProduct(tx, productId, { unit: "pcs" }))).rejects.toThrow(/whole pieces/);
  });

  it("lets staff settle francs owed on a liability in dollars at the day's rate", async () => {
    const [{ id: liab }] = await db.select().from(accounts).where(and(eq(accounts.systemKey, "payroll_withheld")));
    await db.transaction((tx) =>
      ops.manualJournal(tx, { date: "2026-08-07", memo: "Retenue", type: "manual", lines: [{ accountId: fuel, debit: "14.04" }, { accountId: liab, credit: "14.04", ...({ currency: "CDF" } as object), nativeAmount: "40000", rate: "2850" }] }, ownerId),
    );
    // 40,000 FC at 2,800 is 14.29 $.
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-08", accountId: cashUsd, lines: [{ accountId: liab, amount: "14.29" }] }, managerId, staff));
  });

  it("hides another partner's hand-typed memo", () => {
    const m = reports.maskPartnerJournal(
      { type: "manual", memo: "SECRET" },
      [{ accountId: 1, debit: "10.00", credit: "0.00", accountName: "Caisse", memo: null }, { accountId: 2, debit: "0.00", credit: "10.00", accountName: "Associé B", memo: null }],
      new Set([2]),
    );
    expect(m.journal.memo).not.toContain("SECRET");
  });
});
