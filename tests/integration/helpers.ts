import { sql } from "drizzle-orm";
import { db, type Db } from "../../server/db";
import { runMigrations } from "../../server/migrate";
import { ensureSetup } from "../../server/setup";
import { clearLedgerCache } from "../../server/services/ledger";

export const hasDb = !!process.env.TEST_DATABASE_URL;

export async function resetDatabase(): Promise<Db> {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  clearLedgerCache();
  await db.transaction((tx) => ensureSetup(tx, { ownerPassword: "test-password-123" }));
  return db;
}
