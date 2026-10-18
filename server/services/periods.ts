import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { accounts, exchangeRates, journalLines, journals, partners, periods } from "@shared/schema";
import { splitProfit, type PartnerSplitResult } from "@shared/partnerSplit";
import { dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict } from "../errors";
import { deMonth, frDate, frNumber, monthText } from "@shared/french";
import { cents } from "@shared/money";
import { cnyRateFor, lockPeriodsExclusive, postJournal, rateFor, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId, type PostLine } from "./ledger";
import { todayIso } from "../http";

export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("Month must be YYYY-MM", "Le mois doit être au format AAAA-MM");
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export interface PnlAccountRow {
  accountId: number;
  code: string;
  name: string;
  type: "income" | "cost_of_sales" | "expense";
  /** Positive = normal side (credit for income, debit for costs). */
  amount: string;
}

/** Profit and loss by account for a date range, leaving out month-close journals. */
export async function pnlByAccount(tx: Tx, from: string, to: string): Promise<PnlAccountRow[]> {
  const rows = await tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        gte(journals.date, from),
        lte(journals.date, to),
        ne(journals.type, "period_close"),
        sql`${accounts.type} in ('income', 'cost_of_sales', 'expense')`,
      ),
    )
    .groupBy(accounts.id)
    .orderBy(asc(accounts.code));
  return rows
    .map((r) => {
      const net = dec(r.debit).minus(r.credit);
      const amount = r.type === "income" ? net.negated() : net;
      return { accountId: r.accountId, code: r.code, name: r.name, type: r.type as PnlAccountRow["type"], amount: amount.toFixed(2) };
    })
    .filter((r) => !dec(r.amount).isZero());
}

export function summarizePnl(rows: PnlAccountRow[]) {
  const income = sum(rows.filter((r) => r.type === "income").map((r) => r.amount));
  const costOfSales = sum(rows.filter((r) => r.type === "cost_of_sales").map((r) => r.amount));
  const operatingExpenses = sum(rows.filter((r) => r.type === "expense").map((r) => r.amount));
  const grossProfit = income.minus(costOfSales);
  return {
    income: income.toFixed(2),
    costOfSales: costOfSales.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    operatingExpenses: operatingExpenses.toFixed(2),
    netProfit: grossProfit.minus(operatingExpenses).toFixed(2),
  };
}

/**
 * Month-end revaluation: every franc balance (cash, bank, a contact's francs) is restated at the
 * rate of the month's last day. Returns the lines and the net gain (negative for a loss).
 */
