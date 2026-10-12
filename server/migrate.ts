import path from "path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./db";

export async function runMigrations(db: Db) {
  const folder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");
  await migrate(db, { migrationsFolder: folder });
}
