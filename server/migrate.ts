import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, type Db } from "./db";

/**
 * Original shop lives in public; new shops have their own PostgreSQL schema.
 * A tenant gets a copy of the same migrations with explicit public references
 * redirected, so indexes, foreign keys and journal sequences stay inside it.
 */
export async function runMigrations(database: Db, companyId = 1) {
  const folder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");
  if (companyId === 1) {
    await migrate(database, { migrationsFolder: folder });
    await ensureCompanyDirectory();
    return;
  }

  const name = `company_${companyId}`;
  if (!Number.isSafeInteger(companyId) || companyId < 2) throw new Error("Invalid company schema");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hk-company-migrations-"));
  try {
    fs.mkdirSync(path.join(dir, "meta"));
    fs.copyFileSync(path.join(folder, "meta", "_journal.json"), path.join(dir, "meta", "_journal.json"));
    for (const filename of fs.readdirSync(folder).filter((file) => /^\d+.*\.sql$/.test(file))) {
      // All tenant foreign keys must point at tenant tables, never at public.
      const sql = fs.readFileSync(path.join(folder, filename), "utf8")
        .replaceAll('"public".', `"${name}".`)
        .replaceAll("public.", `${name}.`);
      fs.writeFileSync(path.join(dir, filename), sql);
    }
    await migrate(database, { migrationsFolder: dir, migrationsSchema: name });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function ensureCompanyDirectory() {
  // This registry is deliberately global and never included in company backups.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.companies (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'ready'
        CHECK (status IN ('provisioning', 'ready')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "INSERT INTO public.companies(id, name, status) VALUES(1, 'Huanghe Motors Kalemie', 'ready') ON CONFLICT(id) DO NOTHING",
  );
  await pool.query(`
    SELECT setval('public.companies_id_seq',
      GREATEST((SELECT last_value FROM public.companies_id_seq), (SELECT max(id) FROM public.companies)), true)
  `);
}
