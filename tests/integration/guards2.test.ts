import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A7: what the second accounting audit found after A6. */
describe.skipIf(!hasDb)("Guards against moving value between partners", async () => {
  const backup = await import("../../server/services/backup");
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const reports = await import("../../server/services/reports");
  const sales = await import("../../server/services/sales");
  const vouchers = await import("../../server/services/vouchers");
  const userId = 1;
  const staff = { owner: false };
  let db: Db;
  let cashUsd: number, cashCdf: number, otherIncome: number, withheld: number, receivables: number, locationId: number, oil: number, customerId: number, supplierId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    otherIncome = accs.find((a) => a.systemKey === "other_income")!.id;
    withheld = accs.find((a) => a.systemKey === "payroll_withheld")!.id;
    receivables = accs.find((a) => a.systemKey === "receivables")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Garage Mwamba" }).returning();
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
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", variants: [{ attributes: {}, sellPrice: "5" }] }))).variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: oil, qtyChange: "100", unitCost: "2" }] }, userId));
  });

  it("lets only the owner move the day's rate far", async () => {
    const today = ledger.shopToday();
    await expect(db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "1000" }, 999, staff))).rejects.toThrow(/Only the owner/);
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2850" }, 999, staff));
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: today, cdfPerUsd: "2800" }, userId));
  });

  it("refuses a container rate that cannot be right", async () => {
    await expect(containersSvc.assertContainerRate(db, "CNY", "7.14", "2026-08-02")).rejects.toThrow(/looks wrong/);
    await containersSvc.assertContainerRate(db, "CNY", "0.14", "2026-08-02");
    await expect(containersSvc.assertContainerRate(db, "USD", "1.2", "2026-08-02")).rejects.toThrow(/rate of 1/);
  });

  it("keeps staff from paying running costs out of an income account", async () => {
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-03", accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "600", memo: "Loyer" }] }, userId, staff)),
    ).rejects.toThrow(/only the owner/);
  });

  it("refunds a credit sale against what the customer owes, not in cash", async () => {
    const sale = await db.transaction((tx) => sales.createSale(tx, { date: "2026-08-03", locationId, customerId, lines: [{ variantId: oil, qty: "2", unitPrice: "5" }], payments: [] }, userId));
    const before = (await reports.accountBalances(db)).find((b) => b.id === cashUsd)!.balance;
    await db.transaction((tx) => sales.returnSale(tx, sale.id, { date: "2026-08-04", reason: "Erreur", refundAccountId: cashUsd, lines: [{ saleLineId: sale.lines[0].id, qty: "2" }] }, userId));
    expect((await reports.accountBalances(db)).find((b) => b.id === cashUsd)!.balance).toBe(before);
    expect((await reports.partyStatement(db, customerId)).balance).toBe("0.00");
    expect((await reports.accountBalances(db)).find((b) => b.id === receivables)!.balance).toBe("0.00");
  });

  it("lets staff value found stock only near its cost, and records a count with no change", async () => {
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-05", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "1", unitCost: "5000" }] }, userId, staff)),
    ).rejects.toThrow(/average cost/);
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-05", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "1" }] }, userId, staff));
    const count = await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-05", locationId, kind: "count", reason: "Comptage", lines: [{ variantId: oil, qtyChange: "0" }] }, userId, staff));
    expect(count.journalId).toBeNull();
  });

  it("settles yuan owed with francs paid", async () => {
    const [c] = await db.insert(containers).values({ number: "Y-1", supplierId, locationId, currency: "CNY", rateToUsd: "0.14", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "100", unitPrice: "10" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-06", userId));
    // 1,000 CNY at $140; 196,000 FC is $70: half the yuan.
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-07", partyId: supplierId, accountId: cashCdf, amount: "196000" }, userId));
    const st = await reports.partyStatement(db, supplierId);
    expect(st.foreign).toEqual([{ partyId: supplierId, currency: "CNY", native: "-500.00", usd: "-70.00" }]);
  });

  it("pays a dollar withholding from francs without leaving francs behind", async () => {
    const [emp] = await db.insert(parties).values({ type: "employee", name: "Bahati", monthlySalary: "100" }).returning();
    const salaries = await payroll.salaryAccountId(db);
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", accountId: salaries, lines: [{ partyId: emp.id, salary: "100", withheld: "20" }] }, userId));
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-31", accountId: cashCdf, lines: [{ accountId: withheld, amount: "56000" }] }, userId, { owner: true }));
    expect((await reports.accountBalances(db)).find((b) => b.id === withheld)!.balance).toBe("0.00");
    expect((await ledger.foreignBalance(db, withheld, null, "CDF")).native.toFixed(2)).toBe("0.00");
  });

  it("refuses withholdings worth less than a cent", async () => {
    const [emp] = await db.insert(parties).values({ type: "employee", name: "Jean", monthlySalary: "0" }).returning();
    const salaries = await payroll.salaryAccountId(db);
    await expect(
      db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-07", accountId: salaries, currency: "CDF", rate: "2800", lines: [{ partyId: emp.id, salary: "280000", withheld: "10" }] }, userId)),
    ).rejects.toThrow(/less than one cent/);
  });

  it("shows advances paid on the assets side of the balance sheet", async () => {
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-21", partyId: supplierId, accountId: cashUsd, amount: "100" }, userId));
    const bs = await reports.balanceSheet(db);
    expect(bs.balanced).toBe(true);
    expect(bs.assets.some((a) => a.name.includes("avances versées"))).toBe(true);
  });

  it("seals backups so a file changed by hand is noticed", async () => {
    const text = await db.transaction((tx) => backup.snapshot(tx));
    expect(backup.verifySeal(text)).toBe(true);
    expect(backup.parseBackup(text).sealed).toBe(true);
    const tampered = text.replace('"Garage Mwamba"', '"Garage Mwamba 2"');
    expect(backup.verifySeal(tampered)).toBe(false);
  });
});
