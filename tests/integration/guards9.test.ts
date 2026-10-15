import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, exchangeRates, journalLines, locations, parties, users, variants } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A14: what the ninth accounting audit found after A13 and U8. */
describe.skipIf(!hasDb)("Guards found by the ninth audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const reports = await import("../../server/services/reports");
  const salesSvc = await import("../../server/services/sales");
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

  const product = async (name: string, sellPrice: string, unit = "pcs") => (await db.transaction((tx) => catalog.createProduct(tx, { name, unit, variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;
  const balances = async (partyId: number) => (await reports.partyStatement(db, partyId)).foreign;

  it("never refunds more francs than the item returned was worth", async () => {
    const oil = await product("Huile", "5", "litre");
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "10", unitCost: "3" }] }, ownerId, { owner: true }));
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-03", locationId, lines: [{ variantId: oil, qty: "1", unitPrice: "5" }], payments: [{ accountId: cashUsd, amount: "5" }] }, ownerId));
    for (let i = 0; i < 5; i++) {
      await db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-04", reason: "Retour", refundAccountId: cashCdf, lines: [{ saleLineId: sale.lines[0].id, qty: "0.002" }] }, ownerId));
    }
    const paidOut = await db
      .select({ native: journalLines.nativeAmount })
      .from(journalLines)
      .where(eq(journalLines.accountId, cashCdf));
    const refunded = paidOut.filter((l) => Number(l.native) < 0).reduce((s, l) => s - Number(l.native), 0);
    // 0.01 L worth $0.05 = 140 FC at most.
    expect(refunded).toBeLessThanOrEqual(140);
    expect((await reports.balanceSheet(db)).balanced).toBe(true);
  });

  it("refuses offloading part of a piece after the item switched to pieces", async () => {
    const [{ id: sup }] = await db.insert(parties).values({ type: "supplier", name: "Fourn." }).returning();
    const v = await product("Câble", "4", "litre");
    const [c] = await db.insert(containers).values({ number: "U-1", supplierId: sup, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: v, quantity: "10.5", unitPrice: "2" }]));
    const [{ productId }] = await db.select().from(variants).where(eq(variants.id, v));
    await db.transaction((tx) => catalog.updateProduct(tx, productId, { unit: "pcs" }));
    await expect(db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-05", ownerId))).rejects.toThrow(/whole/);
  });

  it("caps staff dollar payments of a franc liability at the francs' value today", async () => {
    const [{ id: liab }] = await db.select().from(accounts).where(eq(accounts.systemKey, "payroll_withheld"));
    const fuel = (await db.select().from(accounts).where(eq(accounts.type, "expense")))[0].id;
    await db.transaction((tx) =>
      ops.manualJournal(tx, { date: "2026-08-06", memo: "Retenue", type: "manual", lines: [{ accountId: fuel, debit: "14.29" }, { accountId: liab, credit: "14.29", ...({ currency: "CDF" } as object), nativeAmount: "40000", rate: "2800" }] }, ownerId),
    );
    await db.insert(exchangeRates).values([{ date: "2026-08-07", cdfPerUsd: "2900" }]);
    // 40,000 FC at 2,900 is 13.79 $.
    await expect(
      db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-07", accountId: cashUsd, lines: [{ accountId: liab, amount: "14.21" }] }, managerId, staff)),
    ).rejects.toThrow(/13\.79/);
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-07", accountId: cashUsd, lines: [{ accountId: liab, amount: "13.79" }] }, managerId, staff));
  });

  it("gives an advance back when the franc bill it settled is removed", async () => {
    const [{ id: sup }] = await db.insert(parties).values({ type: "supplier", name: "Fourn. 2" }).returning();
    const [{ id: agent }] = await db.insert(parties).values({ type: "agent", name: "Agent" }).returning();
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-08", partyId: agent, accountId: cashUsd, amount: "100" }, ownerId));
    const [c] = await db.insert(containers).values({ number: "U-2", supplierId: sup, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    const exp = await db.transaction((tx) => containersSvc.addExpense(tx, c.id, { date: "2026-08-08", type: "customs", amount: "280000", currency: "CDF", method: "value", payablePartyId: agent }, ownerId));
    await db.transaction((tx) => containersSvc.removeExpense(tx, c.id, exp.id, "2026-08-09", ownerId));
    const f = await balances(agent);
    expect(f.find((x) => x.currency === "CDF")?.native ?? "0.00").toBe("0.00");
    expect((await reports.partyStatement(db, agent)).balance).toBe("100.00");
  });

  it("gives a salary advance back when the franc payroll run is cancelled", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Bahati", monthlySalary: "560000" }).returning();
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-05", partyId: e, accountId: cashUsd, amount: "100" }, ownerId));
    const accountId = (await db.transaction((tx) => payroll.salaryAccountId(tx)))!;
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", date: "2026-08-06", accountId, currency: "CDF", lines: [{ partyId: e, salary: "560000" }] }, ownerId));
    await db.transaction((tx) => payroll.cancelRun(tx, "2026-08", null, ownerId));
    const f = await balances(e);
    expect(f.find((x) => x.currency === "CDF")?.native ?? "0.00").toBe("0.00");
    expect((await reports.partyStatement(db, e)).balance).toBe("100.00");
  });

  it("hides another partner's memo on the lines a partner still sees", () => {
    const m = reports.maskPartnerJournal(
      { type: "payment", memo: "SECRET" },
      [{ accountId: 1, debit: "0.00", credit: "10.00", accountName: "Caisse", memo: "SECRET cash" }, { accountId: 2, debit: "10.00", credit: "0.00", accountName: "Associé B", memo: null }],
      new Set([2]),
    );
    expect(JSON.stringify(m)).not.toContain("SECRET");
  });

  void ledger;
});
