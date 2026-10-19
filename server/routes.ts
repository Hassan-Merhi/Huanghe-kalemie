import express, { type Express, type Request } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  ACCOUNT_TYPES,
  auditLog,
  categories,
  CONTAINER_EXPENSE_TYPES,
  CONTAINER_STATUSES,
  containers,
  exchangeRates,
  stockLevels,
  expenses,
  journalLines,
  journals,
  locations,
  parties,
  PARTY_TYPES,
  partners,
  periods,
  products,
  ROLES,
  saleReturns,
  sales,
  settings,
  stockAdjustments,
  stockMovements,
  users,
  variants,
} from "@shared/schema";
import { ALLOCATION_METHODS } from "@shared/landedCost";
import { validatePartnerShares } from "@shared/partnerSplit";
import { dec } from "@shared/money";
import { frNumber } from "@shared/french";
import { db, type Tx } from "./db";
import { AppError, badRequest, conflict, forbidden, notFound } from "./errors";
import { checkPassword, hashPassword, requireAuth, requireRole } from "./auth";
import {
  asyncHandler,
  decimalString,
  id,
  isoDate,
  month,
  nonNegativeDecimal,
  optionalDecimal,
  optionalId,
  optionalRate,
  paramId,
  positiveDecimal,
  positiveRate,
  todayIso,
} from "./http";
import * as catalog from "./services/catalog";
import * as containerSvc from "./services/containers";
import * as salesSvc from "./services/sales";
import * as ops from "./services/operations";
import * as periodSvc from "./services/periods";
import * as reports from "./services/reports";
import * as checks from "./services/checks";
import * as backup from "./services/backup";
import { getSetting } from "./setup";
import { assertNotFuture, assertPeriodOpen, assertUndoKeepsRefunds, cnyRateFor, FRANCS_MET_SOURCE, rateFor, reverseJournal, setExchangeRate } from "./services/ledger";
import { containerNumberKey } from "@shared/containerNumber";
import { availableOn, lockVariants, transferStock } from "./services/stock";
import * as vouchers from "./services/vouchers";
import { registerErpRoutes } from "./routes/erp";

const STAFF = ["manager"] as const; // owner is always allowed
const READERS = ["manager", "partner"] as const;
const SELLERS = ["manager", "cashier"] as const;

/** A sale as cashiers see it: no cost of goods sold. */
/** What a cashier may see of a sale: never what the goods cost, returns included. */
function withoutCost<S extends { cogs?: unknown; lines: { cogs?: unknown }[]; returns: { cogs?: unknown }[] }>(sale: S) {
  return {
    ...sale,
    cogs: undefined,
    lines: sale.lines.map(({ cogs: _c, ...l }) => l),
    returns: sale.returns.map(({ cogs: _c, ...r }) => r),
  };
}
const EVERYONE = ["manager", "cashier", "partner"] as const;

/** A partner reads their own partner accounts only. */
async function assertAccountVisible(req: Request, accountId: number) {
  if (req.user!.role !== "partner") return;
  const [a] = await db.select({ partnerId: accounts.partnerId }).from(accounts).where(eq(accounts.id, accountId));
  if (a?.partnerId && a.partnerId !== req.user!.partnerId) throw notFound("Account", "Compte introuvable");
}

const uid = (req: Request) => req.user!.id;

async function audit(req: Request, action: string, entity: string, entityId: number | null, data?: unknown) {
  await db.insert(auditLog).values({ userId: req.user?.id ?? null, action, entity, entityId, data: (data ?? null) as never });
}

const variantSchema = z.object({
  sku: z.string().max(60).optional().nullable(),
  barcode: z.string().max(64).optional().nullable(),
  attributes: z.record(z.string(), z.string()).optional(),
  sellPrice: optionalDecimal,
  reorderLevel: optionalDecimal,
  active: z.boolean().optional(),
});

const productSchema = z.object({
  name: z.string().min(1).max(200),
  categoryId: optionalId,
  brand: z.string().max(80).optional().nullable(),
  unit: z.string().max(20).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  tracksSerials: z.boolean().optional(),
  active: z.boolean().optional(),
});

const paymentSchema = z.object({ accountId: id, amount: positiveDecimal, rate: optionalRate });

