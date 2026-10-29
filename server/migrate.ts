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
  // A fresh installation starts with company 1. Once the original company has been
  // deliberately deleted, other companies remain in the directory and it must NOT
  // be recreated at the next deployment or server restart.
  await pool.query(
    "INSERT INTO public.companies(id, name, status) SELECT 1, 'Huanghe Motors Kalemie', 'ready' WHERE NOT EXISTS (SELECT 1 FROM public.companies) ON CONFLICT(id) DO NOTHING",
  );
  await pool.query(`
    SELECT setval('public.companies_id_seq',
      GREATEST((SELECT last_value FROM public.companies_id_seq), COALESCE((SELECT max(id) FROM public.companies), 1)), true)
  `);

  // Directory management is granted to the original owners and to the owners
  // provisioned into their other companies. Store this permission outside the
  // original company's business tables so it survives deletion of company 1.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.company_managers (
      company_id INTEGER NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (company_id, user_id)
    )
  `);
  const original = await pool.query("SELECT id FROM public.companies WHERE id=1 AND status='ready'");
  if (original.rowCount) {
    await pool.query(`
      INSERT INTO public.company_managers(company_id, user_id)
      SELECT 1, id FROM public.users WHERE role='owner'
      ON CONFLICT DO NOTHING
    `);
    // Existing installations already have companies created before the manager
    // registry existed. Their initial owners were cloned from an original owner;
    // match by username for the one-time upgrade/backfill.
    const owners = await pool.query<{ username: string }>("SELECT username FROM public.users WHERE role='owner'");
    if (owners.rows.length) {
      const tenants = await pool.query<{ id: number }>(
        "SELECT id FROM public.companies WHERE status='ready' AND id>1",
      );
      for (const tenant of tenants.rows) {
        const tenantId = tenant.id;
        if (!Number.isSafeInteger(tenantId) || tenantId < 2) continue;
        await pool.query(`
          INSERT INTO public.company_managers(company_id, user_id)
          SELECT $1, id FROM "company_${tenantId}".users
          WHERE role='owner' AND username = ANY($2::text[])
          ON CONFLICT DO NOTHING
        `, [tenantId, owners.rows.map((row) => row.username)]);
      }
    }
  }
}
