import type { Express, Request } from "express";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, DRAFT_KINDS, journalLines, journals, parties, partners, saleReturns, users, type DraftKind } from "@shared/schema";
import { ambiguousTypedMeasure, cents, dec, Decimal, MoneyError, parseTypedNumber } from "@shared/money";
import { frNumber } from "@shared/french";
import { COST_FX_MEMO } from "../services/ledger";
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
      // Staff take francs at the day's rate.
      if (req.user!.role !== "owner") body.rate = null;
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
      .select({ line: journalLines, accountName: accounts.name, accountCode: accounts.code, accountType: accounts.type, isMoney: accounts.isMoney, systemKey: accounts.systemKey, partyName: parties.name })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .leftJoin(parties, eq(parties.id, journalLines.partyId))
      .where(eq(journalLines.journalId, j.journal.id))
      .orderBy(journalLines.id);
    const hidden = req.user!.role === "partner" ? await reports.otherPartnerAccountIds(db, req.user!.partnerId) : new Set<number>();
    const m = reports.maskPartnerJournal(
      j.journal,
      lines.map((l) => ({ ...l.line, accountName: l.accountName, accountCode: l.accountCode, accountType: l.accountType, isMoney: l.isMoney, systemKey: l.systemKey, partyName: l.partyName })),
      hidden,
    );
    // The printed amount is the daybook's: francs at the voucher's rate, the exchange difference apart.
    const doc = documentAmount(j.journal.type, hidden.size ? lines.filter((l) => !hidden.has(l.line.accountId)) : lines, m.lines);
    res.json({
      ...m.journal,
      createdByName: j.createdByName,
      total: m.lines.reduce((s, l) => s.plus(l.debit), dec(0)).toFixed(2),
      amount: doc.amount,
      fxDiff: "fxDiff" in doc ? doc.fxDiff ?? null : null,
      lines: m.lines.map((l) => (l.accountId === -1 ? { ...l, systemKey: null } : l)),
    });
  }));

  // ---------------------------------------------------------------- Daybook

  const SALE_JOURNALS = new Set<string>(["sale", "sale_void", "sale_return"]);
  /** Journals where a franc rounding or exchange difference is a side effect, not part of the document. */
  const FX_SIDE = new Set<string>(["sale", "sale_void", "sale_return", "transfer", "payment", "receipt", "customer_receipt", "supplier_payment", "expense", "container_expense", "payroll"]);
  type DayLine = {
    line: { debit: string; credit: string; currency: string; nativeAmount: string | null; rate: string | null; memo: string | null };
    isMoney: boolean;
    systemKey: string | null;
  };
  /**
   * The exchange difference postJournal adds when francs (or yuan) leave a balance at its average cost
   * rather than at the document's rate: shown on its own line, never inside the document's amount.
   */
  const isCostFx = (l: DayLine) => l.systemKey === "fx" && l.line.memo === COST_FX_MEMO;
  /**
   * A line at the document's own value: francs at the rate typed on the document, not at the box's
   * average cost (so 2 500 000 FC at 2 808 reads 890,31 $, as on the container).
   */
  const docValue = (l: DayLine, side: "debit" | "credit") => {
    const booked = dec(l.line[side]);
    if (booked.isZero() || l.line.currency !== "CDF" || !l.line.nativeAmount || !dec(l.line.rate ?? 0).gt(0)) return booked;
    return cents(dec(l.line.nativeAmount).abs().dividedBy(dec(l.line.rate!)));
  };
  /**
   * What a daybook row shows: the document's own amount (a sale's total, a transfer's amount sent,
   * a stock count's net change), with the money received and the change handed back for a sale as
   * secondary detail, the two boxes of a transfer, and any exchange difference apart (`fxDiff`, + a loss).
   */
  const documentAmount = (type: string, ls: DayLine[], shown: { debit: string; credit: string; isMoney?: boolean; accountName?: string | null }[]) => {
    const total = (rows: DayLine[], side: "debit" | "credit") => rows.reduce((s, l) => s.plus(docValue(l, side)), dec(0));
    const money = ls.filter((l) => l.isMoney);
    const costFx = ls.filter(isCostFx).reduce((s, l) => s.plus(l.line.debit).minus(l.line.credit), dec(0));
    // A difference only shows when the document's figures differ from the books, i.e. on the money side.
    const fxDiff: { fxDiff?: string; fxRounding?: string } = costFx.isZero() ? {} : { fxDiff: costFx.toFixed(2) };
    // The till's and the refunds' franc rounding ("Arrondi FC", + a loss), named as such beside the exchange difference.
    if (type === "sale" || type === "sale_return") {
      const rounding = ls.filter((l) => l.systemKey === "fx" && l.line.memo === "Arrondi FC").reduce((s, l) => s.plus(l.line.debit).minus(l.line.credit), dec(0));
      if (!rounding.isZero()) fxDiff.fxRounding = rounding.toFixed(2);
    }
    if (type === "sale") {
      return {
        amount: total(ls.filter((l) => l.systemKey === "sales"), "credit").toFixed(2),
        received: total(money, "debit").toFixed(2),
        changeGiven: total(money, "credit").toFixed(2),
        ...fxDiff,
      };
    }
    if (type === "sale_void" || type === "sale_return") return { amount: total(ls.filter((l) => l.systemKey === "sales"), "debit").toFixed(2), ...fxDiff };
    if (type === "transfer") {
      const names = (side: "debit" | "credit") => Array.from(new Set(shown.filter((l) => l.isMoney && dec(l[side]).gt(0)).map((l) => l.accountName ?? ""))).join(", ");
      return { amount: total(money, "credit").toFixed(2), transfer: { from: names("credit"), to: names("debit") }, ...fxDiff };
    }
    if (type === "revaluation") {
      // Month-end revaluation moves the dollar value of franc and yuan balances, not their francs: the
      // booked values are the document (at the voucher's rate they would read 0,00 $).
      return { amount: ls.reduce((s, l) => s.plus(l.line.debit), dec(0)).toFixed(2) };
    }
    if (type === "stock_adjustment") {
      // A count both finds and loses stock: the net change of the stock's value, with each side apart.
      const inv = ls.filter((l) => l.systemKey === "inventory");
      const added = total(inv, "debit");
      const removed = total(inv, "credit");
      return { amount: added.minus(removed).toFixed(2), stockAdded: added.toFixed(2), stockRemoved: removed.toFixed(2) };
    }
    // Otherwise every debit, without the cost-of-goods pair of a sale or an exchange difference beside the document.
    const kept = ls.filter((l) => !(SALE_JOURNALS.has(type) && (l.systemKey === "cogs" || l.systemKey === "inventory")) && !(FX_SIDE.has(type) && l.systemKey === "fx") && !isCostFx(l));
    // Money paid out at the document's rate: when it differs from the other side at book cost, the money is the document.
    const paidOut = total(money, "credit");
    const paidIn = total(money, "debit");
    const amount = !costFx.isZero() && (paidOut.gt(0) !== paidIn.gt(0)) ? Decimal.max(paidOut, paidIn) : total(kept, "debit");
    return { amount: amount.toFixed(2), ...fxDiff };
  };
  /** The nearest day before (or after) the given one that has postings, for the daybook's jump buttons. */
  app.get("/api/daybook/active-day", requireRole(...READERS), asyncHandler(async (req, res) => {
    const q = z.object({ date: isoDate, dir: z.enum(["before", "after"]).default("before") }).parse(req.query);
    const [row] = await db
      .select({ day: q.dir === "before" ? sql<string | null>`max(${journals.date})` : sql<string | null>`min(${journals.date})` })
      .from(journals)
      .where(q.dir === "before" ? sql`${journals.date} < ${q.date}` : sql`${journals.date} > ${q.date}`);
    res.json({ date: row?.day ?? null });
  }));
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
    // Sales at 0 $ or below cost, so the daybook can flag them like the sales list does.
    const saleIds = js.filter((j) => j.journal.sourceType === "sale" && j.journal.sourceId).map((j) => j.journal.sourceId!);
    const flagged = saleIds.length
      ? await db.execute<{ id: number; zero_price: boolean; below_cost: boolean }>(sql`
          select s.id,
            exists (select 1 from sale_lines l where l.sale_id = s.id and l.unit_price <= 0) as zero_price,
            (s.total < s.cogs) as below_cost
          from sales s where s.id in (${sql.join(saleIds.map((x) => sql`${x}`), sql`, `)})`)
      : { rows: [] };
    const flags = new Map(flagged.rows.map((r) => [Number(r.id), r]));
    let moneyIn = dec(0);
    let moneyOut = dec(0);
    const hidden = req.user!.role === "partner" ? await reports.otherPartnerAccountIds(db, req.user!.partnerId) : new Set<number>();
    // A search must not find another partner's movements by words a partner cannot see.
    const searchable = q.q?.trim() && hidden.size
      ? js.filter(({ journal }) => !(byJournal.get(journal.id) ?? []).some((l) => hidden.has(l.line.accountId)))
      : js;
    const rows = searchable.map(({ journal: raw, createdByName }) => {
      const ls = byJournal.get(raw.id) ?? [];
      const masked = reports.maskPartnerJournal(
        raw,
        ls.map((l) => ({ ...l.line, accountName: l.accountName, accountCode: l.accountCode, isMoney: l.isMoney, partyName: l.partyName })),
        hidden,
      );
      const journal = masked.journal;
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
        saleFlags:
          journal.sourceType === "sale" && journal.sourceId && flags.has(journal.sourceId)
            ? { zeroPrice: !!flags.get(journal.sourceId)!.zero_price, belowCost: !!flags.get(journal.sourceId)!.below_cost }
            : undefined,
        ...documentAmount(journal.type, hidden.size ? ls.filter((l) => !hidden.has(l.line.accountId)) : ls, masked.lines),
        lines: masked.lines,
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

  app.get("/api/voucher-drafts", requireRole(...READERS), asyncHandler(async (req, res) => {
    let rows = await db.transaction((tx) => vouchers.listDrafts(tx));
    if (req.user!.role === "partner") {
      // A draft that moves another partner's money is theirs and the owner's business.
      const hidden = await reports.otherPartnerAccountIds(db, req.user!.partnerId);
      const others = (await db.select({ id: partners.id }).from(partners)).map((p) => p.id).filter((id) => id !== req.user!.partnerId);
      rows = rows.filter((r) => {
        const p = r.payload as { partnerId?: number; lines?: { accountId?: number | null }[] };
        if (p.partnerId && others.includes(p.partnerId)) return false;
        return !(p.lines ?? []).some((l) => l.accountId && hidden.has(l.accountId));
      });
    }
    const names = await db.select({ id: users.id, fullName: users.fullName }).from(users);
    res.json(rows.map((r) => ({ ...r, createdByName: names.find((n) => n.id === r.createdBy)?.fullName ?? null })));
  }));
  app.post("/api/voucher-drafts", requireRole(...STAFF), asyncHandler(async (req, res) => {
    // Drafts may be incomplete, so only the shape is checked here; finalizing runs the full checks.
    const body = z
      .object({ id: optionalId, kind: z.enum(DRAFT_KINDS), date: isoDate, memo: z.string().max(300).optional().nullable(), payload: z.record(z.string(), z.unknown()) })
      .parse(req.body);
    const rights = { owner: req.user!.role === "owner" };
    const row = await db.transaction((tx) => vouchers.saveDraft(tx, body, uid(req), rights));
    await audit(req, body.id ? "update" : "create", "voucher_draft", row.id, { kind: body.kind, date: body.date, payload: body.payload });
    res.status(body.id ? 200 : 201).json(row);
  }));
  app.delete("/api/voucher-drafts/:id", requireRole(...STAFF), asyncHandler(async (req, res) => {
    await db.transaction((tx) => vouchers.deleteDraft(tx, paramId(req), uid(req), { owner: req.user!.role === "owner" }));
    await audit(req, "delete", "voucher_draft", paramId(req));
    res.json({ ok: true });
  }));
  app.post("/api/voucher-drafts/:id/finalize", requireRole(...STAFF), asyncHandler(async (req, res) => {
    const result = await db.transaction((tx) =>
      vouchers.finalizeDraft(tx, paramId(req), uid(req), { owner: req.user!.role === "owner" }, (kind, payload) => {
        if (kind === "journal" && req.user!.role !== "owner") {
          throw forbidden("Only the owner can post a journal entry", "Seul le propriétaire peut passer une écriture");
        }
        const parsed = payloadSchemas[kind].parse(payload);
        // Staff take francs at the day's rate, as on the direct voucher routes.
        if (req.user!.role !== "owner" && parsed && typeof parsed === "object" && "rate" in parsed) (parsed as { rate?: string | null }).rate = null;
        return parsed;
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
  // "12,50" from a French spreadsheet is twelve and a half, not 1250.
  const num = z.union([z.string().max(40), z.number(), z.null()]).optional().transform((v) => parseTypedNumber(v));
  // Quantities, weights and volumes come from the browser as plain numbers ("12.375" kg): read the way a
  // form field reads a measure, so three decimals stay decimals. Pieces cannot come out split (each import
  // checks whole units), and "1.000" (1 000 or 1?) is refused rather than guessed.
  const measure = z.union([z.string().max(40), z.number(), z.null()]).optional().transform((v) => {
    const unsure = ambiguousTypedMeasure(v);
    if (unsure) {
      throw new MoneyError(
        `"${String(v).trim()}" could be ${unsure[0]} or ${unsure[1]}: write it without the dot`,
        `«\u00a0${String(v).trim()}\u00a0» : ${frNumber(unsure[0])} ou ${unsure[1]} ? Écrivez-le sans le point.`,
      );
    }
    return parseTypedNumber(v, { measured: true });
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
  const stockRow = itemRow.extend({ qty: measure, unitCost: num });
  const containerRow = itemRow.extend({ quantity: measure.transform((v) => v ?? ""), unitPrice: num.transform((v) => v ?? ""), weightKg: measure, volumeCbm: measure });

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
