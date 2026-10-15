import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A15: what the tenth accounting audit found after A14. */
describe.skipIf(!hasDb)("Guards found by the tenth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
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

  const product = async (name: string, sellPrice: string) => (await db.transaction((tx) => catalog.createProduct(tx, { name, unit: "pcs", variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;

  it("refunds a customer's francs up to the francs, whichever way the rate moved", async () => {
    const [{ id: c }] = await db.insert(parties).values({ type: "customer", name: "Client FC" }).returning();
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-08-02", partyId: c, accountId: cashCdf, amount: "280000" }, ownerId));
    // Franc stronger: 280,000 FC is worth more than the 100 $ booked, and may still all go back.
    await db.insert(exchangeRates).values([{ date: "2026-08-03", cdfPerUsd: "2750" }]);
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-03", accountId: cashCdf, lines: [{ partyId: c, amount: "140000" }] }, managerId, staff));
    // Franc weaker: in dollars only what the francs left are worth today (140,000 FC at 2,900 = 48.28 $).
    await db.insert(exchangeRates).values([{ date: "2026-08-04", cdfPerUsd: "2900" }]);
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-04", accountId: cashUsd, lines: [{ partyId: c, amount: "50" }] }, managerId, staff)),
    ).rejects.toThrow(/48\.28/);
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-04", accountId: cashUsd, lines: [{ partyId: c, amount: "48.28" }] }, managerId, staff));
  });

  it("applies an advance only to the bill's own currency, so voiding it gives back just that", async () => {
    const [{ id: s }] = await db.insert(parties).values({ type: "supplier", name: "Mixte" }).returning();
    const v = await product("Phare", "30");
    const [y] = await db.insert(containers).values({ number: "Y-1", supplierId: s, locationId, currency: "CNY", rateToUsd: "0.142857", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, y.id, [{ variantId: v, quantity: "10", unitPrice: "700" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, y.id, "2026-08-05", ownerId));
    // Francs owed too, then 300 $: the francs are paid first and 200 $ stays ahead while the yuan is still owed.
    const [f] = await db.insert(containers).values({ number: "F-1", supplierId: s, locationId, currency: "CDF", rateToUsd: "0.000357142857", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, f.id, [{ variantId: v, quantity: "10", unitPrice: "28000" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, f.id, "2026-08-05", ownerId));
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-05", partyId: s, accountId: cashUsd, amount: "300" }, ownerId));
    const fuel = (await db.select().from(accounts).where(eq(accounts.type, "expense")))[0].id;
    const exp = await db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-06", accountId: fuel, description: "Transport", amount: "28000", currency: "CDF", payablePartyId: s }, ownerId));
    await db.transaction((tx) => ops.voidExpense(tx, exp.id, "2026-08-07", ownerId));
    const before = await reports.partyStatement(db, s);
    expect(before.foreign.find((x) => x.currency === "CDF")?.native ?? "0.00").toBe("0.00");
    expect(before.foreign.find((x) => x.currency === "CNY")!.native).toBe("-7000.00");
  });

  it("refuses a variant edit that changes nothing", async () => {
    const v = await product("Bougie", "2");
    await expect(db.transaction((tx) => catalog.updateVariant(tx, v, { sellPrice: null } as never))).rejects.toThrow(/Nothing to change/);
  });

  it("hides the other partner's memos on a reversal", () => {
    const m = reports.maskPartnerJournal(
      { type: "reversal", memo: "Contre-passation" },
      [{ accountId: 1, debit: "10.00", credit: "0.00", accountName: "Caisse", memo: "SECRET" }, { accountId: 2, debit: "0.00", credit: "10.00", accountName: "Associé B", memo: null }],
      new Set([2]),
    );
    expect(JSON.stringify(m)).not.toContain("SECRET");
  });
});