export async function revaluationLines(
  tx: Tx,
  month: string,
): Promise<{ lines: PostLine[]; gain: Decimal; rate: Decimal; cnyRate: Decimal | null }> {
  const { to } = monthRange(month);
  const { rate } = await rateFor(tx, to);
  // Yuan are restated only once a yuan rate has been entered; until then they stay at cost.
  const [cnyRow] = await tx
    .select({ rate: exchangeRates.cnyPerUsd })
    .from(exchangeRates)
    .where(and(lte(exchangeRates.date, to), isNotNull(exchangeRates.cnyPerUsd)))
    .orderBy(desc(exchangeRates.date))
    .limit(1);
  const cnyRate = cnyRow?.rate ? dec(cnyRow.rate) : null;
  const lines: PostLine[] = [];
  let gain = new Decimal(0);
  for (const [currency, r] of [["CDF", rate], ["CNY", cnyRate]] as const) {
    if (!r) continue;
    const rows = await tx
      .select({
        accountId: journalLines.accountId,
        partyId: journalLines.partyId,
        native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`,
        usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.currency, currency), lte(journals.date, to)))
      .groupBy(journalLines.accountId, journalLines.partyId);
    for (const row of rows) {
      const diff = cents(dec(row.native).dividedBy(r)).minus(row.usd);
      if (diff.isZero()) continue;
      gain = gain.plus(diff);
      lines.push({
        accountId: row.accountId,
        partyId: row.partyId,
        debit: diff.isPositive() ? diff : 0,
        credit: diff.isNegative() ? diff.abs() : 0,
        currency,
        nativeAmount: "0",
        rate: r,
        memo: `Réévaluation au taux de fin de mois (1\u00a0$ = ${frNumber(r.toString())}\u00a0${currency === "CDF" ? "FC" : "¥"})`,
      });
    }
  }
  if (lines.length) {
    lines.push({
      accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.fx),
      debit: gain.isNegative() ? gain.abs() : 0,
      credit: gain.isPositive() ? gain : 0,
      memo: "Écart de change de réévaluation",
    });
  }
  return { lines, gain, rate, cnyRate };
}

/** Memo of the lines that take a revaluation off a balance settled after the month's end (see settledRevaluations). */
export const REVALUATION_SETTLED_MEMO = "Réévaluation soldée\u00a0: devises réglées après la fin du mois";

/** Source of the journals that take a revaluation off the balances settled after the month's end (see settledRevaluations). */
const SETTLED_SOURCE = "period_settled";

/**
 * A balance in francs or yuan held at the month's end but settled after it, before the month was
 * closed, was taken out at what it cost then: the revaluation, dated the month's end, leaves its dollars
 * on a balance with no francs or yuan. They go to exchange differences on the day it was first emptied,
 * as the next revaluation would have done, so from that day the balance is what those postings saw. On
 * contacts and other accounts that are not money only (a drawer keeps its revaluation, see selfCheck);
 * the balances that still hold their francs or yuan keep it. Posted with the close, undone with it.
 */
async function settledRevaluations(tx: Tx, month: string, revaluation: PostLine[], periodId: number, userId: number) {
  const { to } = monthRange(month);
  const keyOf = (k: { accountId: number; partyId?: number | null; currency?: string | null }) => `${k.accountId}|${k.partyId ?? ""}|${k.currency}`;
  const money = new Set((await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.isMoney, true))).map((a) => a.id));
  const revalued = revaluation.filter((l) => l.currency && !money.has(l.accountId));
  if (!revalued.length) return;
  const balance = { native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` };
  const held = await tx
    .select({ ...balance, accountId: journalLines.accountId, partyId: journalLines.partyId, currency: journalLines.currency })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(inArray(journalLines.currency, ["CDF", "CNY"]), lte(journals.date, to)))
    .groupBy(journalLines.accountId, journalLines.partyId, journalLines.currency);
  const after = await tx
    .select({ ...balance, accountId: journalLines.accountId, partyId: journalLines.partyId, currency: journalLines.currency, date: journals.date })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(inArray(journalLines.currency, ["CDF", "CNY"]), gt(journals.date, to)))
    .groupBy(journalLines.accountId, journalLines.partyId, journalLines.currency, journals.date)
    .orderBy(journals.date);
  const byDay = new Map<string, PostLine[]>();
  for (const l of revalued) {
    const start = held.find((h) => keyOf(h) === keyOf(l));
    if (!start || dec(start.native).isZero()) continue;
    const bal = { native: dec(start.native), usd: dec(start.usd) };
    const emptied = after.filter((a) => keyOf(a) === keyOf(l)).find((a) => {
      bal.native = bal.native.plus(a.native);
      bal.usd = bal.usd.plus(a.usd);
      return bal.native.isZero();
    });
    if (!emptied) continue;
    // Only the revaluation's dollars still on it that day: a reversal since may have taken them already
    // (see revaluedDollarLines), when the month is closed again after being reopened.
    const diff = dec(l.debit ?? 0).minus(dec(l.credit ?? 0));
    if (bal.usd.isZero() || bal.usd.isNegative() !== diff.isNegative()) continue;
    const take = bal.usd.abs().lt(diff.abs()) ? bal.usd : diff;
    byDay.set(emptied.date, [...(byDay.get(emptied.date) ?? []), { ...l, debit: take.isNegative() ? take.abs() : 0, credit: take.isPositive() ? take : 0 }]);
  }
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  for (const [date, lines] of byDay) {
    const cdf = (await rateFor(tx, date)).rate;
    const cny = await cnyRateFor(tx, date);
    const gain = sum(lines.map((l) => dec(l.debit ?? 0).minus(dec(l.credit ?? 0))));
    await postJournal(tx, {
      date,
      type: "revaluation",
      memo: `Réévaluation au ${frDate(to)} soldée\u00a0: ces devises ont été réglées depuis`,
      sourceType: SETTLED_SOURCE,
      sourceId: periodId,
      userId,
      exactValues: true,
      lines: [
        ...lines.map((l) => ({ ...l, rate: l.currency === "CNY" ? (cny ?? l.rate) : cdf, memo: REVALUATION_SETTLED_MEMO })),
        { accountId: fx, debit: gain.isNegative() ? gain.abs() : 0, credit: gain.isPositive() ? gain : 0, memo: REVALUATION_SETTLED_MEMO },
      ],
    });
  }
}

