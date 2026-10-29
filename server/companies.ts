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
  if (!Number.isSafeInteger(id) || id < 2) throw badRequest("Invalid company", "Entreprise invalide");
  return `company_${id}`;
};

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

function rootOwner(req: Request) {
  if (req.session.companyId !== undefined && req.session.companyId !== 1) {
    throw new AppError(403, "Manage companies from the original company", "ROOT_COMPANY_ONLY",
      "Gérez les entreprises depuis l'entreprise d'origine");
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
  app.get("/api/companies", requireRole(), asyncHandler(async (req, res) => {
    rootOwner(req);
    res.json((await directory()).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, isOriginal: r.id === 1 })));
  }));

  app.get("/api/companies/:id/impact", requireRole(), asyncHandler(async (req, res) => {
    rootOwner(req);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const row = await company(id);
    res.json({ id, name: row.name, ...(id === 1 ? { records: null, counts: {} } : await impact(id)) });
  }));

  app.post("/api/companies", requireRole(), asyncHandler(async (req, res) => {
    rootOwner(req);
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
      await pool.query("UPDATE public.companies SET status='ready' WHERE id=$1", [row.id]);
    } catch (error) {
      forgetCompany(row.id);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.query("DELETE FROM public.companies WHERE id=$1", [row.id]);
      throw error;
    }
    res.status(201).json({ id: row.id, name: row.name });
  }));

  // POST rather than a bare DELETE so confirmation is sent by the existing
  // idempotent mutation helper and verified by the server.
  app.post("/api/companies/:id/delete", requireRole(), asyncHandler(async (req, res) => {
    rootOwner(req);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    if (id === 1) throw new AppError(403,
      "The original company cannot be deleted. Preserve the existing live accounting data.",
      "ORIGINAL_COMPANY", "L'entreprise d'origine ne peut pas être supprimée.");
    const body = deleteSchema.parse(req.body);
    const schema = companySchema(id);
    const client = await pool.connect();
    let records = 0;
    try {
      await client.query("BEGIN");
      const rows = await client.query<CompanyRow>(
        "SELECT id,name,status,created_at FROM public.companies WHERE id=$1 AND status='ready' FOR UPDATE", [id],
      );
      if (!rows.rows[0]) throw notFound("Company", "Entreprise introuvable");
      if (body.name !== rows.rows[0].name) {
        throw badRequest("Type the exact company name to confirm deletion", "Tapez le nom exact de l'entreprise pour confirmer");
      }

      // Lock every data table before the final count, so another user cannot
      // add a sale between the count and the removal.
      await client.query(`LOCK TABLE ${businessTables.map((table) => `"${schema}"."${table}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`);
      const result = await client.query<Record<string, number>>(`SELECT ${countsSql(schema)}`);
      records = Object.values(result.rows[0] ?? {}).reduce((total, n) => total + Number(n), 0);
      if (records > 0 && !body.force) {
        throw new AppError(409, "This company has data. Choose Delete company and all data.",
          "COMPANY_NOT_EMPTY", "Cette entreprise contient des données. Choisissez de supprimer l'entreprise et toutes ses données.");
      }

      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.query("DELETE FROM public.companies WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    forgetCompany(id);
    res.json({ ok: true, deletedRecords: records });
  }));
}
