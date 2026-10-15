import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containerLines, containers, exchangeRates, locations, parties, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A18: what the thirteenth accounting audit found after A17 and U12. */
describe.skipIf(!hasDb)("Guards found by the thirteenth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const periods = await import("../../server/services/periods");
  const salesSvc = await import("../../server/services/sales");
  const vouchers = await import("../../server/services/vouchers");
  const managerId = 999;
  const staff = { owner: false };
  let db: Db;
  let ownerId: number, cashUsd: number, cashCdf: number, liab: number, salaryAccount: number, locationId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    liab = accs.find((a) => a.systemKey === "payroll_withheld")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values([
      { date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7" },
      { date: "2026-08-31", cdfPerUsd: "2810", cnyPerUsd: "7" },
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
    salaryAccount = (await db.transaction((tx) => payroll.salaryAccountId(tx)))!;
  });

  it("lets an unpaid franc run be cancelled after its month was closed and revalued", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Amani", monthlySalary: "560000" }).returning();
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", date: "2026-08-10", accountId: salaryAccount, currency: "CDF", lines: [{ partyId: e, salary: "560000", withheld: "280000" }] }, ownerId));
    await db.transaction((tx) => periods.closePeriod(tx, "2026-08", ownerId));
    await db.transaction((tx) => payroll.cancelRun(tx, "2026-08", "2026-09-02", ownerId));
  });

  it("never lets a cancel and a payment of its withholdings both pass", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Baraka", monthlySalary: "200" }).returning();
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-09", date: "2026-09-05", accountId: salaryAccount, currency: "USD", lines: [{ partyId: e, salary: "200", withheld: "20" }] }, ownerId));
    const results = await Promise.allSettled([
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-09-06", accountId: cashUsd, lines: [{ accountId: liab, amount: "20" }] }, managerId, staff)),
      db.transaction((tx) => payroll.cancelRun(tx, "2026-09", "2026-09-06", managerId)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses pinning a container cost to another container's line", async () => {
    const [{ id: sup }] = await db.insert(parties).values({ type: "supplier", name: "Fourn." }).returning();
    const v = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Phare", unit: "pcs", variants: [{ attributes: {}, sellPrice: "30" }] }))).variants[0].id;
    const [a] = await db.insert(containers).values({ number: "L-1", supplierId: sup, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    const [b] = await db.insert(containers).values({ number: "L-2", supplierId: sup, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, a.id, [{ variantId: v, quantity: "1", unitPrice: "10" }]));
    await db.transaction((tx) => containersSvc.replaceLines(tx, b.id, [{ variantId: v, quantity: "1", unitPrice: "10" }]));
    const [lineB] = await db.select().from(containerLines).where(eq(containerLines.containerId, b.id));
    const exp = await db.transaction((tx) => containersSvc.addExpense(tx, a.id, { date: "2026-09-08", type: "customs", amount: "5", currency: "USD", method: "value", paidFromAccountId: cashUsd }, ownerId));
    await expect(db.transaction((tx) => containersSvc.updateExpenseAllocation(tx, a.id, exp.id, "line", lineB.id))).rejects.toThrow(/not in this container/);
  });

  it("refuses a sale at a location that does not exist", async () => {
    await expect(db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-09-08", locationId: 99999, lines: [{ variantId: 1, qty: "1", unitPrice: "1" }], payments: [] }, ownerId))).rejects.toThrow(/location/);
  });
});
