import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, locations, motorcycleUnits, parties, partners } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * End-to-end business flow against a real Postgres database:
 * container with landed cost → sales (cash, CDF, credit) → return → rent → month close 75/25.
 */
describe.skipIf(!hasDb)("Kalemie shop flow", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const salesSvc = await import("../../server/services/sales");
  const ops = await import("../../server/services/operations");
  const periodsSvc = await import("../../server/services/periods");
  const reports = await import("../../server/services/reports");

  let db: Db;
  const userId = 1;
  const D = "2026-09-";
  let cashUsd: number, cashCdf: number, rent: number;
  let supplierId: number, agentId: number, customerId: number;
  let bikeVariant: number, frontPads: number, rearPads: number;
  let containerId: number;
  let firstSaleId: number;
  let partnerA: number, partnerB: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    rent = accs.find((a) => a.code === "6000")!.id;
    const ps = await db.select().from(partners).orderBy(partners.id);
    partnerA = ps[0].id;
    partnerB = ps[1].id;
    const [s] = await db.insert(parties).values({ type: "supplier", name: "Huanghe Factory" }).returning();
    const [a] = await db.insert(parties).values({ type: "agent", name: "Clearing Agent" }).returning();
    const [c] = await db.insert(parties).values({ type: "customer", name: "Mechanic Joseph" }).returning();
    supplierId = s.id;
    agentId = a.id;
    customerId = c.id;
  });

  it("creates products with variants", async () => {
    const bike = await db.transaction((tx) =>
      catalog.createProduct(tx, { name: "Huanghe HH150", tracksSerials: true, variants: [{ attributes: { color: "Red" }, sellPrice: "2500" }] }),
    );
    const pads = await db.transaction((tx) =>
      catalog.createProduct(tx, {
        name: "Brake pads",
        variants: [
          { attributes: { position: "Front" }, sellPrice: "10", barcode: "200000000001" },
          { attributes: { position: "Rear" }, sellPrice: "10" },
        ],
      }),
    );
    bikeVariant = bike.variants[0].id;
    frontPads = pads.variants[0].id;
    rearPads = pads.variants[1].id;
    expect(pads.variants.map((v) => v.label)).toEqual(["Front", "Rear"]);
    const found = await catalog.searchVariants(db, { search: "200000000001" });
    expect(found[0].id).toBe(frontPads);
  });

  it("records capital, container expenses and offloads at landed cost", async () => {
    await db.transaction((tx) => ops.partnerContribution(tx, { date: `${D}01`, partnerId: partnerA, accountId: cashUsd, amount: "30000" }, userId));
    const [loc] = await db.select().from(locations).limit(1);
    const container = await db.transaction(async (tx) => {
      const { containers } = await import("@shared/schema");
      const [row] = await tx.insert(containers).values({ number: "HHU-0001", supplierId, locationId: loc.id, status: "arrived" }).returning();
      await containersSvc.replaceLines(tx, row.id, [
        { variantId: bikeVariant, quantity: "10", unitPrice: "1500" },
        { variantId: frontPads, quantity: "600", unitPrice: "5" },
        { variantId: rearPads, quantity: "400", unitPrice: "5" },
      ]);
      await containersSvc.addExpense(tx, row.id, { date: `${D}02`, type: "freight", amount: "3000", currency: "USD", method: "value", paidFromAccountId: cashUsd }, userId);
      await containersSvc.addExpense(tx, row.id, { date: `${D}03`, type: "duties", amount: "1000", currency: "USD", method: "value", payablePartyId: agentId }, userId);
      return row;
    });
    containerId = container.id;

    const result = await db.transaction((tx) => containersSvc.finalizeContainer(tx, containerId, `${D}05`, userId));
    expect(result.landedTotalUsd).toBe("24000.00");
    expect(result.lines.map((l) => l.landedUnitCost)).toEqual(["1800.000000", "6.000000", "6.000000"]);

    const tb = await reports.trialBalance(db);
    expect(tb.balanced).toBe(true);
    const bal = Object.fromEntries(tb.rows.map((r) => [r.systemKey ?? r.code, r.balance]));
    expect(bal.inventory).toBe("24000.00");
    expect(bal.goods_in_transit).toBeUndefined(); // zero
    expect(bal.payables).toBe("-21000.00");

    const supplier = await reports.partyStatement(db, supplierId);
    expect(supplier.balance).toBe("-20000.00");
  });

  it("refuses to change a finalized container", async () => {
    await expect(
      db.transaction((tx) => containersSvc.addExpense(tx, containerId, { date: `${D}06`, type: "other", amount: "5", currency: "USD", method: "value", paidFromAccountId: cashUsd }, userId)),
    ).rejects.toThrow(/finalized/);
  });

  it("sells for USD and CDF with the cost fixed at the sale", async () => {
    const units = await db.select().from(motorcycleUnits).where(eq(motorcycleUnits.variantId, bikeVariant));
    expect(units).toHaveLength(10);
    await db.transaction((tx) => catalog.updateUnit(tx, units[0].id, { chassisNo: "lhjpcjlb0r0000001", engineNo: "e1" }));
    const [loc] = await db.select().from(locations).limit(1);

    // Unregistered chassis cannot be sold.
    await expect(
      db.transaction((tx) =>
        salesSvc.createSale(tx, { date: `${D}10`, locationId: loc.id, lines: [{ variantId: bikeVariant, unitId: units[1].id, qty: "1", unitPrice: "2500" }], payments: [{ accountId: cashUsd, amount: "2500" }] }, userId),
      ),
    ).rejects.toThrow(/chassis/);

    const sale = await db.transaction((tx) =>
      salesSvc.createSale(
        tx,
        {
          date: `${D}10`,
          locationId: loc.id,
          lines: [
            { variantId: bikeVariant, unitId: units[0].id, qty: "1", unitPrice: "2500" },
            { variantId: frontPads, qty: "10", unitPrice: "10" },
          ],
          payments: [
            { accountId: cashUsd, amount: "2500" },
            { accountId: cashCdf, amount: "280000", rate: "2800" },
          ],
        },
        userId,
      ),
    );
    firstSaleId = sale.id;
    expect(sale.total).toBe("2600.00");
    expect(sale.cogs).toBe("1860.00");
    expect(sale.creditUsd).toBe("0.00");
    expect(sale.lines[0].chassisNo).toBe("LHJPCJLB0R0000001");

    const balances = await reports.accountBalances(db);
    expect(balances.find((b) => b.id === cashCdf)!.nativeBalance).toBe("280000.00");
  });

  it("sells on credit only to a named customer and takes payments later", async () => {
    const [loc] = await db.select().from(locations).limit(1);
    const line = { variantId: rearPads, qty: "5", unitPrice: "10" };
    await expect(db.transaction((tx) => salesSvc.createSale(tx, { date: `${D}11`, locationId: loc.id, lines: [line], payments: [] }, userId))).rejects.toThrow(/customer/);
    await db.transaction((tx) => salesSvc.createSale(tx, { date: `${D}11`, locationId: loc.id, customerId, lines: [line], payments: [] }, userId));
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: `${D}12`, partyId: customerId, accountId: cashUsd, amount: "20" }, userId));
    const st = await reports.partyStatement(db, customerId);
    expect(st.balance).toBe("30.00");
  });

  it("does not sell more than is in stock", async () => {
    const [loc] = await db.select().from(locations).limit(1);
    await expect(
      db.transaction((tx) => salesSvc.createSale(tx, { date: `${D}12`, locationId: loc.id, lines: [{ variantId: rearPads, qty: "1000", unitPrice: "1" }], payments: [{ accountId: cashUsd, amount: "1000" }] }, userId)),
    ).rejects.toThrow(/Not enough stock/);
  });

  it("takes back a partial return at the original price and cost", async () => {
    const sale = await salesSvc.getSale(db, firstSaleId);
    const padLine = sale.lines.find((l) => l.variantId === frontPads)!;
    const after = await db.transaction((tx) =>
      salesSvc.returnSale(tx, firstSaleId, { date: `${D}15`, lines: [{ saleLineId: padLine.id, qty: "2" }], refundAccountId: cashUsd, reason: "Wrong size" }, userId),
    );
    expect(after.returns[0].total).toBe("20.00");
    expect(after.returns[0].cogs).toBe("12.00");
  });

  it("charges rent and closes the month 75/25 with expenses on the 75% partner", async () => {
    await db.transaction((tx) => ops.createExpense(tx, { date: `${D}20`, accountId: rent, description: "September rent", amount: "500", paidFromAccountId: cashUsd }, userId));

    const preview = await periodsSvc.previewPeriod(db, "2026-09");
    // Sales 2600 + 50 − 20 = 2630. COGS 1860 + 30 − 12 = 1878. Gross 752. Rent 500.
    expect(preview.totals.grossProfit).toBe("752.00");
    expect(preview.totals.operatingExpenses).toBe("500.00");
    expect(preview.split.partners.map((p) => p.net)).toEqual(["64.00", "188.00"]);

    await db.transaction((tx) => periodsSvc.closePeriod(tx, "2026-09", userId));
    const summaries = await reports.partnerSummaries(db);
    expect(summaries.map((s) => s.currentBalance)).toEqual(["64.00", "188.00"]);
    expect(summaries[0].capitalBalance).toBe("30000.00");

    const tb = await reports.trialBalance(db);
    expect(tb.balanced).toBe(true);
    // Profit and loss accounts are emptied into the partners.
    expect(tb.rows.filter((r) => ["income", "cost_of_sales", "expense"].includes(r.type))).toHaveLength(0);
    // The month's own report still shows its figures.
    const pnl = await reports.profitAndLoss(db, "2026-09-01", "2026-09-30");
    expect(pnl.totals.netProfit).toBe("252.00");
  });

  it("locks a closed month and allows reopening it", async () => {
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: `${D}25`, accountId: rent, description: "Late bill", amount: "10", paidFromAccountId: cashUsd }, userId)),
    ).rejects.toThrow(/closed/);
    await db.transaction((tx) => periodsSvc.reopenPeriod(tx, "2026-09", userId));
    const summaries = await reports.partnerSummaries(db);
    expect(summaries.map((s) => s.currentBalance)).toEqual(["0.00", "0.00"]);
    await db.transaction((tx) => periodsSvc.closePeriod(tx, "2026-09", userId));
  });

  it("pays partner withdrawals and a supplier, and keeps stock equal to the ledger", async () => {
    await db.transaction((tx) => ops.partnerWithdrawal(tx, { date: "2026-10-02", partnerId: partnerB, accountId: cashUsd, amount: "100" }, userId));
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-10-02", partyId: supplierId, accountId: cashUsd, amount: "20000" }, userId));
    const summaries = await reports.partnerSummaries(db);
    expect(summaries[1].currentBalance).toBe("88.00");
    const valuation = await reports.stockValuation(db);
    expect(valuation.reconciled).toBe(true);
    expect((await reports.trialBalance(db)).balanced).toBe(true);
  });

  it("cancels a sale in the next month without touching the closed one", async () => {
    await expect(db.transaction((tx) => salesSvc.voidSale(tx, firstSaleId, "2026-10-03", "test", userId))).rejects.toThrow(/returns/);
    const [loc] = await db.select().from(locations).limit(1);
    const sale = await db.transaction((tx) =>
      salesSvc.createSale(tx, { date: "2026-10-03", locationId: loc.id, lines: [{ variantId: rearPads, qty: "3", unitPrice: "12" }], payments: [{ accountId: cashUsd, amount: "36" }] }, userId),
    );
    const voided = await db.transaction((tx) => salesSvc.voidSale(tx, sale.id, "2026-10-03", "Customer changed mind", userId));
    expect(voided.status).toBe("voided");
    const pnl = await reports.profitAndLoss(db, "2026-10-01", "2026-10-31");
    expect(pnl.totals.netProfit).toBe("0.00");
    expect((await reports.stockValuation(db)).reconciled).toBe(true);
  });

  it("reverses an offload only while all of its stock is on hand", async () => {
    await expect(db.transaction((tx) => containersSvc.reverseContainer(tx, containerId, "2026-10-04", userId))).rejects.toThrow(/sold|enough/);
  });
});
