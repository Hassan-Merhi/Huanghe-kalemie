import { beforeAll, describe, expect, it } from "vitest";
import { accounts, containers, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

describe.skipIf(!hasDb)("Containers and currencies", async () => {
  const catalog = await import("../../server/services/catalog");
  const svc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const reports = await import("../../server/services/reports");
  const userId = 1;
  let db: Db;
  let cashUsd: number, cashCdf: number, supplierId: number, locationId: number, oil: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Chongqing supplier" }).returning();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    const p = await db.transaction((tx) => catalog.createProduct(tx, { name: "Engine oil", unit: "litre", variants: [{ attributes: { Size: "1L" }, sellPrice: "4" }] }));
    oil = p.variants[0].id;
    // Starting cash: 1,000 USD and 2,800,000 CDF.
    await db.transaction((tx) =>
      ops.manualJournal(
        tx,
        {
          date: "2026-08-01",
          memo: "Opening cash",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "1000" },
            { accountId: cashCdf, debit: "1000", nativeAmount: "2800000", rate: "2800" },
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "2000" },
          ],
        },
        userId,
      ),
    );
  });

  it("costs a CNY invoice with a CDF expense in USD", async () => {
    const [c] = await db.insert(containers).values({ number: "CNY-1", supplierId, locationId, currency: "CNY", rateToUsd: "0.14", status: "arrived" }).returning();
    await db.transaction((tx) => svc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "1000", unitPrice: "10" }]));
    // 280,000 CDF at 2,800 = $100 of local transport.
    await db.transaction((tx) => svc.addExpense(tx, c.id, { date: "2026-08-05", type: "transport", amount: "280000", currency: "CDF", rate: "2800", method: "value", paidFromAccountId: cashCdf }, userId));
    const result = await db.transaction((tx) => svc.finalizeContainer(tx, c.id, "2026-08-06", userId));
    expect(result.fobTotalUsd).toBe("1400.00");
    expect(result.landedTotalUsd).toBe("1500.00");
    expect(result.lines[0].landedUnitCost).toBe("1.500000");
    const bal = await reports.accountBalances(db);
    expect(bal.find((b) => b.id === cashCdf)!.nativeBalance).toBe("2520000.00");
    expect((await reports.partyStatement(db, supplierId)).balance).toBe("-1400.00");
  });

  it("reverses an offload while its stock is all there, then offloads again", async () => {
    const [c] = await db.select().from(containers);
    await db.transaction((tx) => svc.reverseContainer(tx, c.id, "2026-08-07", userId));
    let tb = await reports.trialBalance(db);
    expect(tb.balanced).toBe(true);
    const transit = tb.rows.find((r) => r.systemKey === "goods_in_transit");
    expect(transit?.balance).toBe("100.00"); // the paid expense waits in transit again
    expect(tb.rows.find((r) => r.systemKey === "inventory")).toBeUndefined();
    expect((await reports.partyStatement(db, supplierId)).balance).toBe("0.00");

    await db.transaction((tx) => svc.finalizeContainer(tx, c.id, "2026-08-08", userId));
    tb = await reports.trialBalance(db);
    expect(tb.rows.find((r) => r.systemKey === "inventory")?.balance).toBe("1500.00");
    expect((await reports.stockValuation(db)).reconciled).toBe(true);
  });

  it("values francs bought with dollars at the dollars paid", async () => {
    // $100 changed for 275,000 CDF: the francs cost $100, so there is no gain or loss yet.
    await db.transaction((tx) =>
      ops.transferMoney(tx, { date: "2026-08-10", fromAccountId: cashUsd, fromAmount: "100", toAccountId: cashCdf, toAmount: "275000", rate: "2800" }, userId),
    );
    const bal = await reports.accountBalances(db);
    expect(bal.find((b) => b.systemKey === "fx")?.balance ?? "0.00").toBe("0.00");
    expect(bal.find((b) => b.id === cashCdf)).toMatchObject({ nativeBalance: "2795000.00", balance: "1000.00" });
    expect((await reports.trialBalance(db)).balanced).toBe(true);
  });

  it("refuses a weight split when lines have no weight", async () => {
    const [c] = await db.insert(containers).values({ number: "W-1", supplierId, locationId, status: "arrived" }).returning();
    await db.transaction((tx) => svc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "10", unitPrice: "1" }]));
    await db.transaction((tx) => svc.addExpense(tx, c.id, { date: "2026-08-11", type: "freight", amount: "10", currency: "USD", method: "weight", paidFromAccountId: cashUsd }, userId));
    await expect(db.transaction((tx) => svc.finalizeContainer(tx, c.id, "2026-08-12", userId))).rejects.toThrow(/weight/);
  });
});
