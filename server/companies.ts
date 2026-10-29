import { randomBytes } from "node:crypto";
import type { Express, Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users, settings } from "@shared/schema";
import { requireRole } from "./auth";
import { db, forgetCompany, isolatedDb, pool } from "./db";
import { AppError, badRequest, notFound } from "./errors";
import { asyncHandler } from "./http";
import { runMigrations } from "./migrate";
import { ensureSetup } from "./setup";

/**
 * Every non-original company owns a complete PostgreSQL schema. Foreign keys,
 * balances, users, vouchers, backups and the entire accounting ledger are isolated.
 * The only shared table is the company directory in public.
 */
interface CompanyRow { id: number; name: string; status: string; created_at: Date }

const businessTables = [
  "exchange_rates", "products", "variants", "stock_levels", "stock_movements",
  "motorcycle_units", "parties", "journals", "journal_lines", "periods",
  "expenses", "containers", "container_lines", "container_expenses",
  "sales", "sale_lines", "sale_payments", "sale_returns",
  "sale_return_lines", "stock_adjustments", "voucher_drafts", "payroll_runs",
] as const;

const companySchema = (id: number) => {
  if (!Number.isSafeInteger(id) || id < 1) throw badRequest("Invalid company", "Entreprise invalide");
  return id === 1 ? "public" : `company_${id}`;
};

// All business tables in the public schema (company 1). Leave the directory,
// its manager grants, and the shared session store untouched. If future
// migrations add a table, fail closed until this explicit allowlist is updated.
const originalTables = new Set([
  "users", "settings", "exchange_rates", "counters", "idempotency_keys",
  "audit_log", "locations", "categories", "products", "variants",
  "stock_levels", "stock_movements", "motorcycle_units", "parties",
  "accounts", "journals", "journal_lines", "partners", "periods",
  "expenses", "containers", "container_lines", "container_expenses",
  "sales", "sale_lines", "sale_payments", "sale_returns",
  "sale_return_lines", "stock_adjustments", "voucher_drafts",
  "payroll_runs", "backups",
]);
const sharedTables = new Set(["companies", "company_managers", "user_sessions"]);

const nameSchema = z.object({ name: z.string().trim().min(1).max(120) });
const deleteSchema = z.object({ name: z.string(), force: z.boolean().default(false) });

async function directory(): Promise<CompanyRow[]> {
  const r = await pool.query<CompanyRow>(
    "SELECT id,name,status,created_at FROM public.companies WHERE status='ready' ORDER BY id",
  );
  return r.rows;
}

async function company(id: number): Promise<CompanyRow> {
  const r = await pool.query<CompanyRow>(
    "SELECT id,name,status,created_at FROM public.companies WHERE id=$1 AND status='ready'", [id],
  );
  if (!r.rows[0]) throw notFound("Company", "Entreprise introuvable");
  return r.rows[0];
}

async function companyManager(req: Request): Promise<boolean> {
  if (!req.user || req.user.role !== "owner") return false;
  const result = await pool.query(
    "SELECT 1 FROM public.company_managers WHERE company_id=$1 AND user_id=$2",
    [req.user.companyId, req.user.id],
  );
  return (result.rowCount ?? 0) > 0;
}

async function requireCompanyManager(req: Request) {
  if (!(await companyManager(req))) {
    throw new AppError(403, "Only an authorized company owner can manage companies",
      "COMPANY_MANAGER_REQUIRED", "Seul un propriétaire autorisé peut gérer les entreprises");
  }
}

function countsSql(schema: string) {
  return businessTables.map((name) =>
    `(SELECT count(*)::int FROM "${schema}"."${name}") AS "${name}"`
  ).join(", ");
}

async function impact(id: number) {
  const schema = companySchema(id);
  const results = await pool.query<Record<string, number>>(`SELECT ${countsSql(schema)}`);
  const counts = results.rows[0] ?? {};
  return { counts, records: Object.values(counts).reduce((total, n) => total + Number(n), 0) };
}

/** Sign-in's public company chooser; no business records or passwords are returned. */
export async function publicCompanies() {
  return (await directory()).map(({ id, name }) => ({ id, name }));
}

