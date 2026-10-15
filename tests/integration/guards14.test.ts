import { beforeAll, describe, expect, it } from "vitest";
import { accounts, exchangeRates, journalLines, locations, parties, users } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A19: what the fourteenth accounting audit found after A18 and U13. */
describe.skipIf(!hasDb)("Guards found by the fourteenth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const periods = await import("../../server/services/periods");
  const reports = await import("../../server/services/reports");
  const salesSvc = await import("../../server/services/sales");
  let db: Db;
  let ownerId: number, cashUsd: number, cashCdf: number, liab: number, payables: number, locationId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    liab = accs.find((a) => a.systemKey === "payroll_withheld")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values([
      { date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7" },
      { date: "2026-08-31", cdfPerUsd: "2786", cnyPerUsd: "7" },
    ]);
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

  const usdOn = async (accountId: number, partyId?: number) => {
    const [r] = await db
      .select({ v: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, accountId), partyId ? eq(journalLines.partyId, partyId) : sql`true`));
    return Number(r.v);
  };

  it("leaves nothing behind when a franc run is cancelled after its month was revalued", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Neema", monthlySalary: "560000" }).returning();
    const accountId = (await db.transaction((tx) => payroll.salaryAccountId(tx)))!;
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", date: "2026-08-10", accountId, currency: "CDF", lines: [{ partyId: e, salary: "560000", withheld: "280000" }] }, ownerId));
    await db.transaction((tx) => periods.closePeriod(tx, "2026-08", ownerId));
    expect(await usdOn(liab)).not.toBe(-100);
    await db.transaction((tx) => payroll.cancelRun(tx, "2026-08", "2026-09-02", ownerId));
    expect(await usdOn(liab)).toBe(0);
    expect(await usdOn(payables, e)).toBe(0);
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("refuses bad ids cleanly instead of failing", async () => {
    const v = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Pneu", unit: "pcs", variants: [{ attributes: {}, sellPrice: "30" }] })));
    await expect(db.transaction((tx) => catalog.updateProduct(tx, v.id, { categoryId: 99999 }))).rejects.toThrow(/Category not found/);
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-09-03", locationId: 99999, kind: "found", reason: "Trouvé", lines: [{ variantId: v.variants[0].id, qtyChange: "1", unitCost: "10" }] }, ownerId, { owner: true })),
    ).rejects.toThrow(/location does not exist/);
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-09-03", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: v.variants[0].id, qtyChange: "2", unitCost: "10" }] }, ownerId, { owner: true }));
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-09-04", locationId, lines: [{ variantId: v.variants[0].id, qty: "1", unitPrice: "30" }], payments: [{ accountId: cashUsd, amount: "30" }] }, ownerId));
    await expect(
      db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-09-05", reason: "Retour", refundAccountId: 99999, lines: [{ saleLineId: sale.lines[0].id, qty: "1" }] }, ownerId)),
    ).rejects.toThrow(/refund leaves/);
  });
});
