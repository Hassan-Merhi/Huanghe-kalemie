import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, auditLog, journals, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Reports that must agree with the ledger, the activity log, the self-check and customer ageing. */
describe.skipIf(!hasDb)("Reports that always agree", async () => {
  const catalog = await import("../../server/services/catalog");
  const salesSvc = await import("../../server/services/sales");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const checks = await import("../../server/services/checks");
  const userId = 1;
  let db: Db;
  let locationId: number, cashUsd: number, customerId: number, padsId: number;
  let saleIds: number[] = [];

  beforeAll(async () => {
    db = await resetDatabase();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Garage Tanganyika", phone: "0990000000" }).returning();
    const pads = await db.transaction((tx) => catalog.createProduct(tx, { name: "Plaquettes", variants: [{ attributes: { Position: "Avant" }, sellPrice: "10" }] }));
    padsId = pads.variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-07-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: padsId, qtyChange: "100", unitCost: "4" }] }, userId));
    // July: three sales, one on credit.
    for (const [date, qty, credit] of [["2026-07-05", "3", false], ["2026-07-10", "2", true], ["2026-07-20", "5", false]] as const) {
      const sale = await db.transaction((tx) =>
        salesSvc.createSale(
          tx,
          { date, locationId, customerId: credit ? customerId : null, lines: [{ variantId: padsId, qty, unitPrice: "10" }], payments: credit ? [] : [{ accountId: cashUsd, amount: String(Number(qty) * 10) }] },
          userId,
        ),
      );
      saleIds.push(sale.id);
    }
    // August: the 20 July sale is cancelled and 1 pad of the 5 July sale comes back.
    await db.transaction((tx) => salesSvc.voidSale(tx, saleIds[2], "2026-08-03", "Erreur de saisie", userId));
    const first = await salesSvc.getSale(db, saleIds[0]);
    await db.transaction((tx) => salesSvc.returnSale(tx, saleIds[0], { date: "2026-08-04", refundAccountId: cashUsd, reason: "Défaut", lines: [{ saleLineId: first.lines[0].id, qty: "1" }] }, userId));
  });

  it("counts sales, cancellations and returns on their own dates, like the P&L", async () => {
    for (const [from, to] of [["2026-07-01", "2026-07-31"], ["2026-08-01", "2026-08-31"], ["2026-07-01", "2026-08-31"]]) {
      const items = await reports.salesByProduct(db, from, to);
      const pnl = await reports.profitAndLoss(db, from, to);
      const sales = pnl.accounts.find((a) => a.code === "4000")?.amount ?? "0.00";
      const cogs = pnl.accounts.find((a) => a.code === "5000")?.amount ?? "0.00";
      const revenue = items.reduce((s, i) => s + Number(i.revenue), 0).toFixed(2);
      const cost = items.reduce((s, i) => s + Number(i.cogs), 0).toFixed(2);
      expect([from, revenue, cost]).toEqual([from, sales, cogs]);
    }
    const july = await reports.salesByProduct(db, "2026-07-01", "2026-07-31");
    expect(july[0].qty).toBe("10.000");
    const august = await reports.salesByProduct(db, "2026-08-01", "2026-08-31");
    expect(august[0].qty).toBe("-6.000");
    expect(august[0].revenue).toBe("-60.00");
  });

  it("writes one activity entry per posting, in the same transaction", async () => {
    const js = await db.select().from(journals);
    const logged = await db.select().from(auditLog).where(eq(auditLog.action, "post"));
    const reversed = await db.select().from(auditLog).where(eq(auditLog.action, "reverse"));
    expect(logged.length + reversed.length).toBe(js.length);
    const voidEntry = reversed.find((r) => r.entity === "sale_void")!;
    expect((voidEntry.data as { date: string }).date).toBe("2026-08-03");
    // A posting that fails leaves no log entry behind.
    const before = (await db.select().from(auditLog)).length;
    await expect(
      db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-10", locationId, lines: [{ variantId: padsId, qty: "1000", unitPrice: "10" }], payments: [] }, userId)),
    ).rejects.toThrow();
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("passes the self-check, and shows a planted difference", async () => {
    const ok = await checks.selfCheck(db);
    expect(ok.checks.filter((c) => !c.ok)).toEqual([]);
    // A line posted to receivables without a contact breaks the contact check.
    const receivables = (await db.select().from(accounts).where(eq(accounts.systemKey, "receivables")))[0].id;
    const other = (await db.select().from(accounts).where(eq(accounts.systemKey, "other_income")))[0].id;
    const [j] = await db.insert(journals).values({ number: "J-TEST", date: "2026-08-20", type: "manual" }).returning();
    await db.execute(
      `insert into journal_lines (journal_id, account_id, debit, credit) values (${j.id}, ${receivables}, 7, 0), (${j.id}, ${other}, 0, 7)` as never,
    );
    const bad = await checks.selfCheck(db);
    const rec = bad.checks.find((c) => c.key === "receivables")!;
    expect(rec.ok).toBe(false);
    expect(rec.difference).toBe("-7.00");
    await db.execute(`delete from journal_lines where journal_id = ${j.id}` as never);
    await db.delete(journals).where(eq(journals.id, j.id));
  });

  it("ages what customers owe, clearing the oldest first", async () => {
    // The customer owes 20 from 10 July; pays 5, then buys 15 more on 1 October.
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: "2026-09-01", partyId: customerId, accountId: cashUsd, amount: "5" }, userId));
    await db.transaction((tx) =>
      salesSvc.createSale(tx, { date: "2026-10-01", locationId, customerId, lines: [{ variantId: padsId, qty: "1.5", unitPrice: "10" }], payments: [] }, userId),
    );
    const a = await checks.customerAgeing(db, "2026-10-15");
    expect(a.rows).toHaveLength(1);
    const r = a.rows[0];
    expect(r.balance).toBe("30.00");
    expect(r.current).toBe("15.00");
    expect(r.over90).toBe("15.00");
    expect(r.oldestDate).toBe("2026-07-10");
    expect(a.totals.balance).toBe("30.00");
  });
});
