import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, containers, expenses, journals, locations, parties, variants, voucherDrafts } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

describe.skipIf(!hasDb)("Vouchers, optional vouchers, payroll, imports and inventory reports", async () => {
  const vouchers = await import("../../server/services/vouchers");
  const payroll = await import("../../server/services/payroll");
  const imports = await import("../../server/services/imports");
  const insights = await import("../../server/services/insights");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const userId = 1;
  let db: Db;
  let locationId: number, cashUsd: number, cashCdf: number, rent: number, salaries: number, otherIncome: number;
  let supplierId: number, customerId: number, empA: number, empB: number;

  const balanceOf = async (key: string) => (await reports.accountBalances(db)).find((a) => a.systemKey === key)!;

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    rent = accs.find((a) => a.code === "6000")!.id;
    salaries = accs.find((a) => a.code === "6010")!.id;
    otherIncome = accs.find((a) => a.systemKey === "other_income")!.id;
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Agent Dar" }).returning();
    [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Garage Tanganyika" }).returning();
    [{ id: empA }] = await db.insert(parties).values({ type: "employee", name: "Amani", monthlySalary: "150" }).returning();
    [{ id: empB }] = await db.insert(parties).values({ type: "employee", name: "Bahati", monthlySalary: "120" }).returning();
    // Money in the drawers to pay from.
    await db.transaction((tx) => ops.manualJournal(tx, { date: "2026-09-01", memo: "Ouverture", type: "opening", lines: [{ accountId: cashUsd, debit: "2000" }, { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "2000" }] }, userId));
    await db.transaction((tx) =>
      ops.manualJournal(tx, { date: "2026-09-01", memo: "Ouverture FC", type: "opening", lines: [{ accountId: cashCdf, debit: "100", nativeAmount: "280000", rate: "2800" }, { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "100" }] }, userId),
    );
  });

  it("posts a payment voucher with an expense line and a supplier line, and shows the expense in Expenses", async () => {
    const r = await db.transaction((tx) =>
      vouchers.postVoucher(tx, "payment", { date: "2026-09-05", accountId: cashUsd, memo: "Paiements du jour", lines: [{ accountId: rent, amount: "300", memo: "Loyer septembre" }, { partyId: supplierId, amount: "250" }] }, userId, { owner: true }),
    );
    expect(r.total).toBe("550.00");
    expect((await balanceOf("cash_usd")).balance).toBe("1450.00");
    const exp = await db.select().from(expenses).where(eq(expenses.journalId, r.id));
    expect(exp).toHaveLength(1);
    expect(exp[0].amountUsd).toBe("300.00");
    expect(exp[0].description).toBe("Loyer septembre");
    const sup = (await reports.partyBalances(db, "supplier")).find((p) => p.id === supplierId)!;
    expect(sup.balance).toBe("250.00");

    // The expense can only be undone with the whole voucher.
    await expect(db.transaction((tx) => ops.voidExpense(tx, exp[0].id, "2026-09-06", userId))).rejects.toThrow(/voucher/);
    await db.transaction((tx) => vouchers.reverseVoucher(tx, r.id, "2026-09-06", userId));
    expect((await balanceOf("cash_usd")).balance).toBe("2000.00");
    const [after] = await db.select().from(expenses).where(eq(expenses.id, exp[0].id));
    expect(after.voidedAt).not.toBeNull();
  });

  it("values a CDF payment at the voucher rate and keeps the franc balance", async () => {
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-09-07", accountId: cashCdf, rate: "2800", lines: [{ accountId: rent, amount: "56000" }, { accountId: rent, amount: "28000" }] }, userId, { owner: true }));
    const cdf = await balanceOf("cash_cdf");
    expect(cdf.nativeBalance).toBe("196000.00");
    expect(cdf.balance).toBe("70.00");
  });

  it("posts a receipt voucher from a customer and other income", async () => {
    await db.transaction((tx) => vouchers.postVoucher(tx, "receipt", { date: "2026-09-08", accountId: cashUsd, lines: [{ partyId: customerId, amount: "40" }, { accountId: otherIncome, amount: "10" }] }, userId, { owner: true }));
    const c = (await reports.partyBalances(db, "customer")).find((p) => p.id === customerId)!;
    expect(c.balance).toBe("-40.00");
    expect((await balanceOf("cash_usd")).balance).toBe("2050.00");
  });

  it("refuses lines that belong to other screens", async () => {
    const inventory = (await db.select().from(accounts)).find((a) => a.systemKey === "inventory")!.id;
    await expect(db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-09-08", accountId: cashUsd, lines: [{ accountId: inventory, amount: "5" }] }, userId, { owner: true }))).rejects.toThrow(/own screen/);
    await expect(db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-09-08", accountId: cashUsd, lines: [{ accountId: cashCdf, amount: "5" }] }, userId, { owner: true }))).rejects.toThrow(/transfer/);
  });

  it("keeps optional vouchers out of the books until finalized", async () => {
    const before = await reports.trialBalance(db);
    const draft = await db.transaction((tx) => vouchers.saveDraft(tx, { kind: "payment", date: "2026-09-09", memo: "Brouillon", payload: { accountId: cashUsd, lines: [{ accountId: rent, amount: "20" }] } }, userId));
    expect(draft.totalUsd).toBe("20.00");
    expect((await reports.trialBalance(db)).rows).toEqual(before.rows);
    const res = await db.transaction((tx) => vouchers.finalizeDraft(tx, draft.id, userId, { owner: true }, (_k, p) => p));
    expect(res.kind).toBe("payment");
    expect(await db.select().from(voucherDrafts)).toHaveLength(0);
    expect((await balanceOf("cash_usd")).balance).toBe("2030.00");

    // A draft that fails its checks stays a draft.
    const bad = await db.transaction((tx) => vouchers.saveDraft(tx, { kind: "journal", date: "2026-09-09", memo: "Déséquilibré", payload: { memo: "x", lines: [{ accountId: rent, debit: "5" }, { accountId: cashUsd, credit: "4" }] } }, userId));
    await expect(db.transaction((tx) => vouchers.finalizeDraft(tx, bad.id, userId, { owner: true }, (_k, p) => p))).rejects.toThrow(/equal/);
    expect(await db.select().from(voucherDrafts)).toHaveLength(1);
  });

  it("books salaries, nets advances and pays the rest", async () => {
    // Advance to Amani before payday.
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-09-10", partyId: empA, accountId: cashUsd, amount: "50" }, userId));
    const run = await db.transaction((tx) =>
      payroll.runPayroll(tx, { month: "2026-09", accountId: salaries, lines: [{ partyId: empA, salary: "150", bonus: "10" }, { partyId: empB, salary: "120", deduction: "20" }] }, userId),
    );
    expect(run.totalUsd).toBe("260.00");
    await expect(db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-09", accountId: salaries, lines: [{ partyId: empA, salary: "1" }] }, userId))).rejects.toThrow(/already/);
    let staff = await payroll.employees(db);
    expect(staff.find((e) => e.id === empA)!.balance).toBe("-110.00");
    expect(staff.find((e) => e.id === empB)!.balance).toBe("-100.00");
    const pnl = await reports.profitAndLoss(db, "2026-09-01", "2026-09-30");
    expect(pnl.accounts.find((a) => a.accountId === salaries)!.amount).toBe("260.00");

    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-09-30", accountId: cashUsd, memo: "Salaires", lines: [{ partyId: empA, amount: "110" }, { partyId: empB, amount: "100" }] }, userId, { owner: true }));
    staff = await payroll.employees(db);
    expect(staff.every((e) => e.balance === "0.00")).toBe(true);

    // A cancellation cannot be dated before the entry it cancels (the run is dated 30 September).
    await expect(db.transaction((tx) => payroll.cancelRun(tx, "2026-09", "2026-09-15", userId))).rejects.toThrow(/before/);
    expect(await payroll.listRuns(db)).toHaveLength(1);
    // Without a date the cancellation is dated like the run, so September loses the salaries (not the day it is cancelled).
    await db.transaction((tx) => payroll.cancelRun(tx, "2026-09", null, userId));
    const runs = await payroll.listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("cancelled");
    expect(runs[0].cancelJournalId).toBeTruthy();
    const [reversal] = await db.select().from(journals).where(eq(journals.reversesJournalId, run.journalId!));
    expect(reversal.date).toBe("2026-09-30");
    expect((await reports.profitAndLoss(db, "2026-09-01", "2026-09-30")).accounts.find((a) => a.accountId === salaries)).toBeUndefined();
  });

  it("imports items with opening stock and keeps stock equal to the ledger", async () => {
    const preview = await db.transaction((tx) => imports.previewItems(tx, [{ name: "Pneu", size: "3.00-17" }, { name: "" }, { name: "pneu", size: "2.75-17" }]));
    expect(preview.map((p) => p.status)).toEqual(["new_item", "error", "new_variant"]);
    const res = await db.transaction((tx) =>
      imports.importItems(
        tx,
        {
          date: "2026-09-02",
          locationId,
          rows: [
            { name: "Pneu", category: "Pneus", size: "3.00-17", sellPrice: "25", qty: "10", unitCost: "14.5" },
            { name: "Pneu", category: "Pneus", size: "2.75-17", sellPrice: "22", qty: "4", unitCost: "12" },
            { name: "Huile 4T", category: "Huiles", sku: "OIL-1", sellPrice: "6" },
          ],
        },
        userId,
      ),
    );
    expect(res.created).toBe(2);
    expect(res.newVariants).toBe(1);
    expect(res.stockLines).toBe(2);
    const val = await reports.stockValuation(db);
    expect(val.totalValue).toBe("193.00");
    expect(val.reconciled).toBe(true);
    // Re-importing the same rows matches the existing items.
    const again = await db.transaction((tx) => imports.previewItems(tx, [{ name: "pneu", size: "3.00-17" }, { name: "x", sku: "oil-1" }]));
    expect(again.map((p) => p.status)).toEqual(["existing", "existing"]);
    // A bad row rolls the whole file back.
    await expect(db.transaction((tx) => imports.importItems(tx, { date: "2026-09-02", locationId, rows: [{ name: "Chaîne" }, { name: "Frein", qty: "2" }] }, userId))).rejects.toThrow(/Row 3/);
    expect((await db.select().from(variants)).length).toBe(3);

    await db.transaction((tx) => imports.updatePrices(tx, [{ sku: "OIL-1", sellPrice: "7" }]));
    expect((await db.select().from(variants).where(eq(variants.sku, "OIL-1")))[0].sellPrice).toBe("7.00");
  });

  it("loads a packing list into a container and shows it on the way", async () => {
    const [c] = await db.insert(containers).values({ number: "PL-1", supplierId, locationId, status: "in_transit", currency: "CNY", rateToUsd: "0.14" }).returning();
    const r = await db.transaction((tx) =>
      imports.importContainerLines(tx, c.id, {
        mode: "replace",
        rows: [
          { name: "Pneu", size: "3.00-17", quantity: "100", unitPrice: "70", weightKg: "300" },
          { name: "HH150", category: "Motos", colour: "Rouge", motorcycle: true, quantity: "5", unitPrice: "4000" },
        ],
      }),
    );
    expect(r).toMatchObject({ imported: 2, created: 1 });
    await db.transaction((tx) => imports.importContainerLines(tx, c.id, { mode: "append", rows: [{ name: "Pneu", size: "2.75-17", quantity: "10", unitPrice: "60" }] }));
    const otw = await insights.onTheWay(db);
    expect(otw).toHaveLength(3);
    expect(otw.find((l) => l.productName === "HH150")!.fobUsd).toBe("2800.00");
    await expect(db.transaction((tx) => imports.importContainerLines(tx, c.id, { mode: "append", rows: [{ name: "HH150", colour: "Rouge", quantity: "1.5", unitPrice: "1" }] }))).rejects.toThrow(/whole/);
  });

  it("rebuilds stock as of a date and per month, and summarizes accounts by month", async () => {
    const asOf = await insights.stockAsOf(db, "2026-12-31");
    expect(asOf.totalValue).toBe((await reports.stockValuation(db)).totalValue);
    expect((await insights.stockAsOf(db, "2026-09-01")).totalValue).toBe("0.00");
    const tyre = (await db.select().from(variants)).find((v) => v.attributes.Taille === "3.00-17")!;
    const m = await insights.itemMonthly(db, tyre.id, 2026);
    expect(m.months[8]).toMatchObject({ inQty: "10.000", inValue: "145.00", closingQty: "10.000" });
    const byLoc = await insights.inventoryByLocation(db);
    expect(byLoc.find((r) => r.variantId === tyre.id)!.value).toBe("145.00");

    const monthly = await insights.accountMonthly(db, cashUsd, 2026);
    expect(monthly.closing).toBe((await balanceOf("cash_usd")).balance);
    expect(monthly.months[8].count).toBeGreaterThan(0);
  });

  it("builds analytics and the net position", async () => {
    const a = await insights.analytics(db, "2026-09-01", "2026-09-30");
    expect(a.trend).toHaveLength(12);
    expect(a.expenses.length).toBeGreaterThan(0);
    const bal = await reports.accountBalances(db);
    const pos = reports.netPosition(bal);
    const equity = bal.filter((b) => b.type === "equity" || b.type === "income" || b.type === "expense" || b.type === "cost_of_sales" || b.type === "liability").filter((b) => b.systemKey !== "payables");
    // Assets minus payables equals the rest of the ledger with the sign flipped.
    const rest = equity.reduce((s, b) => s - Number(b.balance), 0);
    expect(Number(pos.net)).toBeCloseTo(rest, 2);
  });
});
