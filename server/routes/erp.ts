import type { Express, Request } from "express";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, DRAFT_KINDS, journalLines, journals, parties, saleReturns, users, type DraftKind } from "@shared/schema";
import { dec } from "@shared/money";
import { db } from "../db";
import { forbidden, notFound } from "../errors";
import { requireRole } from "../auth";
import { asyncHandler, decimalString, id, isoDate, month, optionalDecimal, optionalId, paramId, positiveDecimal, todayIso } from "../http";
import * as vouchers from "../services/vouchers";
import * as payroll from "../services/payroll";
import * as imports from "../services/imports";
import * as insights from "../services/insights";
import * as reports from "../services/reports";
import * as containerSvc from "../services/containers";

const STAFF = ["manager"] as const; // owner is always allowed
const READERS = ["manager", "partner"] as const;
const uid = (req: Request) => req.user!.id;

type Schema = z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;

export function registerErpRoutes(
  app: Express,
  deps: {
    adjustmentSchema: Schema;
    journalSchema: Schema;
    transferSchema: Schema;
    audit: (req: Request, action: string, entity: string, entityId: number | null, data?: unknown) => Promise<void>;
    assertAccountVisible: (req: Request, accountId: number) => Promise<void>;
  },
) {
  const { audit, assertAccountVisible } = deps;

  // ---------------------------------------------------------------- Payment & receipt vouchers

  const voucherSchema = z.object({
    date: isoDate,
    accountId: id,
    rate: optionalDecimal,
    memo: z.string().max(300).optional().nullable(),
    lines: z.array(z.object({ partyId: optionalId, accountId: optionalId, amount: positiveDecimal, memo: z.string().max(300).optional().nullable() })).min(1).max(100),
  });

  for (const kind of ["payment", "receipt"] as const) {
    app.post(`/api/vouchers/${kind}`, requireRole(...STAFF), asyncHandler(async (req, res) => {
      const body = voucherSchema.parse(req.body);
      const result = await db.transaction((tx) => vouchers.postVoucher(tx, kind, body, uid(req), { owner: req.user!.role === "owner" }));
      await audit(req, "create", kind, result.id, body);
      res.status(201).json(result);
    }));
  }

  /** One journal with its lines, for the voucher print and the daybook detail. */
  app.get("/api/vouchers/:id", requireRole(...READERS), asyncHandler(async (req, res) => {
    const [j] = await db
      .select({ journal: journals, createdByName: users.fullName })
      .from(journals)
      .leftJoin(users, eq(users.id, journals.createdBy))
      .where(eq(journals.id, paramId(req)));
    if (!j) throw notFound("Voucher", "Pièce introuvable");
    const lines = await db
      .select({ line: journalLines, accountName: accounts.name, accountCode: accounts.code, accountType: accounts.type, isMoney: accounts.isMoney, partyName: parties.name })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .leftJoin(parties, eq(parties.id, journalLines.partyId))
      .where(eq(journalLines.journalId, j.journal.id))
      .orderBy(journalLines.id);
    res.json({
      ...j.journal,
      createdByName: j.createdByName,
      total: lines.reduce((s, l) => s.plus(l.line.debit), dec(0)).toFixed(2),
      lines: lines.map((l) => ({ ...l.line, accountName: l.accountName, accountCode: l.accountCode, accountType: l.accountType, isMoney: l.isMoney, partyName: l.partyName })),
    });
  }));

  // ---------------------------------------------------------------- Daybook

  const SALE_JOURNALS = new Set<string>(["sale", "sale_void", "sale_return"]);
  app.get("/api/daybook", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate, to: isoDate, type: z.string().max(40).optional(), q: z.string().max(100).optional() }).parse(req.query);
    const conds = [gte(journals.date, q.from), lte(journals.date, q.to)];
    if (q.type) conds.push(eq(journals.type, q.type as never));
    if (q.q?.trim()) {
      const s = `%${q.q.trim()}%`;
      conds.push(
        or(
          ilike(journals.number, s),
          ilike(journals.memo, s),
          sql`exists (select 1 from ${journalLines} l left join ${parties} p on p.id = l.party_id where l.journal_id = ${journals.id} and (p.name ilike ${s} or l.memo ilike ${s}))`,
        )!,
      );
    }
    const js = await db
      .select({ journal: journals, createdByName: users.fullName })
      .from(journals)
      .leftJoin(users, eq(users.id, journals.createdBy))
      .where(and(...conds))
      .orderBy(desc(journals.date), desc(journals.id))
      .limit(1000);
    const ids = js.map((j) => j.journal.id);
    const lines = ids.length
      ? await db
          .select({ line: journalLines, accountName: accounts.name, accountCode: accounts.code, isMoney: accounts.isMoney, systemKey: accounts.systemKey, partyName: parties.name })
          .from(journalLines)
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .leftJoin(parties, eq(parties.id, journalLines.partyId))
          .where(inArray(journalLines.journalId, ids))
          .orderBy(journalLines.id)
      : [];
    const returnIds = js.filter((j) => j.journal.sourceType === "sale_return" && j.journal.sourceId).map((j) => j.journal.sourceId!);
    const returns = returnIds.length ? await db.select({ id: saleReturns.id, saleId: saleReturns.saleId }).from(saleReturns).where(inArray(saleReturns.id, returnIds)) : [];
    const byJournal = new Map<number, typeof lines>();
    for (const l of lines) byJournal.set(l.line.journalId, [...(byJournal.get(l.line.journalId) ?? []), l]);
    let moneyIn = dec(0);
    let moneyOut = dec(0);
    const rows = js.map(({ journal, createdByName }) => {
      const ls = byJournal.get(journal.id) ?? [];
      for (const l of ls) {
        if (!l.isMoney) continue;
        moneyIn = moneyIn.plus(l.line.debit);
        moneyOut = moneyOut.plus(l.line.credit);
      }
      return {
        ...journal,
        createdByName,
        /** The sale behind a sale, cancellation or return, for the "open" link. */
        saleId:
          journal.sourceType === "sale" || journal.sourceType === "sale_void"
            ? journal.sourceId
            : journal.sourceType === "sale_return"
              ? (returns.find((r) => r.id === journal.sourceId)?.saleId ?? null)
              : null,
        // A sale's amount is what the customer pays, not that plus the cost of the goods (cost of sales / stock lines).
        amount: ls
          .filter((l) => !(SALE_JOURNALS.has(journal.type) && (l.systemKey === "cogs" || l.systemKey === "inventory")))
          .reduce((s, l) => s.plus(l.line.debit), dec(0))
          .toFixed(2),
        lines: ls.map((l) => ({ ...l.line, accountName: l.accountName, accountCode: l.accountCode, isMoney: l.isMoney, partyName: l.partyName })),
      };
    });
    res.json({ from: q.from, to: q.to, rows, moneyIn: moneyIn.toFixed(2), moneyOut: moneyOut.toFixed(2), truncated: js.length === 1000 });
  }));

  // ---------------------------------------------------------------- Optional vouchers

  const payloadSchemas: Record<DraftKind, Schema> = {
    payment: voucherSchema as unknown as Schema,
    receipt: voucherSchema as unknown as Schema,
    journal: deps.journalSchema,
    transfer: deps.transferSchema,
    adjustment: deps.adjustmentSchema,
  };

  app.get("/api/voucher-drafts", requireRole(...READERS), asyncHandler(async (_req, res) => {
    const rows = await db.transaction((tx) => vouchers.listDrafts(tx));
    const names = await db.select({ id: users.id, fullName: users.fullName }).from(users);
    res.json(rows.map((r) => ({ ...r, createdByName: names.find((n) => n.id === r.createdBy)?.fullName ?? null })));
  }));
  app.post("/api/voucher-drafts", requireRole(...STAFF), asyncHandler(async (req, res) => {
    // Drafts may be incomplete, so only the shape is checked here; finalizing runs the full checks.
    const body = z
      .object({ id: optionalId, kind: z.enum(DRAFT_KINDS), date: isoDate, memo: z.string().max(300).optional().nullable(), payload: z.record(z.string(), z.unknown()) })
      .parse(req.body);
    const row = await db.transaction((tx) => vouchers.saveDraft(tx, body, uid(req)));
    res.status(body.id ? 200 : 201).json(row);
  }));
  app.delete("/api/voucher-drafts/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    await db.transaction((tx) => vouchers.deleteDraft(tx, paramId(req)));
    await audit(req, "delete", "voucher_draft", paramId(req));
    res.json({ ok: true });
  }));
  app.post("/api/voucher-drafts/:id/finalize", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const result = await db.transaction((tx) =>
      vouchers.finalizeDraft(tx, paramId(req), uid(req), { owner: req.user!.role === "owner" }, (kind, payload) => {
        if (kind === "journal" && req.user!.role !== "owner") {
          throw forbidden("Only the owner can post a journal entry", "Seul le propriétaire peut passer une écriture");
        }
        return payloadSchemas[kind].parse(payload);
      }),
    );
    await audit(req, "finalize", "voucher_draft", paramId(req), result);
    res.json(result);
  }));

  // ---------------------------------------------------------------- Payroll

  app.get("/api/payroll", requireRole(...READERS), asyncHandler(async (_req, res) => {
    const [employees, runs, salaryAccountId] = await Promise.all([payroll.employees(db), payroll.listRuns(db), payroll.salaryAccountId(db)]);
    res.json({ employees, runs, salaryAccountId });
  }));
  app.post("/api/payroll/runs", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z
      .object({
        month,
        date: isoDate.optional().nullable(),
        accountId: id,
        currency: z.enum(["USD", "CDF"]).optional().nullable(),
        rate: optionalDecimal,
        lines: z
          .array(z.object({ partyId: id, salary: decimalString, bonus: optionalDecimal, withheld: optionalDecimal, penalty: optionalDecimal, deduction: optionalDecimal }))
          .min(1),
      })
      .parse(req.body);
    const run = await db.transaction((tx) => payroll.runPayroll(tx, body, uid(req)));
    await audit(req, "create", "payroll_run", run.id, body);
    res.status(201).json(run);
  }));
  app.post("/api/payroll/runs/:month/cancel", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const m = month.parse(req.params.month);
    const body = z.object({ date: isoDate.optional() }).parse(req.body ?? {});
    await db.transaction((tx) => payroll.cancelRun(tx, m, body.date ?? null, uid(req)));
    await audit(req, "cancel", "payroll_run", null, { month: m });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- Spreadsheet imports

  const cell = z.union([z.string().max(200), z.number(), z.null()]).optional().transform((v) => (v === undefined || v === null ? null : String(v).trim()));
  const num = z.union([z.string().max(40), z.number(), z.null()]).optional().transform((v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).replace(/[\s,]/g, "").replace(/\$/g, "");
    return s === "" ? null : s;
  });
  const itemRow = z.object({
    name: cell.transform((v) => v ?? ""),
    category: cell,
    brand: cell,
    unit: cell,
    size: cell,
    colour: cell,
    sku: cell,
    barcode: cell,
    sellPrice: num,
    reorderLevel: num,
    motorcycle: z.union([z.boolean(), z.string(), z.number(), z.null()]).optional().transform((v) => v === true || v === 1 || (typeof v === "string" && /^(yes|oui|y|o|1|true|vrai|moto)$/i.test(v.trim()))),
  });
  const stockRow = itemRow.extend({ qty: num, unitCost: num });
  const containerRow = itemRow.extend({ quantity: num.transform((v) => v ?? ""), unitPrice: num.transform((v) => v ?? ""), weightKg: num, volumeCbm: num });

  app.post("/api/import/items/preview", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ rows: z.array(itemRow).max(5000) }).parse(req.body);
    res.json(await db.transaction((tx) => imports.previewItems(tx, body.rows)));
  }));
  app.post("/api/import/items", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ date: isoDate, locationId: id, updatePrices: z.boolean().optional(), rows: z.array(stockRow).min(1).max(5000) }).parse(req.body);
    // Quantities in the file become opening stock (Cr opening balances), which only the owner may enter.
    if (req.user!.role !== "owner" && body.rows.some((r) => r.qty && !dec(r.qty).isZero())) {
      throw forbidden("Only the owner can import opening stock. Remove the quantities to import the items only.", "Seul le propriétaire peut importer du stock d'ouverture. Retirez les quantités pour importer seulement les articles.");
    }
    const result = await db.transaction((tx) => imports.importItems(tx, body, uid(req)));
    await audit(req, "import", "items", null, { rows: body.rows.length, created: result.created, stockLines: result.stockLines });
    res.status(201).json(result);
  }));
  app.post("/api/import/prices", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ rows: z.array(z.object({ sku: cell, barcode: cell, sellPrice: num.transform((v) => v ?? "") })).min(1).max(5000) }).parse(req.body);
    const result = await db.transaction((tx) => imports.updatePrices(tx, body.rows));
    await audit(req, "import", "prices", null, result);
    res.json(result);
  }));
  app.post("/api/containers/:id/import-lines", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const body = z.object({ mode: z.enum(["append", "replace"]), rows: z.array(containerRow).min(1).max(5000) }).parse(req.body);
    const result = await db.transaction((tx) => imports.importContainerLines(tx, paramId(req), body));
    await audit(req, "import", "container_lines", paramId(req), { rows: body.rows.length, ...result });
    res.json({ ...result, container: await containerSvc.getContainer(db, paramId(req)) });
  }));

  // ---------------------------------------------------------------- Accounts, inventory, analytics

  app.get("/api/accounts/balances", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ asOf: isoDate.optional() }).parse(req.query);
    const rows = await reports.accountBalances(db, q.asOf);
    res.json(req.user!.role === "partner" ? reports.maskOtherPartners(rows, req.user!.partnerId) : rows);
  }));
  app.get("/api/accounts/:id/monthly", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
    await assertAccountVisible(req, paramId(req));
    res.json(await insights.accountMonthly(db, paramId(req), q.year));
  }));
  app.get("/api/inventory/by-location", requireRole(...READERS), asyncHandler(async (_req, res) => {
    res.json(await insights.inventoryByLocation(db));
  }));
  app.get("/api/inventory/on-the-way", requireRole(...READERS), asyncHandler(async (_req, res) => {
    res.json(await insights.onTheWay(db));
  }));
  app.get("/api/inventory/as-of", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ date: isoDate }).parse(req.query);
    res.json(await insights.stockAsOf(db, q.date));
  }));
  app.get("/api/variants/:id/monthly", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
    res.json(await insights.itemMonthly(db, paramId(req), q.year));
  }));
  app.get("/api/reports/analytics", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    res.json(await insights.analytics(db, q.from, q.to));
  }));
}