export function registerRoutes(app: Express) {
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/health") return next();
    return requireAuth(req, res, next);
  });

  app.get("/api/health", asyncHandler(async (_req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- Settings, rates, users

  app.get("/api/settings", requireRole(...EVERYONE), asyncHandler(async (_req, res) => {
    const rows = await db.select().from(settings);
    const [rate] = await db.select().from(exchangeRates).orderBy(desc(exchangeRates.date)).limit(1);
    res.json({ ...Object.fromEntries(rows.map((r) => [r.key, r.value])), latestRate: rate ?? null, today: todayIso() });
  }));

  app.patch("/api/settings", requireRole(), asyncHandler(async (req, res) => {
    const body = z
      .object({
        shopName: z.string().min(1).max(120).optional(),
        defaultCdfRate: positiveRate.optional(),
        receiptFooter: z.string().max(300).optional(),
        rateTolerancePct: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "Tolerance must be a percentage like 3").optional(),
        cashierDiscountPct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Give a percentage like 10").refine((v) => Number(v) <= 100, "At most 100%").optional(),
        managerDiscountPct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Give a percentage like 20").refine((v) => Number(v) <= 100, "At most 100%").optional(),
        managerBelowCost: z.boolean().optional(),
      })
      .parse(req.body);
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    }
    await audit(req, "update", "settings", null, body);
    res.json({ ok: true });
  }));

  app.get("/api/exchange-rates", requireRole(...EVERYONE), asyncHandler(async (_req, res) => {
    res.json(await db.select().from(exchangeRates).orderBy(desc(exchangeRates.date)).limit(60));
  }));

  /** Rate for a date: that day's rate, else the latest before it, else the default. */
  app.get("/api/exchange-rates/for/:date", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const date = isoDate.parse(req.params.date);
    const [row] = await db.select().from(exchangeRates).where(lte(exchangeRates.date, date)).orderBy(desc(exchangeRates.date)).limit(1);
    const fallback = await getSetting(db, "defaultCdfRate", "2800");
    // The yuan rate is not entered every day: the latest one on file, if any.
    const cny = await cnyRateFor(db, date);
    res.json({ date, cdfPerUsd: row?.cdfPerUsd ?? String(fallback), source: row ? row.date : "default", cnyPerUsd: cny ? cny.toString() : null });
  }));

  app.post("/api/exchange-rates", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ date: isoDate, cdfPerUsd: positiveRate, cnyPerUsd: positiveRate.nullish() }).parse(req.body);
    const row = await db.transaction((tx) => setExchangeRate(tx, body, uid(req), { owner: req.user!.role === "owner" }));
    await audit(req, "set_rate", "exchange_rate", null, body);
    res.json(row);
  }));

  app.get("/api/users", requireRole(), asyncHandler(async (_req, res) => {
    const rows = await db
      .select({ id: users.id, username: users.username, fullName: users.fullName, role: users.role, partnerId: users.partnerId, language: users.language, active: users.active })
      .from(users)
      .orderBy(asc(users.username));
    res.json(rows);
  }));

  const userSchema = z.object({
    username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, "Letters, numbers, dot, dash or underscore only"),
    fullName: z.string().min(1).max(120),
    role: z.enum(ROLES),
    partnerId: optionalId,
    language: z.enum(["fr", "en"]).optional(),
    password: z.string().min(8).max(200),
    active: z.boolean().optional(),
  });

  const assertPartnerExists = async (partnerId: number | null | undefined) => {
    const [p] = partnerId ? await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)) : [];
    if (!p) throw badRequest("Link a partner login to its partner", "Associez ce compte de connexion à son associé");
  };
  app.post("/api/users", requireRole(), asyncHandler(async (req, res) => {
    const body = userSchema.parse(req.body);
    if (body.role === "partner") await assertPartnerExists(body.partnerId);
    const [row] = await db
      .insert(users)
      .values({
        username: body.username.toLowerCase(),
        fullName: body.fullName,
        role: body.role,
        partnerId: body.role === "partner" ? body.partnerId : null,
        language: body.language ?? "fr",
        passwordHash: await hashPassword(body.password),
      })
      .returning({ id: users.id });
    await audit(req, "create", "user", row.id, { username: body.username, role: body.role });
    res.status(201).json(row);
  }));

  app.patch("/api/users/:id", requireRole(), asyncHandler(async (req, res) => {
    const userId = paramId(req);
    const body = userSchema.partial().parse(req.body);
    if (userId === uid(req) && (body.active === false || (body.role && body.role !== "owner"))) {
      throw badRequest("You cannot remove your own owner access", "Vous ne pouvez pas retirer votre propre accès propriétaire");
    }
    if (body.role !== undefined || body.partnerId !== undefined) {
      // A partner login must stay linked to a real partner, or it sees nothing at all.
      const [current] = await db.select({ role: users.role, partnerId: users.partnerId }).from(users).where(eq(users.id, userId));
      if ((body.role ?? current?.role) === "partner") await assertPartnerExists(body.partnerId !== undefined ? body.partnerId : current?.partnerId);
    }
    await db
      .update(users)
      .set({
        ...(body.username && { username: body.username.toLowerCase() }),
        ...(body.fullName && { fullName: body.fullName }),
        ...(body.role && { role: body.role }),
        ...(body.partnerId !== undefined && { partnerId: body.partnerId }),
        ...(body.language && { language: body.language }),
        ...(body.active !== undefined && { active: body.active }),
        ...(body.password && { passwordHash: await hashPassword(body.password) }),
      })
      .where(eq(users.id, userId));
    await audit(req, "update", "user", userId, { ...body, password: body.password ? "(changed)" : undefined });
    res.json({ ok: true });
  }));

  app.patch("/api/me", asyncHandler(async (req, res) => {
    const body = z
      .object({ language: z.enum(["fr", "en"]).optional(), password: z.string().min(8).max(200).optional(), currentPassword: z.string().max(200).optional() })
      .parse(req.body);
    // Changing your own password needs the current one, so an unattended open session cannot lock you out.
    if (body.password) await checkPassword(uid(req), body.currentPassword ?? "");
    await db
      .update(users)
      .set({ ...(body.language && { language: body.language }), ...(body.password && { passwordHash: await hashPassword(body.password) }) })
      .where(eq(users.id, uid(req)));
    if (body.password) await audit(req, "update", "user", uid(req), { password: "(changed)" });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- Locations & categories

  app.get("/api/locations", requireRole(...EVERYONE), asyncHandler(async (_req, res) => {
    res.json(await db.select().from(locations).orderBy(asc(locations.id)));
  }));
  app.post("/api/locations", requireRole(), asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const [row] = await db.insert(locations).values(body).returning();
    await audit(req, "create", "location", row.id, body);
    res.status(201).json(row);
  }));
  app.patch("/api/locations/:id", requireRole(), asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80).optional(), active: z.boolean().optional() }).parse(req.body);
    if (body.active === false) {
      // Stock in a switched-off place could no longer be sold, counted or moved.
      const [held] = await db.select({ n: sql<number>`count(*)::int` }).from(stockLevels).where(and(eq(stockLevels.locationId, paramId(req)), sql`${stockLevels.qty} <> 0`));
      if (held.n > 0) throw badRequest("Move the stock out of this place before switching it off", "Transférez le stock hors de cet emplacement avant de le désactiver");
    }
    const [row] = await db.update(locations).set(body).where(eq(locations.id, paramId(req))).returning();
    await audit(req, "update", "location", paramId(req), body);
    res.json(row);
  }));

  app.get("/api/categories", requireRole(...EVERYONE), asyncHandler(async (_req, res) => {
    res.json(await db.select().from(categories).orderBy(asc(categories.name)));
  }));
  app.post("/api/categories", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80), parentId: optionalId }).parse(req.body);
    const [row] = await db.insert(categories).values(body).returning();
    await audit(req, "create", "category", row.id, body);
    res.status(201).json(row);
  }));
  app.patch("/api/categories/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(80).optional(), parentId: z.union([id, z.null()]).optional(), active: z.boolean().optional() })
      .parse(req.body);
    const [row] = await db.update(categories).set(body).where(eq(categories.id, paramId(req))).returning();
    await audit(req, "update", "category", paramId(req), body);
    res.json(row);
  }));

  // ---------------------------------------------------------------- Catalog

  app.get("/api/products", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const q = z.object({ search: z.string().optional(), categoryId: optionalId, includeInactive: z.enum(["true", "false"]).optional() }).parse(req.query);
    const rows = await catalog.listProducts(db, { search: q.search, categoryId: q.categoryId ?? undefined, includeInactive: q.includeInactive === "true" });
    res.json(req.user!.role === "cashier" ? rows.map(({ stockValue, ...r }) => r) : rows);
  }));
  app.get("/api/products/:id", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const product = await catalog.getProduct(db, paramId(req));
    if (req.user!.role === "cashier") {
      res.json({ ...product, variants: product.variants.map(({ avgCost, stockValue, keptUnitCost, ...v }) => v) });
      return;
    }
    res.json(product);
  }));
  app.post("/api/products", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = productSchema.extend({ variants: z.array(variantSchema).min(1) }).parse(req.body);
    const product = await db.transaction((tx) => catalog.createProduct(tx, body));
    await audit(req, "create", "product", product.id);
    res.status(201).json(product);
  }));
  app.patch("/api/products/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = productSchema.partial().parse(req.body);
    const product = await db.transaction((tx) => catalog.updateProduct(tx, paramId(req), body));
    await audit(req, "update", "product", paramId(req), body);
    res.json(product);
  }));
  app.post("/api/products/:id/variants", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = variantSchema.parse(req.body);
    const variant = await db.transaction((tx) => catalog.addVariant(tx, paramId(req), body));
    await audit(req, "create", "variant", (variant as { id?: number }).id ?? null, body);
    res.status(201).json(variant);
  }));
  app.patch("/api/variants/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = variantSchema.parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest("Nothing to change", "Rien à modifier");
    const variant = await db.transaction((tx) => catalog.updateVariant(tx, paramId(req), body));
    await audit(req, "update", "variant", paramId(req), body);
    res.json(variant);
  }));
  app.get("/api/variants", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const q = z
      .object({ search: z.string().optional(), locationId: optionalId, limit: z.coerce.number().int().min(1).max(500).optional(), ids: z.string().optional(), asOf: isoDate.optional() })
      .parse(req.query);
    const ids = q.ids ? q.ids.split(",").map((x) => id.parse(x)) : undefined;
    let rows = await catalog.searchVariants(db, { search: q.search, locationId: q.locationId ?? undefined, limit: q.limit, ids });
    // A back-dated sale's cart: what can leave the location on that day, as the sale itself is checked (a
    // few items, by id, so one small query each).
    if (q.asOf && q.locationId && ids && rows.length <= 100) {
      const day = q.asOf;
      const loc = q.locationId;
      rows = await Promise.all(rows.map(async (r) => ({ ...r, locationQty: (await availableOn(db, r.id, loc, day, dec(r.locationQty))).toFixed(3) })));
    }
    res.json(req.user!.role === "cashier" ? rows.map(({ avgCost, stockValue, keptUnitCost, ...r }) => r) : rows);
  }));
  app.get("/api/variants/:id/movements", requireRole(...READERS), asyncHandler(async (req, res) => {
    const rows = await db
      .select({ movement: stockMovements, locationName: locations.name })
      .from(stockMovements)
      .innerJoin(locations, eq(locations.id, stockMovements.locationId))
      .where(eq(stockMovements.variantId, paramId(req)))
      .orderBy(desc(stockMovements.date), desc(stockMovements.id))
      .limit(500);
    res.json(rows.map((r) => ({ ...r.movement, locationName: r.locationName })));
  }));

  app.get("/api/units", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const q = z.object({ variantId: optionalId, status: z.string().optional(), locationId: optionalId, search: z.string().optional() }).parse(req.query);
    res.json(await catalog.listUnits(db, { variantId: q.variantId ?? undefined, status: q.status, locationId: q.locationId ?? undefined, search: q.search }));
  }));
  app.post("/api/units/bulk", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z
      .object({ units: z.array(z.object({ id, chassisNo: z.string().min(1).max(60), engineNo: z.string().max(60).nullable().optional(), color: z.string().max(40).nullable().optional() })).min(1).max(500) })
      .parse(req.body);
    const seen = new Set<string>();
    for (const u of body.units) {
      const key = u.chassisNo.trim().toUpperCase();
      if (seen.has(key)) throw conflict(`Chassis number ${key} is typed twice`, `Le numéro de châssis ${key} est saisi deux fois`);
      seen.add(key);
    }
    // All or nothing: one duplicate stops the whole list, so nothing is half saved.
    const saved = await db.transaction(async (tx) => {
      const out = [];
      for (const u of body.units) out.push(await catalog.updateUnit(tx, u.id, u));
      return out;
    });
    await audit(req, "update", "motorcycle", null, { bulk: saved.length, chassis: saved.map((u) => u.chassisNo) });
    res.json({ saved: saved.length });
  }));
  app.patch("/api/units/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ chassisNo: z.string().max(60).nullable().optional(), engineNo: z.string().max(60).nullable().optional(), color: z.string().max(40).nullable().optional() }).parse(req.body);
    const unit = await db.transaction((tx) => catalog.updateUnit(tx, paramId(req), body));
    await audit(req, "update", "motorcycle", paramId(req), body);
    res.json(unit);
  }));

  // ---------------------------------------------------------------- Stock

  app.get("/api/stock", requireRole(...READERS), asyncHandler(async (_req, res) => {
    res.json(await reports.stockValuation(db));
  }));

  const adjustmentSchema = z.object({
    date: isoDate,
    locationId: id,
    kind: z.enum(["opening", "count", "damage", "loss", "found", "other"]),
    reason: z.string().min(1).max(300),
    lines: z
      .array(
        z.object({
          variantId: id,
          qtyChange: decimalString,
          unitCost: optionalDecimal,
          unitIds: z.array(id).optional(),
          serials: z.array(z.object({ chassisNo: z.string().max(60), engineNo: z.string().max(60).nullable().optional(), color: z.string().max(40).nullable().optional() })).optional(),
        }),
      )
      .min(1),
  });
  app.post("/api/stock/adjustments", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = adjustmentSchema.parse(req.body);
    if (body.kind === "opening" && req.user!.role !== "owner") {
      throw forbidden("Only the owner can enter opening stock", "Seul le propriétaire peut saisir le stock d'ouverture");
    }
    const result = await db.transaction((tx) => ops.adjustStock(tx, body, uid(req), { owner: req.user!.role === "owner" }));
    await audit(req, "create", "stock_adjustment", result.id, body);
    res.status(201).json(result);
  }));
  app.get("/api/stock/transfers", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    // Each transfer line is stored as a pair of movements: out of one place, then into the other.
    const rows = await db.execute<{ id: number; date: string; qty: string; note: string | null; sku: string; attributes: Record<string, string>; product_name: string; unit: string; from_name: string; to_name: string; username: string | null; full_name: string | null }>(sql`
      select o.id, o.date, i.qty, o.note, v.sku, v.attributes, p.name as product_name, p.unit, lf.name as from_name, lt.name as to_name, u.username, u.full_name
      from stock_movements o
      join stock_movements i on i.id = o.id + 1 and i.type = 'transfer_in' and i.variant_id = o.variant_id
      join variants v on v.id = o.variant_id
      join products p on p.id = v.product_id
      join locations lf on lf.id = o.location_id
      join locations lt on lt.id = i.location_id
      left join users u on u.id = o.created_by
      where o.type = 'transfer_out'
        and (${q.from ?? null}::date is null or o.date >= ${q.from ?? null}::date)
        and (${q.to ?? null}::date is null or o.date <= ${q.to ?? null}::date)
      order by o.id desc
      limit 500
    `);
    res.json(rows.rows.map((r) => ({ id: r.id, date: r.date, qty: r.qty, note: r.note, sku: r.sku, productName: r.product_name, unit: r.unit, label: catalog.variantLabel(r.attributes), fromName: r.from_name, toName: r.to_name, username: r.username, userName: r.full_name || r.username })));
  }));
  // ---------------------------------------------------------------- Backups (owner only)

  app.get("/api/backup", requireRole(), asyncHandler(async (req, res) => {
    // One consistent snapshot of every table, users included, so it can rebuild the shop on a new database.
    const text = await backup.takeSnapshot();
    await audit(req, "export", "backup", null, { size: text.length });
    res.setHeader("Content-Disposition", `attachment; filename="huanghe-kalemie-sauvegarde-${todayIso()}.json"`);
    res.type("application/json").send(text);
  }));
  app.get("/api/backups", requireRole(), asyncHandler(async (_req, res) => {
    const [last] = await db
      .select({ at: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.action, "export"), eq(auditLog.entity, "backup")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    res.json({ snapshots: await backup.listSnapshots(), lastDownloadAt: last?.at ?? null, empty: await backup.isEmptyShop(db) });
  }));
  app.get("/api/backups/:id", requireRole(), asyncHandler(async (req, res) => {
    const row = await backup.snapshotFile(paramId(req));
    await audit(req, "export", "backup", row.id, { kind: row.kind, day: row.day });
    res.setHeader("Content-Disposition", `attachment; filename="huanghe-kalemie-sauvegarde-${row.day}-${row.kind}.json.gz"`);
    res.type("application/gzip").send(row.data);
  }));
  const rawBody = express.raw({ type: () => true, limit: "200mb" });
  app.post("/api/backup/inspect", requireRole(), rawBody, asyncHandler(async (req, res) => {
    const file = backup.parseBackup(req.body as Buffer);
    res.json({ exportedAt: file.exportedAt, migrations: file.migrations, totals: file.totals, sealed: file.sealed, empty: await backup.isEmptyShop(db) });
  }));
  app.post("/api/backup/restore", requireRole(), rawBody, asyncHandler(async (req, res) => {
    // The current password travels in a header because the body is the file itself.
    await checkPassword(uid(req), req.get("X-Current-Password") ?? "");
    const replace = req.query.replace === "1";
    const file = backup.parseBackup(req.body as Buffer);
    if (!file.sealed && req.query.unsealed !== "1") {
      throw new AppError(
        422,
        "This file was not made by this server, or it was changed after. Confirm to restore it anyway.",
        "BACKUP_UNSEALED",
        "Ce fichier n'a pas été créé par ce serveur, ou il a été modifié depuis. Confirmez pour le restaurer quand même.",
      );
    }
    // Before replacing anything, keep what is there now so the restore itself can be undone.
    if (replace && !(await backup.isEmptyShop(db))) await backup.saveSnapshot("before_restore");
    const result = await db.transaction((tx) => backup.restore(tx, file, { replace }));
    // The restored users may not include whoever restored, so their name is kept with the id.
    await db.insert(auditLog).values({ userId: uid(req), action: "restore", entity: "backup", entityId: null, data: { exportedAt: file.exportedAt, rows: result.rows, replace, sealed: file.sealed, by: req.user!.username } });
    res.json(result);
  }));
  app.get("/api/stock/adjustments", requireRole(...READERS), asyncHandler(async (_req, res) => {
    const rows = await db
      .select({ adjustment: stockAdjustments, locationName: locations.name })
      .from(stockAdjustments)
      .innerJoin(locations, eq(locations.id, stockAdjustments.locationId))
      .orderBy(desc(stockAdjustments.id))
      .limit(200);
    const ids = rows.map((r) => r.adjustment.id);
    const moves = ids.length
      ? await db
          .select({ m: stockMovements, sku: variants.sku, attributes: variants.attributes, productName: products.name })
          .from(stockMovements)
          .innerJoin(variants, eq(variants.id, stockMovements.variantId))
          .innerJoin(products, eq(products.id, variants.productId))
          .where(and(eq(stockMovements.sourceType, "adjustment"), inArray(stockMovements.sourceId, ids)))
      : [];
    res.json(
      rows.map((r) => {
        const lines = moves.filter((m) => m.m.sourceId === r.adjustment.id).map((m) => ({ variantId: m.m.variantId, sku: m.sku, attributes: m.attributes, productName: m.productName, qty: m.m.qty, value: m.m.value }));
        return { ...r.adjustment, locationName: r.locationName, lines, value: lines.reduce((s, l) => s.plus(l.value), dec(0)).toFixed(2) };
      }),
    );
  }));
  app.post("/api/stock/transfers", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ date: isoDate, fromLocationId: id, toLocationId: id, note: z.string().max(300).optional(), lines: z.array(z.object({ variantId: id, qty: positiveDecimal, unitIds: z.array(id).optional() })).min(1) }).parse(req.body);
    await db.transaction(async (tx) => {
      // A transfer posts no journal, but it changes the stock of its date, so a closed month or a date
      // after tomorrow refuses it like any posting.
      await assertPeriodOpen(tx, body.date);
      assertNotFuture(body.date);
      await lockVariants(tx, body.lines.map((l) => l.variantId));
      for (const l of body.lines) {
        await transferStock(tx, { date: body.date, type: "transfer_out", variantId: l.variantId, fromLocationId: body.fromLocationId, toLocationId: body.toLocationId, qty: l.qty, unitIds: l.unitIds, note: body.note, userId: uid(req) });
      }
    });
    await audit(req, "create", "stock_transfer", null, body);
    res.status(201).json({ ok: true });
  }));

  // ---------------------------------------------------------------- Parties

  app.get("/api/parties", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const q = z.object({ type: z.enum(PARTY_TYPES).optional(), search: z.string().optional() }).parse(req.query);
    // Cashiers work with customers only.
    const type = req.user!.role === "cashier" ? "customer" : q.type;
    let rows = await reports.partyBalances(db, type);
    if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(s) || (r.phone ?? "").includes(s));
    }
    res.json(rows);
  }));
  const partySchema = z.object({
    type: z.enum(PARTY_TYPES),
    name: z.string().min(1).max(120),
    phone: z.string().max(40).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    position: z.string().max(120).optional().nullable(),
    monthlySalary: optionalDecimal,
    startDate: z.union([isoDate, z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v)),
    active: z.boolean().optional(),
  });
  app.post("/api/parties", requireRole(...SELLERS), asyncHandler(async (req, res) => {
    const body = partySchema.parse(req.body);
    if (req.user!.role === "cashier" && body.type !== "customer") throw badRequest("Cashiers can only add customers", "Les caissiers ne peuvent ajouter que des clients");
    const [row] = await db.insert(parties).values(body).returning();
    await audit(req, "create", "contact", row.id, body);
    res.status(201).json(row);
  }));
  app.patch("/api/parties/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = partySchema.omit({ type: true }).partial().parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest("Nothing to change (a contact's type cannot change)", "Rien à modifier (le type d'un contact ne change pas)");
    const [row] = await db.update(parties).set(body).where(eq(parties.id, paramId(req))).returning();
    if (!row) throw notFound("Contact", "Contact introuvable");
    await audit(req, "update", "contact", row.id, body);
    res.json(row);
  }));
  app.get("/api/parties/:id/statement", requireRole(...READERS, "cashier"), asyncHandler(async (req, res) => {
    // Partners don't see the other partner's memos; cashiers see no partner's.
    const role = req.user!.role;
    const hidden = role === "partner" || role === "cashier" ? await reports.otherPartnerAccountIds(db, role === "partner" ? req.user!.partnerId : null) : undefined;
    const statement = await reports.partyStatement(db, paramId(req), hidden);
    if (req.user!.role === "cashier" && statement.party.type !== "customer") throw notFound("Customer", "Client introuvable");
    res.json(statement);
  }));

  // ---------------------------------------------------------------- Accounts & journals

  app.get("/api/accounts", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const rows = await reports.accountBalances(db);
    // Cashiers only need the money accounts they take payments into.
    if (req.user!.role === "cashier") {
      res.json(rows.filter((r) => r.isMoney && r.active).map(({ debit, credit, balance, nativeBalance, ...r }) => r));
      return;
    }
    res.json(req.user!.role === "partner" ? reports.maskOtherPartners(rows, req.user!.partnerId) : rows);
  }));
  app.post("/api/accounts", requireRole(), asyncHandler(async (req, res) => {
    const body = z
      .object({ code: z.string().min(1).max(20), name: z.string().min(1).max(120), type: z.enum(ACCOUNT_TYPES), isMoney: z.boolean().optional(), currency: z.enum(["USD", "CDF"]).optional() })
      .parse(req.body);
    if (body.isMoney && body.type !== "asset") throw badRequest("Cash, bank and mobile money accounts are assets", "Les comptes caisse, banque et mobile money sont des comptes d'actif");
    const [row] = await db.insert(accounts).values(body).returning();
    await audit(req, "create", "account", row.id, body);
    res.status(201).json(row);
  }));
  app.patch("/api/accounts/:id", requireRole(), asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(120).optional(), active: z.boolean().optional() }).parse(req.body);
    const [existing] = await db.select().from(accounts).where(eq(accounts.id, paramId(req)));
    if (!existing) throw notFound("Account", "Compte introuvable");
    if ((existing.systemKey || existing.partnerId) && body.active === false) throw badRequest("This account is used by the app and cannot be switched off", "Ce compte est utilisé par l'application et ne peut pas être désactivé");
    if (body.active === false) {
      // Money left in a switched-off account would vanish from every screen that lists active accounts.
      const bal = (await reports.accountBalances(db)).find((b) => b.id === existing.id);
      if (bal && (!dec(bal.balance).isZero() || !dec(bal.nativeBalance).isZero())) {
        throw badRequest(
          `${existing.name} still holds ${bal.nativeBalance} ${existing.currency}. Move it to another account first.`,
          `${existing.name} contient encore ${bal.nativeBalance} ${existing.currency === "CDF" ? "FC" : existing.currency}. Transférez-le d'abord vers un autre compte.`,
        );
      }
    }
    const [row] = await db.update(accounts).set(body).where(eq(accounts.id, existing.id)).returning();
    await audit(req, "update", "account", row.id, body);
    res.json(row);
  }));
  app.get("/api/accounts/:id/ledger", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    await assertAccountVisible(req, paramId(req));
    const ledger = await reports.accountLedger(db, paramId(req), q.from, q.to);
    if (req.user!.role === "partner") {
      // A cash line from another partner's withdrawal stays, without saying whose it was.
      const hidden = await reports.otherPartnerAccountIds(db, req.user!.partnerId);
      const ids = ledger.rows.filter((r) => reports.PARTNER_MEMO_TYPES.has(r.type)).map((r) => r.journalId);
      const touched = ids.length && hidden.size
        ? new Set((await db.select({ id: journalLines.journalId }).from(journalLines).where(and(inArray(journalLines.journalId, ids), inArray(journalLines.accountId, Array.from(hidden))))).map((r) => r.id))
        : new Set<number>();
      ledger.rows = ledger.rows.map((r) => (touched.has(r.journalId) ? { ...r, memo: "Mouvement d'un autre associé", lineMemo: null } : r));
    }
    res.json(ledger);
  }));

  app.get("/api/journals", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), type: z.string().optional() }).parse(req.query);
    const conds = [];
    if (q.from) conds.push(gte(journals.date, q.from));
    if (q.to) conds.push(lte(journals.date, q.to));
    if (q.type) conds.push(eq(journals.type, q.type as never));
    const js = await db.select().from(journals).where(conds.length ? and(...conds) : undefined).orderBy(desc(journals.date), desc(journals.id)).limit(300);
    const lines = js.length
      ? await db
          .select({ line: journalLines, accountName: accounts.name, accountCode: accounts.code, partyName: parties.name })
          .from(journalLines)
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .leftJoin(parties, eq(parties.id, journalLines.partyId))
          .where(inArray(journalLines.journalId, js.map((j) => j.id)))
      : [];
    const hidden = req.user!.role === "partner" ? await reports.otherPartnerAccountIds(db, req.user!.partnerId) : new Set<number>();
    res.json(
      js.map((j) => {
        const ls = lines.filter((l) => l.line.journalId === j.id).map((l) => ({ ...l.line, accountName: l.accountName, accountCode: l.accountCode, partyName: l.partyName }));
        const m = reports.maskPartnerJournal(j, ls, hidden);
        return { ...m.journal, lines: m.lines };
      }),
    );
  }));

  const manualLine = z.object({ accountId: id, debit: optionalDecimal, credit: optionalDecimal, partyId: optionalId, nativeAmount: optionalDecimal, rate: optionalRate, memo: z.string().max(300).optional().nullable() });
  const journalSchema = z.object({ date: isoDate, memo: z.string().min(1).max(300), type: z.enum(["manual", "opening"]).optional(), lines: z.array(manualLine).min(2) });
  app.post("/api/journals", requireRole(), asyncHandler(async (req, res) => {
    const body = journalSchema.parse(req.body);
    const journalId = await db.transaction((tx) => ops.manualJournal(tx, body, uid(req)));
    await audit(req, "create", "journal", journalId, body);
    res.status(201).json({ id: journalId });
  }));
  app.post("/api/journals/:id/reverse", requireRole(), asyncHandler(async (req, res) => {
    const body = z.object({ date: isoDate }).parse(req.body);
    const [j] = await db.select().from(journals).where(eq(journals.id, paramId(req)));
    if (!j) throw notFound("Journal", "Écriture introuvable");
    if (!["manual", "opening", "transfer", "customer_receipt", "supplier_payment", "partner_contribution", "partner_withdrawal", "payment", "receipt"].includes(j.type)) {
      throw badRequest("Cancel this from its own screen (sale, expense, container or month close)", "Annulez ceci depuis son propre écran (vente, dépense, conteneur ou clôture du mois)");
    }
    // The books' own journals on a payment's francs or advance go with that payment or bill, never alone:
    // undone on their own they leave dollars on no francs, which a payment would then pay out.
    if (j.sourceType === FRANCS_MET_SOURCE || j.sourceType?.startsWith("advance_")) {
      throw conflict(
        "This entry is the books' own, applying francs or an advance to a bill. Cancel the payment or the bill it belongs to instead.",
        "Cette écriture est passée par la comptabilité elle-même (francs ou avance imputés sur une facture). Annulez plutôt le paiement ou la facture dont elle dépend.",
      );
    }
    const reversalId = await db.transaction(async (tx) => {
      await assertUndoKeepsRefunds(tx, j.id);
      return j.type === "payment" || j.type === "receipt" ? vouchers.reverseVoucher(tx, j.id, body.date, uid(req)) : reverseJournal(tx, j.id, { date: body.date, userId: uid(req) });
    });
    await audit(req, "reverse", "journal", j.id);
    res.json({ id: reversalId });
  }));

  // ---------------------------------------------------------------- Money movements

  const partyPayment = z.object({ date: isoDate, partyId: id, accountId: id, amount: positiveDecimal, rate: optionalRate, memo: z.string().max(300).optional().nullable(), settleNative: optionalDecimal });
  app.post("/api/money/customer-receipt", requireRole(...SELLERS), asyncHandler(async (req, res) => {
    const body = partyPayment.parse(req.body);
    // Staff take francs at the day's rate; cashiers also record today's money only.
    if (req.user!.role !== "owner") body.rate = null;
    if (req.user!.role === "cashier") Object.assign(body, { rate: null, date: todayIso() });
    res.status(201).json({ id: await db.transaction((tx) => ops.receiveFromCustomer(tx, body, uid(req))) });
  }));
  app.post("/api/money/party-payment", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = partyPayment.parse(req.body);
    res.status(201).json({ id: await db.transaction((tx) => ops.payParty(tx, body, uid(req))) });
  }));
  const transferSchema = z.object({ date: isoDate, fromAccountId: id, fromAmount: positiveDecimal, toAccountId: id, toAmount: positiveDecimal, rate: optionalRate, memo: z.string().max(300).optional().nullable() });
  app.post("/api/money/transfer", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = transferSchema.parse(req.body);
    res.status(201).json({ id: await db.transaction((tx) => ops.transferMoney(tx, body, uid(req))) });
  }));
  const partnerMoney = z.object({ date: isoDate, partnerId: id, accountId: id, amount: positiveDecimal, rate: optionalRate, memo: z.string().max(300).optional().nullable() });
  app.post("/api/money/partner-contribution", requireRole(), asyncHandler(async (req, res) => {
    const body = partnerMoney.parse(req.body);
    const journalId = await db.transaction((tx) => ops.partnerContribution(tx, body, uid(req)));
    await audit(req, "create", "partner_contribution", journalId, body);
    res.status(201).json({ id: journalId });
  }));
  app.post("/api/money/partner-withdrawal", requireRole(), asyncHandler(async (req, res) => {
    const body = partnerMoney.parse(req.body);
    const journalId = await db.transaction((tx) => ops.partnerWithdrawal(tx, body, uid(req)));
    await audit(req, "create", "partner_withdrawal", journalId, body);
    res.status(201).json({ id: journalId });
  }));

  // ---------------------------------------------------------------- Operating expenses

  app.get("/api/expenses", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    const conds = [];
    if (q.from) conds.push(gte(expenses.date, q.from));
    if (q.to) conds.push(lte(expenses.date, q.to));
    const rows = await db
      .select({ expense: expenses, accountName: accounts.name })
      .from(expenses)
      .innerJoin(accounts, eq(accounts.id, expenses.accountId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(expenses.date), desc(expenses.id))
      .limit(500);
    // A partner doesn't see the note of an expense paid on the same voucher as another partner's movement.
    const hidden = req.user!.role === "partner" ? await reports.otherPartnerAccountIds(db, req.user!.partnerId) : new Set<number>();
    const ids = rows.map((r) => r.expense.journalId).filter((x): x is number => !!x);
    const touched = hidden.size && ids.length
      ? new Set((await db.select({ id: journalLines.journalId }).from(journalLines).where(and(inArray(journalLines.journalId, ids), inArray(journalLines.accountId, Array.from(hidden))))).map((r) => r.id))
      : new Set<number>();
    res.json(rows.map((r) => ({ ...r.expense, ...(r.expense.journalId && touched.has(r.expense.journalId) ? { description: r.accountName } : {}), accountName: r.accountName })));
  }));
  app.post("/api/expenses", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z
      .object({ date: isoDate, accountId: id, description: z.string().min(1).max(300), amount: positiveDecimal, currency: z.enum(["USD", "CDF"]).optional(), rate: optionalRate, paidFromAccountId: optionalId, payablePartyId: optionalId })
      .parse(req.body);
    res.status(201).json(await db.transaction((tx) => ops.createExpense(tx, body, uid(req))));
  }));
  app.post("/api/expenses/:id/void", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ date: isoDate.optional() }).parse(req.body ?? {});
    await db.transaction((tx) => ops.voidExpense(tx, paramId(req), body.date ?? todayIso(), uid(req)));
    await audit(req, "void", "expense", paramId(req));
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- Containers

  app.get("/api/containers", requireRole(...READERS), asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        container: containers,
        supplierName: parties.name,
        lineCount: sql<number>`(select count(*)::int from container_lines l where l.container_id = "containers"."id")`,
        expensesUsd: sql<string>`(select coalesce(sum(e.amount_usd), 0) from container_expenses e where e.container_id = "containers"."id")`,
      })
      .from(containers)
      .innerJoin(parties, eq(parties.id, containers.supplierId))
      .orderBy(desc(containers.id));
    res.json(rows.map((r) => ({ ...r.container, supplierName: r.supplierName, lineCount: r.lineCount, expensesUsd: r.expensesUsd })));
  }));

  async function assertActiveLocation(tx: Tx, locationId: number) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId));
    if (!loc) throw badRequest("That location does not exist", "Cet emplacement n'existe pas");
    if (!loc.active) throw badRequest(`${loc.name} is switched off: switch it back on first`, `${loc.name} est désactivé : réactivez-le d'abord`);
  }
  const containerSchema = z.object({
    number: z.string().min(1).max(60),
    supplierId: id,
    status: z.enum(CONTAINER_STATUSES).exclude(["finalized"]).optional(),
    currency: z.string().transform((c) => c.toUpperCase()).pipe(z.enum(["USD", "CDF", "CNY"])).optional(),
    rateToUsd: positiveRate.optional(),
    locationId: id,
    shipDate: isoDate.optional().nullable(),
    arrivalDate: isoDate.optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  });
  /**
   * Container numbers are unique (as stored, in capitals), spaces and dashes aside: "HHU 2026 010" is
   * HHU-2026-010. Say which number, not "this value is already used".
   * The key is computed in JS (shared/containerNumber.ts) for every stored number, and creates and
   * renames wait for each other on a lock of the key, so two variants typed at once cannot both pass.
   * Older rows that already share a key stay as they are; only new numbers are checked.
   */
  async function assertContainerNumberFree(tx: Tx, number: string, exceptId?: number) {
    const wanted = number.trim().toUpperCase();
    const key = containerNumberKey(wanted);
    if (!key) throw badRequest("Enter a container number", "Saisissez un numéro de conteneur");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`container-number:${key}`}))`);
    const rows = await tx.select({ id: containers.id, number: containers.number }).from(containers);
    const other = rows.find((r) => r.id !== exceptId && containerNumberKey(r.number) === key);
    if (other) {
      const same = other.number === wanted ? "" : ` (${other.number})`;
      throw new AppError(409, `Container number ${wanted} already exists${same}`, "DUPLICATE_NUMBER", `Le numéro de conteneur ${wanted} existe déjà${same}`);
    }
  }
  app.post("/api/containers", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = containerSchema.parse(req.body);
    const [supplier] = await db.select().from(parties).where(eq(parties.id, body.supplierId));
    if (!supplier || supplier.type !== "supplier") throw badRequest("Pick a supplier", "Choisissez un fournisseur");
    await assertActiveLocation(db, body.locationId);
    if (body.rateToUsd) await containerSvc.assertContainerRate(db, body.currency ?? "USD", body.rateToUsd, todayIso());
    const row = await db.transaction(async (tx) => {
      await assertContainerNumberFree(tx, body.number);
      const [created] = await tx.insert(containers).values({ ...body, number: body.number.trim().toUpperCase(), currency: (body.currency ?? "USD").toUpperCase() }).returning();
      return created;
    });
    await audit(req, "create", "container", row.id);
    res.status(201).json(row);
  }));
  app.get("/api/containers/:id", requireRole(...READERS), asyncHandler(async (req, res) => {
    const c = await containerSvc.getContainer(db, paramId(req));
    const [supplier] = await db.select().from(parties).where(eq(parties.id, c.supplierId));
    let preview = null;
    let previewError = null;
    if (c.lines.length) {
      try {
        preview = await containerSvc.previewLandedCost(db, c.id);
      } catch (e) {
        previewError = e instanceof Error ? e.message : String(e);
      }
    }
    res.json({ ...c, supplierName: supplier?.name, preview, previewError });
  }));
  app.patch("/api/containers/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    // convertLinePrices: a new invoice currency also converts the saved lines' unit prices (draft lines only).
    const { convertLinePrices, ...body } = containerSchema.partial().extend({ convertLinePrices: z.boolean().optional() }).parse(req.body);
    const updated = await db.transaction(async (tx) => {
      const [c] = await tx.select().from(containers).where(eq(containers.id, paramId(req))).for("update");
      if (!c) throw notFound("Container", "Conteneur introuvable");
      if (c.status === "finalized") {
        const allowed = Object.keys(body).every((k) => ["notes", "shipDate", "arrivalDate"].includes(k));
        if (!allowed || convertLinePrices) throw conflict("This container is finalized. Only dates and notes can change.", "Ce conteneur est finalisé. Seules les dates et les notes peuvent être modifiées.");
      }
      if (body.rateToUsd) await containerSvc.assertContainerRate(tx, body.currency ?? c.currency, body.rateToUsd, todayIso());
      if (body.supplierId !== undefined) {
        const [supplier] = await tx.select().from(parties).where(eq(parties.id, body.supplierId));
        if (!supplier || supplier.type !== "supplier") throw badRequest("Pick a supplier", "Choisissez un fournisseur");
      }
      if (body.locationId !== undefined) await assertActiveLocation(tx, body.locationId);
      if (body.number !== undefined) await assertContainerNumberFree(tx, body.number, c.id);
      const [row] = await tx
        .update(containers)
        .set({ ...body, ...(body.number && { number: body.number.trim().toUpperCase() }), ...(body.currency && { currency: body.currency.toUpperCase() }) })
        .where(eq(containers.id, c.id))
        .returning();
      if (convertLinePrices && row.currency !== c.currency) await containerSvc.convertLinePrices(tx, c.id, c.rateToUsd, row.currency, row.rateToUsd);
      return row;
    });
    await audit(req, "update", "container", updated.id, convertLinePrices ? { ...body, convertLinePrices } : body);
    res.json(updated);
  }));
  app.put("/api/containers/:id/lines", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ lines: z.array(z.object({ variantId: id, quantity: positiveDecimal, unitPrice: nonNegativeDecimal, weightKg: optionalDecimal, volumeCbm: optionalDecimal })) }).parse(req.body);
    await db.transaction((tx) => containerSvc.replaceLines(tx, paramId(req), body.lines));
    await audit(req, "update_lines", "container", paramId(req), { lines: body.lines.length });
    res.json(await containerSvc.getContainer(db, paramId(req)));
  }));
  app.post("/api/containers/:id/expenses", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z
      .object({
        date: isoDate,
        type: z.enum(CONTAINER_EXPENSE_TYPES),
        description: z.string().max(300).optional().nullable(),
        amount: positiveDecimal,
        currency: z.enum(["USD", "CDF"]).default("USD"),
        rate: optionalRate,
        method: z.enum(ALLOCATION_METHODS).default("value"),
        targetLineId: optionalId,
        paidFromAccountId: optionalId,
        payablePartyId: optionalId,
      })
      .parse(req.body);
    const row = await db.transaction((tx) => containerSvc.addExpense(tx, paramId(req), body, uid(req)));
    await audit(req, "add_cost", "container", paramId(req), body);
    res.status(201).json(row);
  }));
  app.patch("/api/containers/:id/expenses/:expenseId", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ method: z.enum(ALLOCATION_METHODS), targetLineId: optionalId }).parse(req.body);
    await db.transaction((tx) => containerSvc.updateExpenseAllocation(tx, paramId(req), paramId(req, "expenseId"), body.method, body.targetLineId));
    await audit(req, "update_cost", "container", paramId(req), { expenseId: paramId(req, "expenseId"), ...body });
    res.json({ ok: true });
  }));
  app.delete("/api/containers/:id/expenses/:expenseId", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const q = z.object({ date: isoDate.optional() }).parse(req.query);
    await db.transaction((tx) => containerSvc.removeExpense(tx, paramId(req), paramId(req, "expenseId"), q.date ?? todayIso(), uid(req)));
    await audit(req, "remove_cost", "container", paramId(req), { expenseId: paramId(req, "expenseId") });
    res.json({ ok: true });
  }));
  app.post("/api/containers/:id/finalize", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ offloadDate: isoDate }).parse(req.body);
    const result = await db.transaction((tx) => containerSvc.finalizeContainer(tx, paramId(req), body.offloadDate, uid(req)));
    await audit(req, "finalize", "container", paramId(req), { landedTotalUsd: result.landedTotalUsd });
    res.json(result);
  }));
  app.post("/api/containers/:id/reverse", requireRole(), asyncHandler(async (req, res) => {
    const body = z.object({ date: isoDate }).parse(req.body);
    await db.transaction((tx) => containerSvc.reverseContainer(tx, paramId(req), body.date, uid(req)));
    await audit(req, "reverse", "container", paramId(req));
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- Sales

  app.get("/api/sales", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), customerId: optionalId, search: z.string().optional() }).parse(req.query);
    const conds = [];
    // Cashiers see today's sales only.
    if (req.user!.role === "cashier") conds.push(eq(sales.date, todayIso()));
    if (q.from) conds.push(gte(sales.date, q.from));
    if (q.to) conds.push(lte(sales.date, q.to));
    if (q.customerId) conds.push(eq(sales.customerId, q.customerId));
    if (q.search) conds.push(or(ilike(sales.number, `%${q.search}%`), ilike(parties.name, `%${q.search}%`))!);
    const rows = await db
      .select({
        sale: sales,
        customerName: parties.name,
        cashier: users.fullName,
        // A line sold at 0 $: almost always a price typed wrong, so the list flags it.
        zeroPrice: sql<boolean>`exists (select 1 from sale_lines sl where sl.sale_id = ${sales.id} and sl.unit_price <= 0)`,
        // What was sold, so the list reads without opening each sale.
        qty: sql<string>`(select coalesce(sum(sl.qty), 0)::text from sale_lines sl where sl.sale_id = ${sales.id})`,
        returnedQty: sql<string>`(select coalesce(sum(sl.returned_qty), 0)::text from sale_lines sl where sl.sale_id = ${sales.id})`,
        // Amount and cost of what came back, so the list shows the sale net of its returns.
        returnedTotal: sql<string>`(select coalesce(sum(sr.total), 0)::text from sale_returns sr where sr.sale_id = ${sales.id})`,
        returnedCogs: sql<string>`(select coalesce(sum(sr.cogs), 0)::text from sale_returns sr where sr.sale_id = ${sales.id})`,
        // Cash handed back on those returns (the refund drawer's line), so "Payé" reads net of refunds.
        // Francs count at the refund's rate, not at the drawer's average cost (the gap is an exchange difference).
        refundedUsd: sql<string>`(select coalesce(sum(case when jl.native_amount is not null and jl.rate > 0 then round(abs(jl.native_amount) / jl.rate, 2) else jl.credit end), 0)::text from sale_returns sr join journal_lines jl on jl.journal_id = sr.journal_id and jl.account_id = sr.refund_account_id where sr.sale_id = ${sales.id})`,
        // Credit still on the sale after returns, as the sale page reads it (see creditLeftSql).
        creditLeftUsd: sql<string>`${salesSvc.creditLeftSql()}::text`,
        // The till's and the refunds' franc rounding ("Arrondi FC"), + when the shop kept a few cents: it is why
        // "Payé" can sit a few cents off the total, and is not money on the customer's account. A cancelled
        // sale's reversal takes its rounding back, so it nets to zero.
        fcRoundingUsd: sql<string>`(select coalesce(sum(jl.credit - jl.debit), 0)::numeric(20,2)::text from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'fx' where jl.memo = 'Arrondi FC' and (jl.journal_id = ${sales.journalId} or jl.journal_id = ${sales.voidJournalId} or jl.journal_id in (select sr.journal_id from sale_returns sr where sr.sale_id = ${sales.id})))`,
        // The part of the credit the customer's avoir covered when the sale was posted, as the sale page reads it:
        // none on a cancelled sale, which gave it back, and at most the credit left after returns (see avoirUsedSql).
        avoirUsedUsd: sql<string>`${salesSvc.avoirUsedSql()}::text`,
        // The same at the sale, before returns took it down, as the sale page shows it (none on a cancelled sale).
        avoirAtSaleUsd: sql<string>`(case when ${sales.status} <> 'voided' then ${salesSvc.avoirPartSql()} else 0 end)::text`,
        // A cancelled sale: what of its credit the avoir had covered, given back to it, as the sale page says
        // (S-000026: "20,00 $ remboursés · 110,00 $ rendus à l'avoir", not "crédit annulé"). Read only.
        avoirGivenBackUsd: sql<string>`(case when ${sales.status} = 'voided' then ${salesSvc.avoirPartSql()} else 0 end)::numeric(20,2)::text`,
        // The francs a sale paid in francs alone kept, net: taken at the till (less change) less handed back on
        // returns. Below zero when a refund at a higher rate gave back more francs than were paid, which the list
        // says apart from the rounding's dollars (+0,02 $ kept at the refund's rate, the drawer 1 000 FC down).
        // Null for a sale that took dollars too or no francs: there, francs back beyond those paid are no rate gap.
        fcNetNative: sql<string | null>`(case when not exists (select 1 from sale_payments sp where sp.sale_id = ${sales.id} and sp.currency <> 'CDF' and sp.amount_native > 0) and (select coalesce(sum(sp.amount_native), 0) from sale_payments sp where sp.sale_id = ${sales.id} and sp.currency = 'CDF') > 0 then ((select coalesce(sum(sp.amount_native), 0) from sale_payments sp where sp.sale_id = ${sales.id} and sp.currency = 'CDF') - (select coalesce(sum(abs(jl.native_amount)), 0) from sale_returns sr join journal_lines jl on jl.journal_id = sr.journal_id and jl.account_id = sr.refund_account_id join accounts a on a.id = jl.account_id and a.currency = 'CDF' where sr.sale_id = ${sales.id}))::numeric(20,2)::text end)`,
        // The till's rounding alone: with it, "Payé" is the cash the shop really kept (see paidKeptUsd).
        saleFcRoundingUsd: sql<string>`(select coalesce(sum(jl.credit - jl.debit), 0)::numeric(20,2)::text from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'fx' where jl.memo = 'Arrondi FC' and jl.journal_id = ${sales.journalId})`,
        lineCount: sql<number>`(select count(*)::int from sale_lines sl where sl.sale_id = ${sales.id})`,
        firstItem: sql<string | null>`(select p.name from sale_lines sl join variants v on v.id = sl.variant_id join products p on p.id = v.product_id where sl.sale_id = ${sales.id} order by sl.id limit 1)`,
      })
      .from(sales)
      .leftJoin(parties, eq(parties.id, sales.customerId))
      .leftJoin(users, eq(users.id, sales.createdBy))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(sales.date), desc(sales.id))
      .limit(500);
    const showCost = req.user!.role !== "cashier";
    res.json(rows.map((r) => ({ ...r.sale, cogs: showCost ? r.sale.cogs : undefined, customerName: r.customerName, cashier: r.cashier, zeroPrice: !!r.zeroPrice, qty: r.qty, returnedQty: r.returnedQty, returnedTotal: r.returnedTotal, returnedCogs: showCost ? r.returnedCogs : undefined, refundedUsd: r.refundedUsd, creditLeftUsd: r.creditLeftUsd, fcRoundingUsd: r.fcRoundingUsd, fcNetNative: r.fcNetNative, paidKeptUsd: salesSvc.paidKept(r.sale, r.saleFcRoundingUsd, r.refundedUsd), avoirUsedUsd: r.avoirUsedUsd, avoirAtSaleUsd: r.avoirAtSaleUsd, avoirGivenBackUsd: r.avoirGivenBackUsd, lineCount: r.lineCount, firstItem: r.firstItem })));
  }));
  app.get("/api/sales/:id", requireRole(...EVERYONE), asyncHandler(async (req, res) => {
    const sale = await salesSvc.getSale(db, paramId(req));
    if (req.user!.role === "cashier") {
      res.json(withoutCost(sale));
      return;
    }
    res.json(sale);
  }));
  app.post("/api/sales", requireRole(...SELLERS), asyncHandler(async (req, res) => {
    const body = z
      .object({
        date: isoDate.optional(),
        locationId: id,
        customerId: optionalId,
        discount: optionalDecimal,
        note: z.string().max(500).optional().nullable(),
        lines: z.array(z.object({ variantId: id, unitId: optionalId, qty: positiveDecimal, unitPrice: nonNegativeDecimal, lineDiscount: optionalDecimal })).min(1),
        payments: z.array(paymentSchema),
        change: paymentSchema.nullish(),
        // The franc rate the till showed: staff francs go at the day's rate, and a till on an older one is refused.
        tillRate: optionalRate,
        // The customer's balance the till showed: a sale the avoir would now cover otherwise is refused.
        tillBalance: optionalDecimal,
      })
      .parse(req.body);
    // Cashiers always sell today.
    const date = req.user!.role === "cashier" || !body.date ? todayIso() : body.date;
    // Cashiers take francs at the day's rate.
    if (req.user!.role === "cashier") {
      body.payments = body.payments.map((p) => ({ ...p, rate: null }));
      if (body.change) body.change = { ...body.change, rate: null };
    }
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { ...body, date }, uid(req), { role: req.user!.role }));
    res.status(201).json(req.user!.role === "cashier" ? withoutCost(sale) : sale);
  }));
  // The till asks before "Valider" which lines the sale would refuse as below cost (see linesBelowCost): a
  // yes or no per item, never the cost. Read only, so nothing is posted.
  app.post("/api/sales/price-check", requireRole(...SELLERS), asyncHandler(async (req, res) => {
    const body = z.object({ lines: z.array(z.object({ variantId: id, qty: positiveDecimal, amount: decimalString })).max(200) }).parse(req.body);
    const refused = await salesSvc.linesBelowCost(db, req.user!.role, body.lines);
    res.json({ refused });
  }));
  app.post("/api/sales/:id/void", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().min(1).max(300), date: isoDate.optional() }).parse(req.body);
    const sale = await db.transaction((tx) => salesSvc.voidSale(tx, paramId(req), body.date ?? todayIso(), body.reason, uid(req)));
    await audit(req, "void", "sale", sale.id, body);
    res.json(sale);
  }));
  app.post("/api/sales/:id/returns", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z
      .object({ date: isoDate.optional(), reason: z.string().min(1).max(300), refundAccountId: optionalId, rate: optionalRate, lines: z.array(z.object({ saleLineId: id, qty: positiveDecimal })).min(1) })
      .parse(req.body);
    const date = body.date ?? todayIso();
    const sale = await db.transaction(async (tx) => {
      // Staff hand francs back at the day's rate. A dialog showing another one (the rate changed since it
      // opened) is refused rather than paid out at a rate it did not show; no rate sent is the day's.
      if (req.user!.role !== "owner") {
        if (body.rate) {
          const day = await rateFor(tx, date);
          if (!dec(body.rate).equals(day.rate)) {
            const was = frNumber(dec(body.rate).toString());
            const now = frNumber(day.rate.toString());
            throw conflict(
              `Refunds go at the day's rate (${now} FC), not ${was}: check the amount to hand back`,
              `Le remboursement se fait au taux du jour (${now}\u00a0FC), pas à ${was}\u00a0: vérifiez le montant à rendre`,
            );
          }
        }
        body.rate = null;
      }
      return salesSvc.returnSale(tx, paramId(req), { ...body, date }, uid(req));
    });
    await audit(req, "return", "sale", sale.id, body);
    res.json(sale);
  }));

  // ---------------------------------------------------------------- Partners & months

  app.get("/api/partners", requireRole(...READERS), asyncHandler(async (req, res) => {
    const rows = await reports.partnerSummaries(db);
    res.json(req.user!.role === "partner" ? rows.filter((r) => r.id === req.user!.partnerId) : rows);
  }));
  app.put("/api/partners", requireRole(), asyncHandler(async (req, res) => {
    const body = z.object({ partners: z.array(z.object({ id, name: z.string().min(1).max(80), sharePct: decimalString, bearsOperatingExpenses: z.boolean() })).min(1) }).parse(req.body);
    validatePartnerShares(body.partners);
    await db.transaction(async (tx) => {
      // Shares apply to months closed from now on; closed months keep the split they were closed with.
      const existing = await tx.select().from(partners);
      for (const p of body.partners) {
        const row = existing.find((e) => e.id === p.id);
        if (!row) throw notFound("Partner", "Associé introuvable");
        await tx.update(partners).set({ name: p.name, sharePct: dec(p.sharePct).toFixed(2), bearsOperatingExpenses: p.bearsOperatingExpenses }).where(eq(partners.id, p.id));
        await tx.update(accounts).set({ name: `${p.name}\u00a0: capital` }).where(eq(accounts.id, row.capitalAccountId));
        await tx.update(accounts).set({ name: `${p.name}\u00a0: compte de bénéfices` }).where(eq(accounts.id, row.currentAccountId));
      }
    });
    await audit(req, "update", "partners", null, body);
    res.json(await reports.partnerSummaries(db));
  }));
  app.get("/api/partners/:id/statement", requireRole(...READERS), asyncHandler(async (req, res) => {
    const partnerId = paramId(req);
    if (req.user!.role === "partner" && req.user!.partnerId !== partnerId) throw notFound("Partner", "Associé introuvable");
    res.json(await reports.partnerStatement(db, partnerId));
  }));

  /** A partner sees the other partners of a month's split without their names. */
  const maskSplit = <T,>(req: Request, value: T): T => {
    if (req.user!.role !== "partner" || !value) return value;
    const me = req.user!.partnerId;
    const rename = (p: { partnerId?: number; id?: number; name: string }) => ((p.partnerId ?? p.id) === me ? p : { ...p, name: "Autre associé" });
    const v = value as Record<string, unknown>;
    const split = v.split as { partners?: { partnerId: number; name: string }[] } | undefined;
    const result = v.result as { split?: { partners?: { partnerId: number; name: string }[] } } | null | undefined;
    return {
      ...v,
      ...(split?.partners ? { split: { ...split, partners: split.partners.map(rename) } } : {}),
      ...(result?.split?.partners ? { result: { ...result, split: { ...result.split, partners: result.split.partners.map(rename) } } } : {}),
      ...(Array.isArray(v.shares) ? { shares: (v.shares as { id: number; name: string }[]).map(rename) } : {}),
    } as T;
  };
  /** The first day anything was booked, so month pickers do not offer months before the shop's books start. */
  app.get("/api/books/first-date", requireRole(...READERS), asyncHandler(async (_req, res) => {
    const [row] = await db.select({ date: sql<string | null>`min(${journals.date})::text` }).from(journals);
    res.json({ date: row?.date ?? null });
  }));
  app.get("/api/periods", requireRole(...READERS), asyncHandler(async (req, res) => {
    const rows = await db.select().from(periods).orderBy(desc(periods.month));
    res.json(rows.map((r) => maskSplit(req, r)));
  }));
  app.get("/api/periods/:month", requireRole(...READERS), asyncHandler(async (req, res) => {
    res.json(maskSplit(req, await periodSvc.previewPeriod(db, month.parse(req.params.month))));
  }));
  app.post("/api/periods/:month/close", requireRole(), asyncHandler(async (req, res) => {
    const m = month.parse(req.params.month);
    const result = await db.transaction((tx) => periodSvc.closePeriod(tx, m, uid(req)));
    await audit(req, "close", "period", null, { month: m, split: result.split });
    res.json(result);
  }));
  app.post("/api/periods/:month/reopen", requireRole(), asyncHandler(async (req, res) => {
    const m = month.parse(req.params.month);
    await db.transaction((tx) => periodSvc.reopenPeriod(tx, m, uid(req)));
    await audit(req, "reopen", "period", null, { month: m });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- Reports

  app.get("/api/reports/dashboard", requireRole(...READERS), asyncHandler(async (req, res) => {
    const data = await reports.dashboard(db, todayIso());
    if (req.user!.role === "partner") data.partners = data.partners.filter((p) => p.id === req.user!.partnerId);
    res.json(data);
  }));
  app.get("/api/reports/profit-loss", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    res.json(await reports.profitAndLoss(db, q.from, q.to));
  }));
  app.get("/api/reports/self-check", requireRole(...READERS), asyncHandler(async (_req, res) => {
    res.json(await checks.selfCheck(db));
  }));
  app.get("/api/reports/ageing", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ asOf: isoDate.optional() }).parse(req.query);
    res.json(await checks.customerAgeing(db, q.asOf ?? todayIso()));
  }));
  app.get("/api/reports/balance-sheet", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ asOf: isoDate.optional() }).parse(req.query);
    res.json(await reports.balanceSheet(db, q.asOf, req.user!.role === "partner" ? req.user!.partnerId : undefined));
  }));
  app.get("/api/reports/trial-balance", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ asOf: isoDate.optional() }).parse(req.query);
    res.json(await reports.trialBalance(db, q.asOf, req.user!.role === "partner" ? req.user!.partnerId : undefined));
  }));
  app.get("/api/reports/sales-by-product", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    res.json(await reports.salesByProduct(db, q.from, q.to));
  }));
  app.get("/api/reports/daily", requireRole(...READERS, "cashier"), asyncHandler(async (req, res) => {
    const q = z.object({ date: isoDate.optional() }).parse(req.query);
    const date = req.user!.role === "cashier" ? todayIso() : q.date ?? todayIso();
    // A sale counts on its own day even if it was cancelled later; a cancellation counts on the day
    // it was made. The drawer below books them the same way, so the two always agree.
    // Per account: the net kept, and apart what was handed over and what went back as change (a
    // negative payment); a sale cancelled that day takes its own amounts back out.
    const result = await db.execute<{ account_id: number; name: string; currency: string; usd: string; native: string; received_usd: string; received_native: string; change_usd: string; change_native: string; refund_usd: string; refund_native: string }>(sql`
      select x.account_id, a.name, a.currency, sum(x.usd) as usd, sum(x.native) as native,
        coalesce(sum(x.usd) filter (where not x.change and not x.refund), 0) as received_usd,
        coalesce(sum(x.native) filter (where not x.change and not x.refund), 0) as received_native,
        coalesce(-sum(x.usd) filter (where x.change), 0) as change_usd,
        coalesce(-sum(x.native) filter (where x.change), 0) as change_native,
        coalesce(-sum(x.usd) filter (where x.refund), 0) as refund_usd,
        coalesce(-sum(x.native) filter (where x.refund), 0) as refund_native
      from (
        select p.account_id, p.amount_usd as usd, p.amount_native as native, p.amount_usd < 0 as change, false as refund
          from sale_payments p join sales s on s.id = p.sale_id
          where s.date = ${date}
        union all
        select p.account_id, -p.amount_usd, -p.amount_native, p.amount_usd < 0, false
          from sale_payments p join sales s on s.id = p.sale_id join journals vj on vj.id = s.void_journal_id
          where vj.date = ${date}
        union all
        -- Refunds of goods brought back that day leave the drawer they were paid from. Francs count at the
        -- refund's rate, as the sale page and the Sales list read them, not at the drawer's average cost (the
        -- gap is an exchange difference), so the day's figures add up to its rows.
        select l.account_id,
          case when l.native_amount is not null and l.rate > 0 then round(l.native_amount / l.rate, 2) else l.debit - l.credit end,
          coalesce(l.native_amount, l.debit - l.credit), false, true
          from journal_lines l join journals j on j.id = l.journal_id join accounts ma on ma.id = l.account_id
          where j.type = 'sale_return' and ma.is_money and j.date = ${date}
      ) x join accounts a on a.id = x.account_id
      group by x.account_id, a.name, a.currency
      order by a.name
    `);
    const [totals] = await db
      .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${sales.total}), 0)`, credit: sql<string>`coalesce(sum(${sales.creditUsd}), 0)` })
      .from(sales)
      .where(eq(sales.date, date));
    const voids = await db.execute<{ count: number; total: string; credit: string }>(sql`
      select count(*)::int as count, coalesce(sum(s.total), 0) as total, coalesce(sum(s.credit_usd), 0) as credit
      from sales s join journals vj on vj.id = s.void_journal_id
      where vj.date = ${date}
    `);
    const [returns] = await db
      .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${saleReturns.total}), 0)` })
      .from(saleReturns)
      .where(eq(saleReturns.date, date));
    // Credit on the day's sales that returns have since taken off (however they were refunded), so "of
    // which on credit" reads after returns, as on the Sales list (see creditLeftSql).
    const [creditReturned] = await db
      .select({ usd: sql<string>`coalesce(sum(${sales.creditUsd} - ${salesSvc.creditLeftSql()}), 0)` })
      .from(sales)
      .where(and(eq(sales.date, date), sql`${sales.creditUsd} > 0`));
    // The part of that credit a customer's avoir (paid ahead) covered when the sale was posted, read as the sale
    // page reads it: nothing new is owed for it, so the card says "dont sur l'avoir" apart from "dont à crédit".
    // Like the credit, a sale keeps it on its own day and a cancellation takes it back on the day it was made;
    // and like it, it reads after returns (at most the credit left, as the Sales list splits each sale).
    const [creditOnAvoir] = await db
      .select({ usd: sql<string>`coalesce(sum(least(${salesSvc.avoirPartSql()}, ${salesSvc.creditLeftSql()})), 0)` })
      .from(sales)
      .where(and(eq(sales.date, date), sql`${sales.creditUsd} > 0`));
    const [avoirVoided] = await db
      .select({ usd: sql<string>`coalesce(sum(${salesSvc.avoirPartSql()}), 0)` })
      .from(sales)
      .innerJoin(journals, eq(journals.id, sales.voidJournalId))
      .where(and(eq(journals.date, date), sql`${sales.creditUsd} > 0`));
    // Drawer count (not for cashiers, who do not see balances): every money account's opening
    // balance, what came in and went out that day by kind of operation, and the expected closing.
    let drawer: unknown = undefined;
    if (req.user!.role !== "cashier") {
      // Francs in and out are summed apart, as dollars are: a sale's franc change reads as money out
      // ("+200 000 FC −16 000 FC"), not netted into what came in.
      const moves = await db.execute<{ account_id: number; type: string; debit: string; credit: string; native_in: string | null; native_out: string | null }>(sql`
        select l.account_id, j.type, sum(l.debit) as debit, sum(l.credit) as credit,
          sum(greatest(l.native_amount, 0)) as native_in, sum(greatest(-l.native_amount, 0)) as native_out
        from journal_lines l join journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
        where a.is_money and j.date = ${date}
        group by l.account_id, j.type
      `);
      const opening = await db.execute<{ account_id: number; usd: string; native: string | null }>(sql`
        select l.account_id, sum(l.debit - l.credit) as usd, sum(l.native_amount) as native
        from journal_lines l join journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
        where a.is_money and j.date < ${date}
        group by l.account_id
      `);
      const moneyAccounts = await db.select().from(accounts).where(and(eq(accounts.isMoney, true), eq(accounts.active, true))).orderBy(asc(accounts.code));
      drawer = moneyAccounts.map((a) => {
        const cdf = a.currency === "CDF";
        const o = opening.rows.find((r) => r.account_id === a.id);
        const rows = moves.rows.filter((r) => r.account_id === a.id);
        // For a CDF account the native amount is signed (+ in, − out).
        const amountIn = (r: (typeof rows)[number]) => (cdf ? dec(r.native_in ?? 0) : dec(r.debit));
        const amountOut = (r: (typeof rows)[number]) => (cdf ? dec(r.native_out ?? 0) : dec(r.credit));
        const openingAmt = dec(cdf ? o?.native ?? 0 : o?.usd ?? 0);
        const totalIn = rows.reduce((s, r) => s.plus(amountIn(r)), dec(0));
        const totalOut = rows.reduce((s, r) => s.plus(amountOut(r)), dec(0));
        return {
          accountId: a.id,
          name: a.name,
          currency: a.currency,
          opening: openingAmt.toFixed(2),
          totalIn: totalIn.toFixed(2),
          totalOut: totalOut.toFixed(2),
          closing: openingAmt.plus(totalIn).minus(totalOut).toFixed(2),
          byType: rows.map((r) => ({ type: r.type, in: amountIn(r).toFixed(2), out: amountOut(r).toFixed(2) })),
        };
      });
    }
    // The day's sales still standing less the day's returns: the dashboard's "Aujourd'hui" and the Sales list's
    // figure, which the report leads with; "total" stays the day's sales as made, cancelled ones included.
    const [standing] = await db
      .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${sales.total}), 0)` })
      .from(sales)
      .where(and(eq(sales.date, date), eq(sales.status, "completed")));
    const v = voids.rows[0];
    res.json({
      date,
      count: totals.count,
      total: dec(totals.total).toFixed(2),
      netCount: standing.count,
      netTotal: dec(standing.total).minus(returns.total).toFixed(2),
      credit: dec(totals.credit).minus(v.credit).minus(creditReturned?.usd ?? 0).toFixed(2),
      creditOnAvoirUsd: dec(creditOnAvoir?.usd ?? 0).minus(avoirVoided?.usd ?? 0).toFixed(2),
      voidsCount: v.count,
      voidsTotal: dec(v.total).toFixed(2),
      returnsCount: returns.count,
      returnsTotal: dec(returns.total).toFixed(2),
      byAccount: result.rows.filter((r) => !dec(r.usd).isZero() || !dec(r.native).isZero()),
      drawer,
    });
  }));
  app.get("/api/audit", requireRole(), asyncHandler(async (req, res) => {
    const q = z
      .object({ userId: optionalId, from: isoDate.optional(), to: isoDate.optional(), entity: z.string().max(40).optional(), q: z.string().max(100).optional(), before: optionalId })
      .parse(req.query);
    // Days are Kalemie days (UTC+2), like every other date in the app.
    const localDay = sql`(${auditLog.createdAt} + interval '2 hours')::date`;
    const conds = [];
    if (q.userId) conds.push(eq(auditLog.userId, q.userId));
    if (q.from) conds.push(sql`${localDay} >= ${q.from}`);
    if (q.to) conds.push(sql`${localDay} <= ${q.to}`);
    if (q.entity) conds.push(eq(auditLog.entity, q.entity));
    if (q.before) conds.push(sql`${auditLog.id} < ${q.before}`);
    if (q.q?.trim()) conds.push(sql`${auditLog.data}::text ilike ${`%${q.q.trim()}%`}`);
    const rows = await db
      .select({ log: auditLog, username: users.username, fullName: users.fullName })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(500);
    res.json(rows.map((r) => ({ ...r.log, username: r.username, fullName: r.fullName })));
  }));
  app.get("/api/audit/entities", requireRole(), asyncHandler(async (_req, res) => {
    const rows = await db.selectDistinct({ entity: auditLog.entity }).from(auditLog).orderBy(asc(auditLog.entity));
    res.json(rows.map((r) => r.entity));
  }));

  registerErpRoutes(app, { adjustmentSchema, journalSchema, transferSchema, audit, assertAccountVisible });
}
