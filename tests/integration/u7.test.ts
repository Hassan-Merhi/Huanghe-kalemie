import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { eq, sql } from "drizzle-orm";
import { accounts, containers, exchangeRates, locations, parties, users } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** U7: whole quantities for counted units, whole francs, and the owner's name. */
describe.skipIf(!hasDb)("Whole units and whole francs", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const sales = await import("../../server/services/sales");
  const stock = await import("../../server/services/stock");
  const payroll = await import("../../server/services/payroll");
  const userId = 1;
  let db: Db;
  let cashUsd: number, cashCdf: number, locationId: number, pads: number, oil: number, supplierId: number, rent: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    rent = accs.find((a) => a.code === "6000")!.id;
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
    pads = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Plaquettes", unit: "pcs", variants: [{ attributes: {}, sellPrice: "4" }] }))).variants[0].id;
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile en vrac", unit: "litre", variants: [{ attributes: {}, sellPrice: "5" }] }))).variants[0].id;
    await db.transaction((tx) =>
      ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: pads, qtyChange: "50", unitCost: "1" }, { variantId: oil, qtyChange: "40", unitCost: "2" }] }, userId),
    );
  });

  it("sells, adjusts, transfers and buys pieces only in whole numbers", async () => {
    await expect(
      db.transaction((tx) => sales.createSale(tx, { date: "2026-08-02", locationId, lines: [{ variantId: pads, qty: "1.5", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "6" }] }, userId)),
    ).rejects.toThrow(/whole units/);
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "damage", reason: "Cassé", lines: [{ variantId: pads, qtyChange: "-0.5" }] }, userId)),
    ).rejects.toThrow(/whole units/);
    const [depot] = await db.insert(locations).values({ name: "Dépôt" }).returning();
    await expect(
      db.transaction((tx) => stock.transferStock(tx, { date: "2026-08-02", type: "transfer_out", variantId: pads, fromLocationId: locationId, toLocationId: depot.id, qty: "2.5", userId })),
    ).rejects.toThrow(/whole units/);
    const [c] = await db.insert(containers).values({ number: "U7-1", supplierId, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await expect(db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: pads, quantity: "10.25", unitPrice: "1" }]))).rejects.toThrow(/whole units/);
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: pads, quantity: "10", unitPrice: "1" }, { variantId: oil, quantity: "10.5", unitPrice: "2" }]));
  });

  it("sells litres by the half", async () => {
    const sale = await db.transaction((tx) =>
      sales.createSale(tx, { date: "2026-08-02", locationId, lines: [{ variantId: oil, qty: "1.5", unitPrice: "5" }], payments: [{ accountId: cashUsd, amount: "7.50" }] }, userId),
    );
    expect(sale.total).toBe("7.50");
  });

  it("refuses franc amounts with centimes", async () => {
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-02", accountId: rent, amount: "28000.50", paidFromAccountId: cashCdf, description: "Loyer" }, userId)),
    ).rejects.toThrow(/whole numbers/);
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-02", accountId: rent, amount: "100.5", currency: "CDF", payablePartyId: supplierId, description: "Loyer" }, userId)),
    ).rejects.toThrow(/whole numbers/);
    await expect(
      db.transaction((tx) => ops.transferMoney(tx, { date: "2026-08-02", fromAccountId: cashUsd, fromAmount: "10", toAccountId: cashCdf, toAmount: "28000.5" }, userId)),
    ).rejects.toThrow(/whole numbers/);
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-02", accountId: rent, amount: "28000", paidFromAccountId: cashCdf, description: "Loyer" }, userId));
  });

  it("refuses a franc payroll with centimes", async () => {
    const [emp] = await db.insert(parties).values({ type: "employee", name: "Kabila" }).returning();
    const salaries = (await db.select().from(accounts).where(eq(accounts.code, "6010")))[0].id;
    await expect(
      db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", accountId: salaries, currency: "CDF", rate: "2800", lines: [{ partyId: emp.id, salary: "150000.5" }] }, userId)),
    ).rejects.toThrow(/whole numbers/);
  });

  it("renames an owner still called by the old default name", async () => {
    await db.update(users).set({ fullName: "Owner" }).where(eq(users.role, "owner"));
    const migration = fs.readFileSync(path.resolve("migrations/0010_u7_owner_name.sql"), "utf8");
    await db.execute(sql.raw(migration));
    const [owner] = await db.select().from(users).where(eq(users.role, "owner"));
    expect(owner.fullName).toBe("Propriétaire");
  });
});
