import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { accounts, containers, locations, parties, sales, variants } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A1: the holes found in the audit that could change money or stock silently. */
describe.skipIf(!hasDb)("Money leaks", async () => {
  const catalog = await import("../../server/services/catalog");
  const containersSvc = await import("../../server/services/containers");
  const ops = await import("../../server/services/operations");
  const salesSvc = await import("../../server/services/sales");
  const periods = await import("../../server/services/periods");
  const reports = await import("../../server/services/reports");
  const { createApp } = await import("../../server/index");
  const userId = 1;
  let db: Db;
  let cashUsd: number, rent: number, supplierId: number, locationId: number, oil: number, plug: number;
  let server: Server;

  beforeAll(async () => {
    db = await resetDatabase();
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    rent = accs.find((a) => a.code === "6000")!.id;
    [{ id: supplierId }] = await db.insert(parties).values({ type: "supplier", name: "Chongqing" }).returning();
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    oil = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Huile", unit: "litre", variants: [{ attributes: {}, sellPrice: "4" }] }))).variants[0].id;
    plug = (await db.transaction((tx) => catalog.createProduct(tx, { name: "Bougie", variants: [{ attributes: {}, sellPrice: "3" }] }))).variants[0].id;
    await db.transaction((tx) =>
      ops.manualJournal(tx, { date: "2026-08-01", memo: "Ouverture", type: "opening", lines: [{ accountId: cashUsd, debit: "5000" }, { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "5000" }] }, userId),
    );
  });

  afterAll(() => server?.close());

  it("refuses to undo an offload once its goods were sold, even after a restock", async () => {
    const [c] = await db.insert(containers).values({ number: "C-1", supplierId, locationId, currency: "USD", rateToUsd: "1", status: "arrived" }).returning();
    await db.transaction((tx) => containersSvc.replaceLines(tx, c.id, [{ variantId: oil, quantity: "10", unitPrice: "2" }]));
    await db.transaction((tx) => containersSvc.finalizeContainer(tx, c.id, "2026-08-05", userId));
    await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-06", locationId, lines: [{ variantId: oil, qty: "4", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "16" }] }, userId));
    // Found stock brings the quantity back up, so a quantity check alone would let it through.
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-07", locationId, kind: "found", reason: "Trouvé", lines: [{ variantId: oil, qtyChange: "4", unitCost: "5" }] }, userId));
    await expect(db.transaction((tx) => containersSvc.reverseContainer(tx, c.id, "2026-08-08", userId))).rejects.toThrow(/since this offload/);
    expect((await reports.partyStatement(db, supplierId)).balance).toBe("-20.00");
    expect((await reports.stockValuation(db)).reconciled).toBe(true);
  });

  it("refuses the same sale line twice on one return and a return dated before the sale", async () => {
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-10", locationId, lines: [{ variantId: oil, qty: "2", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "8" }] }, userId));
    const line = sale.lines[0];
    await expect(
      db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-11", lines: [{ saleLineId: line.id, qty: "2" }, { saleLineId: line.id, qty: "2" }], refundAccountId: cashUsd, reason: "x" }, userId)),
    ).rejects.toThrow(/twice/);
    await expect(
      db.transaction((tx) => salesSvc.returnSale(tx, sale.id, { date: "2026-08-09", lines: [{ saleLineId: line.id, qty: "1" }], refundAccountId: cashUsd, reason: "x" }, userId)),
    ).rejects.toThrow(/before the sale/);
    expect((await reports.stockValuation(db)).reconciled).toBe(true);
  });

  it("refuses quantities with more than 3 decimals", async () => {
    await expect(db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-08-12", locationId, lines: [{ variantId: oil, qty: "0.0004", unitPrice: "4" }], payments: [] }, userId))).rejects.toThrow(/3 decimals/);
    await expect(
      db.transaction((tx) => ops.adjustStock(tx, { date: "2026-08-12", locationId, kind: "found", reason: "x", lines: [{ variantId: oil, qtyChange: "1.0001", unitCost: "1" }] }, userId)),
    ).rejects.toThrow(/3 decimals/);
  });

  it("keeps an item with stock active and in the valuation", async () => {
    await expect(db.transaction((tx) => catalog.updateVariant(tx, oil, { active: false }))).rejects.toThrow(/still has stock/);
    const [v] = await db.select().from(variants).where(eq(variants.id, oil));
    await expect(db.transaction((tx) => catalog.updateProduct(tx, v.productId, { active: false }))).rejects.toThrow(/still has stock/);
    // An item without stock can be deactivated.
    await db.transaction((tx) => catalog.updateVariant(tx, plug, { active: false }));
    expect((await reports.stockValuation(db)).reconciled).toBe(true);
  });

  it("locks every date up to the last closed month, not only that month", async () => {
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-09-03", accountId: rent, description: "Loyer", amount: "100", paidFromAccountId: cashUsd }, userId));
    await db.transaction((tx) => periods.closePeriod(tx, "2026-08", userId));
    await db.transaction((tx) => periods.closePeriod(tx, "2026-09", userId));
    await expect(db.transaction((tx) => periods.reopenPeriod(tx, "2026-08", userId))).rejects.toThrow(/latest/);
    await db.transaction((tx) => periods.reopenPeriod(tx, "2026-09", userId));
    // August is still closed, so a September posting is fine but an August one is not.
    await db.transaction((tx) => ops.createExpense(tx, { date: "2026-09-04", accountId: rent, description: "Eau", amount: "10", paidFromAccountId: cashUsd }, userId));
    await expect(db.transaction((tx) => ops.createExpense(tx, { date: "2026-08-30", accountId: rent, description: "x", amount: "1", paidFromAccountId: cashUsd }, userId))).rejects.toThrow(/closed/);
    // Before the first closed month is locked too.
    await expect(db.transaction((tx) => ops.createExpense(tx, { date: "2026-07-15", accountId: rent, description: "x", amount: "1", paidFromAccountId: cashUsd }, userId))).rejects.toThrow(/closed/);
  });

  it("records one sale when the same submit arrives twice", async () => {
    const app = await createApp();
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "test-password-123" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const before = (await db.select().from(sales)).length;
    const send = () =>
      fetch(base + "/api/sales", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "idempotency-key": "test-key-0001" },
        body: JSON.stringify({ date: "2026-09-10", locationId, lines: [{ variantId: oil, qty: "1", unitPrice: "4" }], payments: [{ accountId: cashUsd, amount: "4" }] }),
      });
    const [a, b] = await Promise.all([send(), send()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    const c = await send();
    expect(c.status).toBe(201);
    expect((await c.json()).id).toBeDefined();
    expect((await db.select().from(sales)).length).toBe(before + 1);
  });
});
