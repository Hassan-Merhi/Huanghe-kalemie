import { beforeAll, describe, expect, it } from "vitest";
import { accounts, exchangeRates, locations, parties, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A16: what the eleventh accounting audit found after A15 and U10. */
describe.skipIf(!hasDb)("Guards found by the eleventh audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const salesSvc = await import("../../server/services/sales");
  const vouchers = await import("../../server/services/vouchers");
  const managerId = 999;
  const staff = { owner: false };
  let db: Db;
  let ownerId: number, cashUsd: number, cashCdf: number, locationId: number, fuel: number, liab: number;
  let accs: (typeof accounts.$inferSelect)[];

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    fuel = accs.find((a) => a.type === "expense" && a.code !== "6010")!.id;
    liab = accs.find((a) => a.systemKey === "payroll_withheld")!.id;
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

  it("refuses paying out a customer's francs while they owe more in dollars", async () => {
    const v = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Pneu", unit: "pcs", variants: [{ attributes: {}, sellPrice: "300" }] }))).variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: v, qtyChange: "2", unitCost: "200" }] }, ownerId, { owner: true }));
    const [{ id: c }] = await db.insert(parties).values({ type: "customer", name: "Client mixte" }).returning();
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-08-02", partyId: c, accountId: cashCdf, amount: "280000" }, ownerId));
    await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-03", locationId, customerId: c, lines: [{ variantId: v, qty: "1", unitPrice: "300" }], payments: [] }, ownerId));
    // 100 $ paid ahead in francs against 300 $ owed in dollars: nothing to give back.
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-03", accountId: cashCdf, lines: [{ partyId: c, amount: "280000" }] }, managerId, staff)),
    ).rejects.toThrow(/0\.00/);
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-03", accountId: cashUsd, lines: [{ partyId: c, amount: "1" }] }, managerId, staff)),
    ).rejects.toThrow(/0\.00/);
  });

  it("caps franc withholdings at what is still owed once dollars were overpaid", async () => {
    // 50 $ paid out of 2100 that nothing owed, then 280,000 FC withheld (100 $): 50 $ net owed.
    await db.transaction((tx) => ops.manualJournal(tx, { date: "2026-08-04", memo: "Trop payé", type: "manual", lines: [{ accountId: liab, debit: "50" }, { accountId: cashUsd, credit: "50" }] }, ownerId));
    await db.transaction((tx) =>
      ops.manualJournal(tx, { date: "2026-08-04", memo: "Retenue", type: "manual", lines: [{ accountId: fuel, debit: "100" }, { accountId: liab, credit: "100", ...({ currency: "CDF" } as object), nativeAmount: "280000", rate: "2800" }] }, ownerId),
    );
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-04", accountId: cashCdf, lines: [{ accountId: liab, amount: "280000" }] }, managerId, staff)),
    ).rejects.toThrow(/50\.00/);
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-04", accountId: cashCdf, lines: [{ accountId: liab, amount: "140000" }] }, managerId, staff));
  });

  it("keeps another partner out of a contact's statement", async () => {
    const [b, a] = await db.select().from(accounts).where(eq(accounts.type, "equity")).then((rows) => {
      const ps = rows.filter((r) => r.partnerId);
      const other = ps.find((r) => r.partnerId !== ps[0].partnerId)!;
      return [ps[0], other];
    });
    const [{ id: sup }] = await db.insert(parties).values({ type: "supplier", name: "Fourn." }).returning();
    await db.transaction((tx) =>
      vouchers.postVoucher(tx, "payment", { date: "2026-08-05", accountId: cashUsd, lines: [{ accountId: b.id, amount: "3", memo: "SECRET perso" }, { partyId: sup, amount: "3" }] }, ownerId, { owner: true }),
    );
    const own = (await reports.partyStatement(db, sup)).rows.map((r) => r.memo).join();
    expect(own).not.toContain("SECRET");
    await db.transaction((tx) =>
      vouchers.postVoucher(tx, "payment", { date: "2026-08-05", accountId: cashUsd, memo: "SECRET typé", lines: [{ accountId: b.id, amount: "3" }, { partyId: sup, amount: "3" }] }, ownerId, { owner: true }),
    );
    const seen = (await reports.partyStatement(db, sup, await reports.otherPartnerAccountIds(db, a.partnerId))).rows.map((r) => r.memo).join();
    expect(seen).not.toContain("SECRET");
  });
});
