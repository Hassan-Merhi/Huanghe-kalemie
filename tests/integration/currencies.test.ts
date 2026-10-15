import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A2: francs and yuan valued like an accountant would. */
describe.skipIf(!hasDb)("Francs, yuan and exchange differences", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const periods = await import("../../server/services/periods");
  const reports = await import("../../server/services/reports");
  const vouchers = await import("../../server/services/vouchers");
  const userId = 1;
  let db: Db;
  let cashUsd: number, cashCdf: number, fuel: number, payables: number, agentId: number, supplierId: number, locationId: number;

  const bal = async (id: number) => (await reports.accountBalances(db)).find((b) => b.id === id)!;
  const fx = async () => (await reports.accountBalances(db)).find((b) => b.systemKey === "fx")?.balance ?? "0.00";

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    fuel = accs.find((a) => a.code === "6070")!.id;
    [{ id: agentId }] = await db.insert(parties).values({ type: "agent", name: "Transitaire" }).returning();
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Chongqing" }).returning();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values([
      { date: "2026-08-01", cdfPerUsd: "2800" },
      { date: "2026-08-10", cdfPerUsd: "2900" },
      { date: "2026-08-31", cdfPerUsd: "3000" },
    ]);
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
  });

  it("uses the day's rate and refuses a rate far from it", async () => {
    await expect(
      db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-10", accountId: fuel, description: "x", amount: "1000", paidFromAccountId: cashCdf, rate: "2500" }, userId)),
    ).rejects.toThrow(/rate of the day/);
  });

  it("values francs spent at what they cost and books the difference", async () => {
    // 28,000 FC of fuel on a 2,900 day is a $9.66 expense; those francs cost $10.00 (bought at 2,800).
    const e = await db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-10", accountId: fuel, description: "Carburant", amount: "28000", paidFromAccountId: cashCdf }, userId));
    expect(e.amountUsd).toBe("9.66");
    expect(e.rate).toBe("2900.0000");
    expect(await bal(cashCdf)).toMatchObject({ nativeBalance: "252000.00", balance: "90.00" });
    expect(await fx()).toBe("0.34");
    expect((await reports.trialBalance(db)).balanced).toBe(true);
  });

  it("keeps a bill in francs owed in francs and clears it exactly when paid in francs", async () => {
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-02", accountId: fuel, description: "Facture transit", amount: "56000", currency: "CDF", payablePartyId: agentId }, userId));
    let st = await reports.partyStatement(db, agentId);
    expect(st.foreign).toEqual([{ partyId: agentId, currency: "CDF", native: "-56000.00", usd: "-20.00" }]);
    // Paid later at 2,900 from the franc drawer through a payment voucher.
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-12", accountId: cashCdf, lines: [{ partyId: agentId, amount: "56000" }] }, userId));
    st = await reports.partyStatement(db, agentId);
    expect(st.balance).toBe("0.00");
    expect(st.foreign).toEqual([]);
    // The francs paid cost exactly what the bill was worth (both at 2,800), so no new difference.
    expect(await fx()).toBe("0.34");
    expect(await bal(cashCdf)).toMatchObject({ nativeBalance: "196000.00", balance: "70.00" });
  });

  it("values francs sold for dollars at their cost", async () => {
    // 98,000 FC (cost $35.00) changed for $33.00.
    await db.transaction((tx) => ops.transferMoney(tx, { date: "2026-08-15", fromAccountId: cashCdf, fromAmount: "98000", toAccountId: cashUsd, toAmount: "33" }, userId));
    expect(await bal(cashCdf)).toMatchObject({ nativeBalance: "98000.00", balance: "35.00" });
    expect(await fx()).toBe("2.34");
  });

  it("settles a yuan invoice paid in dollars with its own difference", async () => {
    const oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", variants: [{ attributes: {}, sellPrice: "4" }] }))).variants[0].id;
    const [c] = await db.insert(containers).values({ number: "CNY-1", supplierId, locationId, currency: "CNY", rateToUsd: "0.14", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "1000", unitPrice: "10" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-20", userId));
    let st = await reports.partyStatement(db, supplierId);
    expect(st.foreign).toEqual([{ partyId: supplierId, currency: "CNY", native: "-10000.00", usd: "-1400.00" }]);
    await expect(db.transaction((tx) => ops.payParty(tx, { date: "2026-08-21", partyId: supplierId, accountId: cashUsd, amount: "1380", settleNative: "10001" }, userId))).rejects.toThrow(/only/);
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-21", partyId: supplierId, accountId: cashUsd, amount: "1380", settleNative: "10000" }, userId));
    st = await reports.partyStatement(db, supplierId);
    expect(st.balance).toBe("0.00");
    expect(st.foreign).toEqual([]);
    expect(await fx()).toBe("-17.66"); // $20 gain (income has a credit balance) less the $2.34 lost so far
  });

  it("revalues the francs at the month-end rate when the month closes", async () => {
    // 98,000 FC worth $35.00 at cost; at 3,000 on 31 August they are worth $32.67: a $2.33 loss.
    const preview = await periods.previewPeriod(db, "2026-08");
    const fxRow = preview.accounts.find((a) => a.code === "4200")!;
    expect(fxRow.amount).toBe("15.33");
    await db.transaction((tx) => periods.closePeriod(tx, "2026-08", userId));
    expect(await bal(cashCdf)).toMatchObject({ nativeBalance: "98000.00", balance: "32.67" });
    expect((await reports.trialBalance(db)).balanced).toBe(true);
    // Reopening takes the revaluation back out.
    await db.transaction((tx) => periods.reopenPeriod(tx, "2026-08", userId));
    expect(await bal(cashCdf)).toMatchObject({ balance: "35.00" });
  });
  it("lets dollars settle the dollar balance first and ignores bills dated later", async () => {
    const [{ id: garage }] = await db.insert(parties).values({ type: "supplier", name: "Garage" }).returning();
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-09-05", accountId: fuel, description: "Réparation", amount: "100", payablePartyId: garage }, userId));
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-09-25", accountId: fuel, description: "Pièces", amount: "28000", currency: "CDF", payablePartyId: garage }, userId));
    // Typed after the franc bill but dated before it: the franc bill did not exist yet.
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-09-06", partyId: garage, accountId: cashUsd, amount: "110" }, userId));
    let st = await reports.partyStatement(db, garage);
    expect(st.foreign).toEqual([{ partyId: garage, currency: "CDF", native: "-28000.00", usd: "-9.33" }]);
    // $100 owed in dollars, $10 paid ahead: a later $5 payment goes to the francs (5 × 3,000 = 15,000 FC).
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-09-30", partyId: garage, accountId: cashUsd, amount: "5" }, userId));
    st = await reports.partyStatement(db, garage);
    expect(st.foreign[0].native).toBe("-13000.00");
  });

});