export function registerCompanyRoutes(app: Express) {
  app.get("/api/companies/permissions", requireRole(), asyncHandler(async (req, res) => {
    res.json({ canManage: await companyManager(req) });
  }));

  app.get("/api/companies", requireRole(), asyncHandler(async (req, res) => {
    await requireCompanyManager(req);
    res.json((await directory()).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, isOriginal: r.id === 1 })));
  }));

  app.get("/api/companies/:id/impact", requireRole(), asyncHandler(async (req, res) => {
    await requireCompanyManager(req);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const row = await company(id);
    res.json({ id, name: row.name, ...await impact(id) });
  }));

  app.post("/api/companies", requireRole(), asyncHandler(async (req, res) => {
    await requireCompanyManager(req);
    const { name } = nameSchema.parse(req.body);
    const owner = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!owner[0] || owner[0].role !== "owner") throw new AppError(403, "Owner required", "FORBIDDEN", "Propriétaire requis");
    const exists = await pool.query("SELECT id FROM public.companies WHERE lower(name)=lower($1)", [name]);
    if (exists.rowCount) throw new AppError(409, "Company name already exists", "COMPANY_EXISTS", "Cette entreprise existe déjà");

    // Reserve the directory row first. A failed setup remains invisible to login.
    const created = await pool.query<CompanyRow>(
      "INSERT INTO public.companies(name,status) VALUES($1,'provisioning') RETURNING id,name,status,created_at", [name],
    );
    const row = created.rows[0];
    const schema = companySchema(row.id);
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await runMigrations(isolatedDb(row.id), row.id);
      await isolatedDb(row.id).transaction(async (tx) => {
        await ensureSetup(tx, {
          ownerUsername: owner[0].username,
          ownerPassword: randomBytes(36).toString("hex"),
          locationName: name,
        });
        await tx.update(users).set({
          passwordHash: owner[0].passwordHash,
          fullName: owner[0].fullName,
          language: owner[0].language,
        }).where(eq(users.username, owner[0].username));
      });
      // Give the new company its own receipt / shop name.
      await isolatedDb(row.id).update(settings).set({ value: name, updatedAt: new Date() }).where(eq(settings.key, "shopName"));
      const [newOwner] = await isolatedDb(row.id).select({ id: users.id })
        .from(users).where(eq(users.username, owner[0].username));
      if (!newOwner) throw new Error("New company owner was not created");
      await pool.query(
        "INSERT INTO public.company_managers(company_id,user_id) VALUES($1,$2)",
        [row.id, newOwner.id],
      );
      await pool.query("UPDATE public.companies SET status='ready' WHERE id=$1", [row.id]);
    } catch (error) {
      forgetCompany(row.id);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.query("DELETE FROM public.companies WHERE id=$1", [row.id]);
      throw error;
    }
    res.status(201).json({ id: row.id, name: row.name });
  }));

  // POST rather than DELETE: the user must send the exact name and explicitly
  // opt in to wiping business records, including for the original company.
  app.post("/api/companies/:id/delete", requireRole(), asyncHandler(async (req, res) => {
    await requireCompanyManager(req);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = deleteSchema.parse(req.body);
    if (req.user!.companyId === id) {
      throw new AppError(409, "Switch to another company before deleting the current one",
        "ACTIVE_COMPANY", "Changez d'entreprise avant de supprimer l'entreprise active");
    }
    const schema = companySchema(id);
    const client = await pool.connect();
    let records = 0;
    try {
      await client.query("BEGIN");
      // Serializes deletions: two concurrent requests cannot remove the final
      // two companies and leave nobody able to sign in.
      const ready = await client.query<CompanyRow>(
        "SELECT id,name,status,created_at FROM public.companies WHERE status='ready' ORDER BY id FOR UPDATE",
      );
      const target = ready.rows.find((row) => row.id === id);
      if (!target) throw notFound("Company", "Entreprise introuvable");
      if (ready.rows.length < 2) {
        throw new AppError(409, "You cannot delete the last company",
          "LAST_COMPANY", "Vous ne pouvez pas supprimer la dernière entreprise");
      }
      if (body.name !== target.name) {
        throw badRequest("Type the exact company name to confirm deletion", "Tapez le nom exact de l'entreprise pour confirmer");
      }

      if (id === 1) {
        // The original shop shares public with the directory and sessions.
        // Do not drop public or cascade into unrelated schemas.
        const tables = await client.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        );
        const unknown = tables.rows.filter((row) => !originalTables.has(row.tablename) && !sharedTables.has(row.tablename));
        if (unknown.length) {
          throw new AppError(409, "Unknown shared tables exist; original company deletion needs review",
            "UNKNOWN_PUBLIC_TABLES", "Des tables partagées inconnues existent ; la suppression nécessite une vérification");
        }
        const owned = tables.rows.filter((row) => originalTables.has(row.tablename)).map((row) => `"public"."${row.tablename}"`);
        if (owned.length !== originalTables.size) {
          throw new AppError(409, "Original company schema does not match the expected tables",
            "ORIGINAL_SCHEMA_MISMATCH", "Les tables de l'entreprise d'origine ne correspondent pas au schéma attendu");
        }
        await client.query(`LOCK TABLE ${owned.join(", ")} IN ACCESS EXCLUSIVE MODE`);
        const result = await client.query<Record<string, number>>(`SELECT ${countsSql(schema)}`);
        records = Object.values(result.rows[0] ?? {}).reduce((total, n) => total + Number(n), 0);
        if (records > 0 && !body.force) {
          throw new AppError(409, "This company has data. Choose Delete company and all data.",
            "COMPANY_NOT_EMPTY", "Cette entreprise contient des données. Choisissez de supprimer l'entreprise et toutes ses données.");
        }
        // RESTRICT prevents a foreign key outside this allowlist from causing
        // accidental deletion of another company's data.
        await client.query(`TRUNCATE TABLE ${owned.join(", ")} RESTART IDENTITY RESTRICT`);
        await client.query("DELETE FROM public.user_sessions WHERE sess->>'companyId' = '1' OR (sess->>'companyId' IS NULL AND sess ? 'userId')");
      } else {
        await client.query(`LOCK TABLE ${businessTables.map((table) => `"${schema}"."${table}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`);
        const result = await client.query<Record<string, number>>(`SELECT ${countsSql(schema)}`);
        records = Object.values(result.rows[0] ?? {}).reduce((total, n) => total + Number(n), 0);
        if (records > 0 && !body.force) {
          throw new AppError(409, "This company has data. Choose Delete company and all data.",
            "COMPANY_NOT_EMPTY", "Cette entreprise contient des données. Choisissez de supprimer l'entreprise et toutes ses données.");
        }
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.query("DELETE FROM public.user_sessions WHERE sess->>'companyId' = $1", [String(id)]);
      }
      await client.query("DELETE FROM public.companies WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (id !== 1) forgetCompany(id);
    res.json({ ok: true, deletedRecords: records });
  }));
}
