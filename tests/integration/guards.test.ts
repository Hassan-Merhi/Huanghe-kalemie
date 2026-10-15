import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, containers, exchangeRates, locations, parties, partners, periods as periodsTable } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A6: the guards that keep a typo from becoming money in the books. */
describe.skipIf(!hasDb)("Guards on amounts, rates and privacy", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const periods = await import("../../server/services/periods");
  const payroll = await import("../../server/services/payroll");
  const reports = await import("../../server/services/reports");
  const sales = await import("../../server/services/sales");
  const vouchers = await import("../../server/services/vouchers");
  const userId = 1;
  const owner = { owner: true };
  let db: Db;
  let cashUsd: number, cashCdf: number, fuel: number, payables: number, withheld: number, supplierId: number, locationId: number, oil: number;

  const bal = async (id: number) => (await reports.accountBalances(db)).find((b) => b.id === id)!;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    withheld = accs.find((a) => a.systemKey === "payroll_withheld")!.id;
    fuel = accs.find((a) => a.code === "6070")!.id;
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Chongqing" }).returning();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
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
            { accountId: cashCdf, debit: "100", nativeAmount: "280000", rate: "2800" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "5100" },
          ],
        },
        userId,
      ),
    );
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", variants: [{ attributes: {}, sellPrice: "4" }] }))).variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: oil, qtyChange: "100", unitCost: "2" }] }, userId));
  });

  it("refuses dollars that clear yuan at a rate far from what they cost", async () => {
    const [c] = await db.insert(containers).values({ number: "G-1", supplierId, locationId, currency: "CNY", rateToUsd: "0.14", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "1000", unitPrice: "10" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-02", userId));
    await expect(
      db.transaction((tx) => ops.payParty(tx, { date: "2026-08-03", partyId: supplierId, accountId: cashUsd, amount: "1", settleNative: "10000" }, userId)),
    ).rejects.toThrow(/away from/);
  });

  it("lets plain dollars paid to a yuan supplier settle the yuan at what they cost", async () => {
    // 10,000 CNY owed at $1,400: $700 clears half of them, with no exchange difference.
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-03", partyId: supplierId, accountId: cashUsd, amount: "700" }, userId));
    const st = await reports.partyStatement(db, supplierId);
    expect(st.foreign).toEqual([{ partyId: supplierId, currency: "CNY", native: "-5000.00", usd: "-700.00" }]);
  });

  it("checks the rate implied by an exchange and the amounts of a same-currency transfer", async () => {
    await expect(db.transaction((tx) => ops.transferMoney(tx, { date: "2026-08-03", fromAccountId: cashUsd, fromAmount: "1000", toAccountId: cashCdf, toAmount: "1" }, userId))).rejects.toThrow(/Check both amounts/);
    const [bank] = await db.insert(accounts).values({ code: "5200", name: "Banque", type: "asset", isMoney: true, currency: "USD" }).returning();
    await expect(db.transaction((tx) => ops.transferMoney(tx, { date: "2026-08-03", fromAccountId: cashUsd, fromAmount: "100", toAccountId: bank.id, toAmount: "90" }, userId))).rejects.toThrow(/same amount/);
    await db.transaction((tx) => ops.transferMoney(tx, { date: "2026-08-03", fromAccountId: cashUsd, fromAmount: "100", toAccountId: cashCdf, toAmount: "280500" }, userId));
  });

  it("refuses to take a money account below zero, now or on an earlier day", async () => {
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-04", accountId: fuel, description: "x", amount: "50000", paidFromAccountId: cashUsd }, userId)),
    ).rejects.toThrow(/does not hold enough/);
    // $4,200 is there now, but on 1 August, before the yuan payment, so is the money; on 31 July nothing was.
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-07-31", accountId: fuel, description: "x", amount: "10", paidFromAccountId: cashUsd }, userId)),
    ).rejects.toThrow(/does not hold enough/);
  });

  it("refuses an amount in one currency taken from an account in another", async () => {
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-04", accountId: fuel, description: "x", amount: "145000", currency: "CDF", paidFromAccountId: cashUsd }, userId)),
    ).rejects.toThrow(/account pays in USD/);
  });

  it("refuses francs worth less than a cent and dates in the future", async () => {
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-04", accountId: fuel, description: "x", amount: "1", paidFromAccountId: cashCdf }, userId)),
    ).rejects.toThrow(/less than one cent/);
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2099-01-01", accountId: fuel, description: "x", amount: "1", paidFromAccountId: cashUsd }, userId)),
    ).rejects.toThrow(/future/);
  });

  it("keeps an advance in francs in francs, and pays out withholdings in francs", async () => {
    const [emp] = await db.insert(parties).values({ type: "employee", name: "Amani", monthlySalary: "0" }).returning();
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-10", accountId: cashCdf, lines: [{ partyId: emp.id, amount: "28000" }] }, userId, owner));
    let st = await reports.partyStatement(db, emp.id);
    expect(st.foreign).toEqual([{ partyId: emp.id, currency: "CDF", native: "28000.00", usd: "10.00" }]);
    // Salary 280,000 FC, 14,000 withheld: the advance in francs is netted in francs.
    const salaries = await payroll.salaryAccountId(db);
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", accountId: salaries, currency: "CDF", lines: [{ partyId: emp.id, salary: "280000", withheld: "14000" }] }, userId));
    st = await reports.partyStatement(db, emp.id);
    expect(st.foreign[0].native).toBe("-238000.00");
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-25", accountId: cashCdf, lines: [{ accountId: withheld, amount: "14000" }] }, userId, owner));
    expect(await bal(withheld)).toMatchObject({ balance: "0.00" });
    const native = await ledger.foreignBalance(db, withheld, null, "CDF");
    expect(native.native.toFixed(2)).toBe("0.00");
  });

  it("takes francs and gives back dollars, absorbs small franc rounding both ways, and refuses negative discounts", async () => {
    // $8 of oil paid with 28,000 FC ($10): $2 change from the dollar drawer.
    const sale = await db.transaction((tx) =>
      sales.createSale(tx, { date: "2026-08-11", locationId, lines: [{ variantId: oil, qty: "2", unitPrice: "4" }], payments: [{ accountId: cashCdf, amount: "28000" }], change: { accountId: cashUsd, amount: "2" } }, userId),
    );
    expect(sale.total).toBe("8.00");
    expect(sale.creditUsd).toBe("0.00");
    // 11,180 FC for $4 is 20 FC short: accepted as rounding for a walk-in customer.
    const short = await db.transaction((tx) => sales.createSale(tx, { date: "2026-08-11", locationId, lines: [{ variantId: oil, qty: "1", unitPrice: "4" }], payments: [{ accountId: cashCdf, amount: "11180" }] }, userId));
    expect(short.creditUsd).toBe("0.00");
    await expect(
      db.transaction((tx) => sales.createSale(tx, { date: "2026-08-11", locationId, lines: [{ variantId: oil, qty: "1", unitPrice: "4", lineDiscount: "-5" }], payments: [{ accountId: cashUsd, amount: "9" }] }, userId)),
    ).rejects.toThrow(/negative/);
    // Dollars must match to the cent.
    await expect(
      db.transaction((tx) => sales.createSale(tx, { date: "2026-08-11", locationId, lines: [{ variantId: oil, qty: "1", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "4.05" }] }, userId)),
    ).rejects.toThrow(/more than the total/);
  });

  it("refuses an adjustment that changes nothing", async () => {
    await expect(db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-12", locationId, kind: "damage", reason: "Casse", lines: [{ variantId: oil, qtyChange: "0" }] }, userId))).rejects.toThrow(/Nothing to adjust/);
  });

  it("shows a balanced balance sheet and counts every debt in the net position", async () => {
    const bs = await reports.balanceSheet(db);
    expect(bs.balanced).toBe(true);
    const pos = reports.netPosition(await reports.accountBalances(db));
    expect(pos.net).toBe(bs.totalEquity);
  });

  it("revalues yuan at month end once a yuan rate is known, and refuses rate changes in a closed month", async () => {
    await db.transaction((tx) => ledger.setExchangeRate(tx, { date: "2026-08-31", cdfPerUsd: "2800", cnyPerUsd: "7.5" }, userId));
    await db.transaction((tx) => periods.closePeriod(tx, "2026-08", userId));
    // 5,000 CNY owed, $700 at cost, $666.67 at 7.5: a $33.33 gain.
    const st = await reports.partyStatement(db, supplierId);
    expect(st.foreign[0]).toMatchObject({ native: "-5000.00", usd: "-666.67" });
    await expect(db.transaction((tx) => ledger.setExchangeRate(tx, { date: "2026-08-20", cdfPerUsd: "2900" }, userId))).rejects.toThrow(/closed/);
  });

  it("splits a reopened month again with the shares it was first closed with", async () => {
    const [first] = await db.select().from(periodsTable).where(eq(periodsTable.month, "2026-08"));
    const before = (first.result as { split: unknown }).split;
    const ps = await db.select().from(partners);
    await db.update(partners).set({ sharePct: "50.00" }).where(eq(partners.id, ps[0].id));
    await db.update(partners).set({ sharePct: "50.00" }).where(eq(partners.id, ps[1].id));
    await db.transaction((tx) => periods.reopenPeriod(tx, "2026-08", userId));
    const again = await db.transaction((tx) => periods.closePeriod(tx, "2026-08", userId));
    expect(again.split).toEqual(before);
  });

  it("hides the other partners' lines from a partner", async () => {
    const ps = await db.select().from(partners);
    const hidden = await reports.otherPartnerAccountIds(db, ps[1].id);
    expect(hidden.has(ps[0].capitalAccountId)).toBe(true);
    expect(hidden.has(ps[1].capitalAccountId)).toBe(false);
    const j = { type: "partner_withdrawal", memo: "Retrait de A" };
    const lines = [
      { accountId: ps[0].currentAccountId, debit: "100.00", credit: "0.00", accountName: "A\u00a0: compte de bénéfices", memo: null },
      { accountId: cashUsd, debit: "0.00", credit: "100.00", accountName: "Caisse USD", memo: null },
    ];
    const m = reports.maskPartnerJournal(j, lines, hidden);
    expect(m.journal.memo).toBe("Mouvement d'un autre associé");
    expect(m.lines.map((l) => l.accountName)).toEqual(["Autres associés", "Caisse USD"]);
  });
});