export async function activePartners(tx: Tx) {
  return tx.select().from(partners).where(eq(partners.active, true)).orderBy(asc(partners.id));
}

export interface StoredShare {
  id: number;
  name: string;
  sharePct: string;
  bearsOperatingExpenses: boolean;
}

/**
 * The shares a month is split by: the ones stored when it was first closed (so a month reopened to
 * fix a typo is split the same way again), else the partners' current shares.
 */
async function sharesFor(tx: Tx, stored: unknown) {
  if (Array.isArray(stored) && stored.length) {
    const shares = stored as StoredShare[];
    const rows = await tx.select().from(partners).where(inArray(partners.id, shares.map((p) => p.id)));
    return shares.map((p) => ({ ...rows.find((r) => r.id === p.id)!, sharePct: p.sharePct, bearsOperatingExpenses: p.bearsOperatingExpenses }));
  }
  return activePartners(tx);
}

export interface PeriodPreview {
  month: string;
  status: "open" | "closed";
  from: string;
  to: string;
  accounts: PnlAccountRow[];
  totals: ReturnType<typeof summarizePnl>;
  split: PartnerSplitResult;
}

export async function previewPeriod(tx: Tx, month: string): Promise<PeriodPreview> {
  const { from, to } = monthRange(month);
  const [period] = await tx.select().from(periods).where(eq(periods.month, month));
  if (period?.status === "closed" && period.result) {
    const stored = period.result as Omit<PeriodPreview, "status">;
    return { ...stored, status: "closed" };
  }
  const rows = await pnlByAccount(tx, from, to);
  // The revaluation is posted when the month closes; show it already, so the split shown is the split booked.
  const pending = await revaluationLines(tx, month);
  if (!pending.gain.isZero()) {
    const fxId = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
    const existing = rows.find((r) => r.accountId === fxId);
    if (existing) existing.amount = dec(existing.amount).plus(pending.gain).toFixed(2);
    else {
      const [fx] = await tx.select().from(accounts).where(eq(accounts.id, fxId));
      rows.push({ accountId: fxId, code: fx.code, name: fx.name, type: "income", amount: pending.gain.toFixed(2) });
      rows.sort((a, b) => a.code.localeCompare(b.code));
    }
  }
  const totals = summarizePnl(rows.filter((r) => !dec(r.amount).isZero()));
  const ps = await sharesFor(tx, period?.shares);
  const split = splitProfit(
    totals.grossProfit,
    totals.operatingExpenses,
    ps.map((p) => ({ id: p.id, name: p.name, sharePct: p.sharePct, bearsOperatingExpenses: p.bearsOperatingExpenses })),
  );
  return { month, status: "open", from, to, accounts: rows, totals, split };
}

/** First month with any posting, so months are closed in order. */
async function firstActivityMonth(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ date: journals.date }).from(journals).orderBy(asc(journals.date)).limit(1);
  return row ? row.date.slice(0, 7) : null;
}

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Close a month: zero its profit and loss accounts into the partners' current accounts by the
 * 75/25 rule (operating expenses on the bearing partner), and lock the month.
 */
