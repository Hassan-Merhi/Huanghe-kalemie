import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { accounts, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** A full backup rebuilds the shop exactly, on a new database or over the old one, or changes nothing. */
describe.skipIf(!hasDb)("Backup and restore", async () => {
  const catalog = await import("../../server/services/catalog");
  const salesSvc = await import("../../server/services/sales");
  const ops = await import("../../server/services/operations");
  const backup = await import("../../server/services/backup");
  const checks = await import("../../server/services/checks");
  const { checkPassword } = await import("../../server/auth");
  const userId = 1;
  let db: Db;
  let file = "";
  let before: Awaited<ReturnType<typeof backup.totalsOf>>;

  async function shop() {
    const [{ id: locationId }] = await db.select().from(locations).limit(1);
    const cashUsd = (await db.select().from(accounts)).find((a) => a.systemKey === "cash_usd")!.id;
    const [{ id: customerId }] = await db.insert(parties).values({ type: "customer", name: "Garage Tanganyika" }).returning();
    const pads = await db.transaction((tx) => catalog.createProduct(tx, { name: "Plaquettes", variants: [{ attributes: { Position: "Avant" }, sellPrice: "10" }] }));
    const variantId = pads.variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, { date: "2026-07-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "50", unitCost: "4.3333" }] }, userId));
    await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-07-05", locationId, lines: [{ variantId, qty: "3", unitPrice: "10" }], payments: [{ accountId: cashUsd, amount: "30" }] }, userId));
    await db.transaction((tx) => salesSvc.createSale(tx, { date: "2026-07-06", locationId, customerId, lines: [{ variantId, qty: "2", unitPrice: "10" }], payments: [] }, userId));
    return { locationId, variantId, cashUsd };
  }

  beforeAll(async () => {
    db = await resetDatabase();
    await shop();
    before = await backup.totalsOf(db);
    file = await backup.takeSnapshot();
  });

  it("refuses to restore over a shop that has data unless asked to replace it", async () => {
    await expect(db.transaction((tx) => backup.restore(tx, backup.parseBackup(file), { replace: false }))).rejects.toThrow(/déjà|already/i);
  });

  it("rebuilds a new database exactly: totals, checks, users and numbering", async () => {
    db = await resetDatabase();
    expect(await backup.isEmptyShop(db)).toBe(true);
    const result = await db.transaction((tx) => backup.restore(tx, backup.parseBackup(file), { replace: false }));
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(await backup.totalsOf(db)).toEqual(before);
    expect((await checks.selfCheck(db)).ok).toBe(true);
    // The owner signs in with the password from the backed-up shop.
    await expect(checkPassword(userId, "test-password-123")).resolves.toBeUndefined();
    // New records continue the numbering instead of colliding with restored ones.
    const [{ id: locationId }] = await db.select().from(locations).limit(1);
    const [{ variant_id }] = (await db.execute<{ variant_id: number }>(sql`select variant_id from stock_levels limit 1`)).rows;
    const cashUsd = (await db.select().from(accounts)).find((a) => a.systemKey === "cash_usd")!.id;
    const sale = await db.transaction((tx) =>
      salesSvc.createSale(tx, { date: "2026-07-07", locationId, lines: [{ variantId: variant_id, qty: "1", unitPrice: "10" }], payments: [{ accountId: cashUsd, amount: "10" }] }, userId),
    );
    expect(sale.id).toBe(3);
  });

  it("replaces everything when asked, and keeps the exact cost figures", async () => {
    const result = await db.transaction((tx) => backup.restore(tx, backup.parseBackup(file), { replace: true }));
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(await backup.totalsOf(db)).toEqual(before);
  });

  it("changes nothing when the file does not add up", async () => {
    const tampered = JSON.parse(file);
    tampered.tables.journal_lines.pop();
    const now = await backup.totalsOf(db);
    await expect(db.transaction((tx) => backup.restore(tx, tampered, { replace: true }))).rejects.toThrow(/ne correspondent pas|does not match/);
    expect(await backup.totalsOf(db)).toEqual(now);
  });

  it("keeps one daily snapshot per day that restores like a download", async () => {
    await backup.ensureDailySnapshot();
    await backup.ensureDailySnapshot();
    const list = await backup.listSnapshots();
    expect(list.filter((s) => s.kind === "daily")).toHaveLength(1);
    const row = await backup.snapshotFile(list[0].id);
    const parsed = backup.parseBackup(row.data);
    expect(parsed.totals).toEqual(before);
  });
});
