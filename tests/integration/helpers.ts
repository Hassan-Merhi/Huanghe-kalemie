import { sql } from "drizzle-orm";
import { db, forgetCompany, type Db } from "../../server/db";
import { runMigrations } from "../../server/migrate";
import { ensureSetup } from "../../server/setup";
import { clearLedgerCache } from "../../server/services/ledger";

export const hasDb = !!process.env.TEST_DATABASE_URL;

export async function resetDatabase(): Promise<Db> {
  const oldTenants = (await db.execute<{ schema_name: string }>(
    sql`select schema_name from information_schema.schemata where schema_name ~ '^company_[0-9]+$'`
  )).rows;
  for (const row of oldTenants) {
    forgetCompany(Number(row.schema_name.slice("company_".length)));
    await db.execute(sql`drop schema if exists ${sql.identifier(row.schema_name)} cascade`);
  }
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  clearLedgerCache();
  await db.transaction((tx) => ensureSetup(tx, { ownerPassword: "test-password-123" }));
  return db;
}