export async function closePeriod(tx: Tx, month: string, userId: number) {
  const { to } = monthRange(month);
  const today = todayIso();
  if (to >= today) throw badRequest("A month can be closed only after it has ended", "Un mois ne peut être clôturé qu'une fois terminé");

  // Wait for the postings under way, and hold back new ones until the close is committed.
  await lockPeriodsExclusive(tx);
  await tx.insert(periods).values({ month }).onConflictDoNothing();
  const [period] = await tx.select().from(periods).where(eq(periods.month, month)).for("update");
  if (period.status === "closed") throw conflict(`${month} is already closed`, `Le mois ${deMonth(month)} est déjà clôturé`);

  const first = await firstActivityMonth(tx);
  if (first && first < month) {
    const prev = prevMonth(month);
    if (prev >= first) {
      const [p] = await tx.select().from(periods).where(eq(periods.month, prev));
      if (p?.status !== "closed") throw conflict(`Close ${prev} first. Months are closed in order.`, `Clôturez d'abord ${monthText(prev)}. Les mois se clôturent dans l'ordre.`);
    }
  }

  const reval = await revaluationLines(tx, month);
  const revaluationJournalId = reval.lines.length
    ? await postJournal(tx, {
        date: to,
        type: "revaluation",
        memo: `Réévaluation des devises au ${frDate(to)} (1\u00a0$ = ${frNumber(reval.rate.toString())}\u00a0FC${reval.cnyRate ? `\u00a0; ${frNumber(reval.cnyRate.toString())}\u00a0¥` : ""})`,
        sourceType: "period",
        sourceId: period.id,
        userId,
        exactValues: true,
        lines: reval.lines,
      })
    : null;
  if (revaluationJournalId) await settledRevaluations(tx, month, reval.lines, period.id, userId);

  const preview = await previewPeriod(tx, month);
  const ps = await sharesFor(tx, period.shares);
  const lines = preview.accounts.map((r) => {
    const amount = dec(r.amount);
    // Income has a credit balance: debit it to zero. Costs and expenses: credit them.
    const debitSide = r.type === "income" ? amount.isPositive() : amount.isNegative();
    return { accountId: r.accountId, debit: debitSide ? amount.abs() : new Decimal(0), credit: debitSide ? new Decimal(0) : amount.abs() };
  });
  for (const s of preview.split.partners) {
    const partner = ps.find((p) => p.id === s.partnerId)!;
    const net = dec(s.net);
    lines.push({
      accountId: partner.currentAccountId,
      debit: net.isNegative() ? net.abs() : new Decimal(0),
      credit: net.isPositive() ? net : new Decimal(0),
    });
  }
  const journalId = await postJournal(tx, {
    date: preview.to,
    type: "period_close",
    memo: `Clôture ${deMonth(month)}\u00a0: partage du bénéfice entre associés`,
    sourceType: "period",
    sourceId: period.id,
    userId,
    skipPeriodCheck: true,
    lines,
  });
  const { status: _status, ...stored } = preview;
  await tx
    .update(periods)
    .set({
      status: "closed",
      grossProfit: preview.totals.grossProfit,
      operatingExpenses: preview.totals.operatingExpenses,
      result: stored,
      closingJournalId: journalId,
      revaluationJournalId,
      shares: ps.map((p) => ({ id: p.id, name: p.name, sharePct: p.sharePct, bearsOperatingExpenses: p.bearsOperatingExpenses })),
      closedAt: new Date(),
      closedBy: userId,
    })
    .where(eq(periods.id, period.id));
  return { ...preview, status: "closed" as const };
}

/** Reopen the latest closed month so it can be corrected. */
export async function reopenPeriod(tx: Tx, month: string, userId: number) {
  await lockPeriodsExclusive(tx);
  const [period] = await tx.select().from(periods).where(eq(periods.month, month)).for("update");
  if (!period || period.status !== "closed") throw conflict(`${month} is not closed`, `Le mois ${deMonth(month)} n'est pas clôturé`);
  const [later] = await tx
    .select()
    .from(periods)
    .where(and(eq(periods.status, "closed"), sql`${periods.month} > ${month}`))
    .orderBy(desc(periods.month))
    .limit(1);
  if (later) throw conflict(`Reopen ${later.month} first. Only the latest closed month can be reopened.`, `Rouvrez d'abord ${later.month}. Seul le dernier mois clôturé peut être rouvert.`);
  if (period.closingJournalId) {
    await reverseJournal(tx, period.closingJournalId, {
      date: monthRange(month).to,
      type: "period_close",
      memo: `Réouverture ${deMonth(month)}`,
      userId,
      skipPeriodCheck: true,
    });
  }
  const settled = await tx
    .select({ id: journals.id, date: journals.date })
    .from(journals)
    .where(and(eq(journals.sourceType, SETTLED_SOURCE), eq(journals.sourceId, period.id), isNull(journals.reversedByJournalId), isNull(journals.reversesJournalId)));
  for (const j of settled) {
    await reverseJournal(tx, j.id, { date: j.date, type: "revaluation", memo: `Réouverture ${deMonth(month)}\u00a0: annulation de la réévaluation soldée`, userId, skipPeriodCheck: true });
  }
  if (period.revaluationJournalId) {
    await reverseJournal(tx, period.revaluationJournalId, {
      date: monthRange(month).to,
      type: "revaluation",
      memo: `Réouverture ${deMonth(month)}\u00a0: annulation de la réévaluation`,
      userId,
      skipPeriodCheck: true,
    });
  }
  await tx
    .update(periods)
    .set({ status: "open", closingJournalId: null, revaluationJournalId: null, result: null, grossProfit: null, operatingExpenses: null, closedAt: null, closedBy: null })
    .where(eq(periods.id, period.id));
}
