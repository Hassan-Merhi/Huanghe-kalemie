import { beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { accounts, containers, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U26: the yuan a dollar payment settles, previewed as the server books them; the recorded average cost on
 * the valuation; the balance sheet's advance lines; francs asked in 100 FC notes at the till still settle a
 * sale; a credit-sale return beyond the debt becomes an avoir.
 */
describe.skipIf(!hasDb)("Twenty-first UI audit", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const salesSvc = await import("../../server/services/sales");
  const { paymentSplit } = await import("../../client/src/lib/allocation");
  const userId = 1;
  const D = (x: Decimal.Value) => new Decimal(x);
  let db: Db;
  let cashUsd: number, cashCdf: number, capital: number, supplierId: number, customerId: number, locationId: number;
  const product = async (name: string, sellPrice = "4", unit?: string) =>
    (await db.transaction((tx) => catalog.createProduct(tx, { name, ...(unit ? { unit } : {}), variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;
  const opening = (variantId: number, qty: string, unitCost: string) =>
    db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-02", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: qty, unitCost }] }, userId));
  const balanceOf = async (id: number) => (await reports.partyBalances(db)).find((p) => p.id === id)!.balance;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    capital = accs.find((a) => a.type === "equity")!.id;
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Huanghe Group" }).returning();
    [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Atelier Bahati" }).returning();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values({ date: "2026-08-01", cdfPerUsd: "2808" });
    await db.transaction((tx) => ops.manualJournal(tx, { date: "2026-08-01", memo: "Ouverture", lines: [{ accountId: cashUsd, debit: "30000" }, { accountId: capital, credit: "30000" }] }, userId));
  });

  it("previews the yuan a dollar payment settles as the server books them, with or without a yuan rate", async () => {
    // 10 450 $ owed in dollars and 80 050 ¥ invoiced at 7,2 (11 118,05 $, each line rounded to the cent).
    const [moto, tyre, oil] = [await product("Moto"), await product("Pneu"), await product("Huile")];
    const [usdC] = await db.insert(containers).values({ number: "USD-1", supplierId, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, usdC.id, [{ variantId: moto, quantity: "10", unitPrice: "1045" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, usdC.id, "2026-08-20", userId));
    const [c] = await db.insert(containers).values({ number: "CNY-1", supplierId, locationId, currency: "CNY", rateToUsd: D(1).dividedBy(7.2).toFixed(8), status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: moto, quantity: "10", unitPrice: "6500" }, { variantId: tyre, quantity: "100", unitPrice: "95" }, { variantId: oil, quantity: "300", unitPrice: "18.5" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-20", userId));
    const pay = async (date: string, cnyRate: Decimal) => {
      const before = (await reports.partyStatement(db, supplierId)).foreign[0];
      const preview = paymentSplit({ usd: D(1000), francs: null, rate: null, owedUsd: D(0), owedFc: D(0), owedCny: D(before.native).abs(), cnyRate });
      await db.transaction((tx) => ops.payParty(tx, { date, partyId: supplierId, accountId: cashUsd, amount: "1000" }, userId));
      const booked = (await reports.partyStatement(db, supplierId)).rows.at(-1)!;
      return { preview: preview.find((p) => p.kind === "cny"), booked: { usd: booked.debit, native: booked.nativeAmount } };
    };
    // First the dollars owed: 13 000 $ settle 10 450 $, then 2 550 $ of yuan: 18 360,01 ¥ at the invoices' own rate.
    const st = (await reports.partyStatement(db, supplierId)).foreign[0];
    const invoices = D(st.native).abs().dividedBy(D(st.usd).abs());
    const split = paymentSplit({ usd: D(13000), francs: null, rate: null, owedUsd: D(10450), owedFc: D(0), owedCny: D(st.native).abs(), cnyRate: invoices });
    await db.transaction((tx) => ops.payParty(tx, { date: "2026-08-21", partyId: supplierId, accountId: cashUsd, amount: "13000" }, userId));
    const last = (await reports.partyStatement(db, supplierId)).rows.slice(-2);
    const cnyRow = last.find((r) => r.currency === "CNY")!;
    expect(split).toEqual([{ kind: "usd", usd: "10450.00" }, { kind: "cny", usd: cnyRow.debit, native: cnyRow.nativeAmount }]);
    expect(cnyRow.nativeAmount).toBe("18360.01");
    // Without a yuan rate on file, the invoices' rate; with one (7,2), that rate: the preview is the booking both times.
    const ref = () => reports.partyStatement(db, supplierId).then((s) => D(s.foreign[0].native).abs().dividedBy(D(s.foreign[0].usd).abs()));
    const a = await pay("2026-08-22", await ref());
    expect(a.preview).toEqual({ kind: "cny", ...a.booked });
    await db.insert(exchangeRates).values({ date: "2026-08-23", cdfPerUsd: "2808", cnyPerUsd: "7.2" });
    const b = await pay("2026-08-23", D("7.2"));
    expect(b.preview).toEqual({ kind: "cny", usd: "1000.00", native: "7200.00" });
    expect(b.preview).toEqual({ kind: "cny", ...b.booked });
  });

  it("shows the cost per unit the stock value was recorded at, not the value divided back", async () => {
    // 2,25 L at 0,125 $ are kept as 0,28 $: divided back, 0,1244 $.
    const fluid = await product("Huile de frein U21", "3", "litre");
    await opening(fluid, "2.25", "0.125");
    const val = await reports.stockValuation(db);
    expect(val.items.find((i) => i.variantId === fluid)).toMatchObject({ qty: "2.250", value: "0.28", avgCost: "0.125000" });
    expect(val.reconciled).toBe(true);
    // The roundest figure that gives the value back to the cent; value ÷ qty when none does.
    expect(reports.shownUnitCost("21960.99", "20").toString()).toBe("1098.0495");
    expect(reports.shownUnitCost("25", "200").toString()).toBe("0.125");
    expect(reports.shownUnitCost("13176.59", "12").toString()).toBe("1098.049");
    expect(reports.shownUnitCost("1234.57", "1000").toFixed(6)).toBe("1.234570");
    expect(reports.shownUnitCost("0", "5").toString()).toBe("0");
  });

  it("names the advances on the balance sheet without a second bracket", async () => {
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-08-04", partyId: customerId, accountId: cashUsd, amount: "23" }, userId));
    const bs = await reports.balanceSheet(db);
    expect(bs.liabilities.map((l) => l.name)).toContain("Avances reçues des clients");
    expect(bs.liabilities.some((l) => /\) \(/.test(l.name))).toBe(false);
    expect(bs.balanced).toBe(true);
  });

  it("takes a credit-sale return off the debt up to what is owed and keeps the rest as an avoir", async () => {
    // S-000034: 28 $, 23 $ from the avoir (above), 5 $ on credit.
    const tyre = await product("Pneu 3.00-17", "22", "pcs");
    const brake = await product("Huile de frein", "6", "pcs");
    await opening(tyre, "5", "12");
    await opening(brake, "5", "3");
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-05", locationId, customerId, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }, { variantId: brake, qty: "1", unitPrice: "6" }], payments: [] }, userId));
    expect(await balanceOf(customerId)).toBe("5.00");
    const tyreLine = sale.lines.find((l) => l.variantId === tyre)!;
    await db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-05", reason: "Mauvaise taille", refundAccountId: null, lines: [{ saleLineId: tyreLine.id, qty: "1" }] }, userId));
    // The dialog's split: min(22, 5) = 5 $ off the debt, the other 17 $ an avoir.
    expect(await balanceOf(customerId)).toBe("-17.00");
  });

  it("settles a sale paid with the francs asked in 100 FC notes, a few francs over or under", async () => {
    const item = await product("Casque", "22", "pcs");
    await opening(item, "10", "10");
    // 22 $ at 2 808 is 61 776 FC: "Tout en espèces FC" asks 61 800 FC, 24 FC over; 22,01 $ (61 804 FC) asks 61 800 FC, 4 FC under.
    for (const [price, francs] of [["22", "61800"], ["22.01", "61800"], ["27.35", "76800"]]) {
      const s = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-06", locationId, lines: [{ variantId: item, qty: "1", unitPrice: price }], payments: [{ accountId: cashCdf, amount: francs }] }, userId));
      expect(s.creditUsd).toBe("0.00");
      expect(D(s.paidUsd).minus(price).abs().lte(D(100).dividedBy(2808))).toBe(true);
    }
  });
});
