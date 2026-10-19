import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { accounts, exchangeRates, journalLines, journals, partners, periods } from "@shared/schema";
import { splitProfit, type PartnerSplitResult } from "@shared/partnerSplit";
import { dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict } from "../errors";
import { deMonth, frDate, frNumber, monthText } from "@shared/french";
import { cents } from "@shared/money";
import { cnyRateFor, lockPeriodsExclusive, postJournal, rateFor, REVALUATION_SETTLED_MEMO, REVALUATION_SOURCES, REVALUED_MEMO, reverseJournal, setRestater, SYSTEM_ACCOUNTS, systemAccountId, yuanMarkedOwed, type PostLine } from "./ledger";
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

/** Memo of the lines that take a revaluation off a balance settled after the month's end (kept in ledger.ts, as a books' own label). */
export { REVALUATION_SETTLED_MEMO };

/** Source of the journals by which closing a month takes its revaluation off the balances settled since its end (see restateSettled). */
const SETTLED_SOURCE = "period_settled";

/** Source of the journals by which reopening a month takes back what was settled since of its revaluation (see restateSettled). */
const REOPENED_SOURCE = "period_reopened";

type ForeignKey = { accountId: number; partyId: number | null; currency: "CDF" | "CNY" };
const foreignKeyOf = (k: { accountId: number; partyId?: number | null; currency?: string | null }) => `${k.accountId}|${k.partyId ?? ""}|${k.currency}`;

/** `usd` kept between none and `cap`, on cap's side. */
const clampTo = (usd: Decimal, cap: Decimal) => (cap.isNegative() ? Decimal.min(Decimal.max(usd, cap), 0) : Decimal.max(Decimal.min(usd, cap), 0));

/**
 * Post `posts` (the dollars to move on each balance, by day) against exchange differences, one journal a day.
 * Closing a month labels its lines as a settled revaluation, reopening it as what a reversal cleared.
 */
async function postAgainstFx(
  tx: Tx,
  posts: { key: ForeignKey; date: string; usd: Decimal }[],
  journal: { memo: string; sourceType: string; sourceId: number; userId: number | null; settled: boolean },
) {
  const label = journal.settled ? { memo: REVALUATION_SETTLED_MEMO, kind: null } : { memo: REVALUED_MEMO, kind: "revalued" as const };
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  for (const date of Array.from(new Set(posts.map((p) => p.date))).sort()) {
    const day = posts.filter((p) => p.date === date);
    const cdf = (await rateFor(tx, date)).rate;
    const cny = await cnyRateFor(tx, date);
    const gain = sum(day.map((p) => p.usd));
    await postJournal(tx, {
      date,
      type: "revaluation",
      memo: journal.memo,
      sourceType: journal.sourceType,
      sourceId: journal.sourceId,
      userId: journal.userId,
      exactValues: true,
      lines: [
        ...day.map((p): PostLine => ({
          accountId: p.key.accountId,
          partyId: p.key.partyId,
          currency: p.key.currency,
          nativeAmount: "0",
          rate: p.key.currency === "CNY" ? (cny ?? cdf) : cdf,
          debit: p.usd.isPositive() ? p.usd : 0,
          credit: p.usd.isNegative() ? p.usd.abs() : 0,
          ...label,
        })),
        { accountId: fx, debit: gain.isNegative() ? gain.abs() : 0, credit: gain.isPositive() ? gain : 0, ...label },
      ],
    });
  }
}

/**
 * What a month's revaluation leaves, day by day, on each balance in francs or yuan of a contact (or another
 * account that is not money) it restated, once the month is closed (`state` "closed") or reopened ("open"):
 * the books' journals for it (its revaluation, undone when it is reopened, and what closing or reopening it
 * moved since: see REVALUATION_SOURCES) are brought to that, by one journal a day against exchange
 * differences. Worked out afresh each time from everything else on the balance, so reopening a month and
 * closing it again with nothing in between books exactly what was there, however often it is done, and in
 * whatever order postings since were made or dated.
 * Closed, the balance holds the revaluation from the month's end; reopened, none of it. From the month's
 * end on, in date order and each day in the order they were posted, two kinds of posting settle it, closed
 * or reopened alike (what the day ends with is posted on it):
 * - one after which the balance holds no francs or yuan: it holds no dollars either. Whatever else is on
 *   it then (a payment since that took the revaluation with it at what the balance cost, a reversal that
 *   cleared it, a settlement before the close that did not) leaves to the revaluation only the dollars
 *   needed for that, never beyond what it restated nor the other way (more is for a person to correct, see
 *   selfCheck). As settled once the month is closed: a balance settled before the close has the
 *   revaluation taken off on that day, one settled at the revalued cost keeps it there;
 * - a container's reversal that takes a supplier's yuan bill away: of the revaluation still on their yuan
 *   owed (or paid since it was posted), the share of those it leaves stays (see yuanMarkedOwed), the rest
 *   left with the bill. Otherwise, a posting that turns what is owed into a claim (or a claim into yuan or
 *   francs owed) leaves none of it. Posted with the month closed, the posting moved it to exchange differences, so reopened it is taken
 *   back there; posted with it reopened, closing it again moves it there.
 * Drawers keep their revaluation (see selfCheck): only the revaluation and its undoing are on them.
 */
async function restateSettled(tx: Tx, month: string, periodId: number, revaluationJournalId: number | null, state: "closed" | "open", userId: number | null, only?: { keys: Set<string>; from: string }) {
  const { to } = monthRange(month);
  const money = new Set((await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.isMoney, true))).map((a) => a.id));
  const ofMonth = (j: { type: string; sourceType: string | null; sourceId: number | null }) =>
    j.type === "revaluation" && j.sourceId === periodId && !!j.sourceType && REVALUATION_SOURCES.includes(j.sourceType);
  // What the revaluation restated on each balance.
  const restated = new Map<string, Decimal>();
  const keys = new Map<string, ForeignKey>();
  const add = (l: { accountId: number; partyId: number | null; currency: string }) => {
    if ((l.currency !== "CDF" && l.currency !== "CNY") || money.has(l.accountId)) return null;
    const k = foreignKeyOf(l);
    if (!keys.has(k)) keys.set(k, { accountId: l.accountId, partyId: l.partyId, currency: l.currency });
    return k;
  };
  if (revaluationJournalId) {
    for (const l of await tx.select().from(journalLines).where(eq(journalLines.journalId, revaluationJournalId))) {
      const k = add(l);
      if (k) restated.set(k, (restated.get(k) ?? new Decimal(0)).plus(dec(l.debit)).minus(dec(l.credit)));
    }
  }
  // And every balance the month's journals moved since its end, whatever the revaluation restates now.
  const moved = await tx
    .selectDistinct({ accountId: journalLines.accountId, partyId: journalLines.partyId, currency: journalLines.currency })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journals.type, "revaluation"), eq(journals.sourceId, periodId), inArray(journals.sourceType, REVALUATION_SOURCES), inArray(journalLines.currency, ["CDF", "CNY"]), gt(journals.date, to)));
  for (const m of moved) add(m);
  if (only) for (const k of Array.from(keys.keys())) if (!only.keys.has(k)) keys.delete(k);
  if (!keys.size) return;
  // When the month was closed: from each of its revaluations until the reversal that undid it.
  const closes = await tx
    .select({ id: journals.id, reversedBy: journals.reversedByJournalId })
    .from(journals)
    .where(and(eq(journals.type, "revaluation"), eq(journals.sourceType, "period"), eq(journals.sourceId, periodId), isNull(journals.reversesJournalId)));
  const postedClosed = (id: number) => closes.some((c) => c.id < id && (!c.reversedBy || c.reversedBy > id));
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const posts: { key: ForeignKey; date: string; usd: Decimal }[] = [];
  for (const [k, key] of keys) {
    const cap = restated.get(k) ?? new Decimal(0);
    const rows = await tx
      .select({ journalId: journalLines.journalId, date: journals.date, type: journals.type, sourceType: journals.sourceType, sourceId: journals.sourceId, native: journalLines.nativeAmount, usd: sql<string>`${journalLines.debit} - ${journalLines.credit}` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, key.accountId), key.partyId ? eq(journalLines.partyId, key.partyId) : isNull(journalLines.partyId), eq(journalLines.currency, key.currency)))
      .orderBy(journals.date, journals.id, journalLines.id);
    const marks = key.currency === "CNY" && key.accountId === payables && key.partyId ? await yuanMarkedOwed(tx, payables, key.partyId, to) : null;
    let native = new Decimal(0);
    let others = new Decimal(0); // the dollars everything but the month's own journals put on it
    let current = new Decimal(0); // what the month's own journals put on it since its end
    let posted = new Decimal(0);
    // The revaluation's dollars on it, closed and reopened.
    let closed = cap;
    let open = new Decimal(0);
    for (let i = 0; i < rows.length; ) {
      const date = rows[i].date;
      let end = i;
      while (end < rows.length && rows[end].date === date) end++;
      // Journal by journal, in the order they were posted: a payment that empties the balance settles it
      // even when a reversal the same day then leaves a claim. What other months' revaluations moved that
      // day first, as they restate the day as a whole.
      const day = [...rows.slice(i, end).filter((r) => r.type === "revaluation" && !ofMonth(r)), ...rows.slice(i, end).filter((r) => r.type !== "revaluation" || ofMonth(r))];
      i = end;
      for (let j = 0; j < day.length; ) {
        const id = day[j].journalId;
        const was = native;
        for (; j < day.length && day[j].journalId === id; j++) {
          const r = day[j];
          native = native.plus(dec(r.native ?? 0));
          if (ofMonth(r)) {
            if (date > to) current = current.plus(dec(r.usd));
          } else others = others.plus(dec(r.usd));
        }
        if (date <= to) continue;
        const m = ofMonth(day[j - 1]) ? undefined : marks?.get(id);
        // What was owed turned into a claim, or the other way: none of what the revaluation restated is
        // left, so none of it stays.
        const shared = !!m?.removal && m.before.gt(0) && !m.after.equals(m.before);
        const crossed = !shared && !ofMonth(day[j - 1]) && !was.isZero() && !native.isZero() && was.isNegative() !== native.isNegative();
        if (shared || crossed) {
          const kept = shared ? cents(closed.minus(open).times(m!.after).dividedBy(m!.before)) : new Decimal(0);
          if (postedClosed(id)) open = closed.minus(kept);
          else closed = open.plus(kept);
        }
        // Only a posting empties a balance: a revaluation moves no yuan or francs.
        if (native.isZero() && day[j - 1].type !== "revaluation") closed = open = clampTo(others.negated(), cap);
      }
      if (date <= to) continue;
      // Closed, the revaluation itself puts `cap` on it at the month's end.
      const want = (state === "closed" ? closed.minus(cap) : open).minus(current).minus(posted);
      // After a posting (see restateAfter), only what it can change: the days from its date on.
      if (only && date < only.from) {
        posted = posted.plus(want);
        continue;
      }
      if (!want.isZero()) {
        posts.push({ key, date, usd: want });
        posted = posted.plus(want);
      }
    }
  }
  if (!posts.length) return;
  await postAgainstFx(tx, posts, {
    memo:
      state === "closed"
        ? `Réévaluation au ${frDate(to)} soldée : ces devises ont été réglées depuis`
        : `Réouverture ${deMonth(month)} : réévaluation du ${frDate(to)} reprise sur les devises soldées depuis`,
    sourceType: state === "closed" ? SETTLED_SOURCE : REOPENED_SOURCE,
    sourceId: periodId,
    userId,
    settled: state === "closed",
  });
}


/**
 * Once a transaction posted on francs or yuan from `from` on, with other postings on them dated that day or
 * after: what each month's revaluation (closed, or reopened) leaves on them, as closing or reopening it would
 * now (see restateSettled), so a balance a back-dated posting empties on a later day (or no longer empties on
 * its own day) is restated as a close would, and closing the month again books nothing new. Months in order,
 * as they close.
 */
async function restateAfter(tx: Tx, keys: ForeignKey[], from: string, posted: number[], userId: number | null) {
  const later: string[] = [];
  for (const key of keys) {
    const [row] = await tx
      .select({ id: journalLines.id })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, key.accountId), key.partyId ? eq(journalLines.partyId, key.partyId) : isNull(journalLines.partyId), eq(journalLines.currency, key.currency), gte(journals.date, from), notInArray(journals.id, posted)))
      .limit(1);
    if (row) later.push(foreignKeyOf(key));
  }
  if (!later.length) return;
  const only = { keys: new Set(later), from };
  const revaluations = await tx
    .select({ id: journals.id, periodId: journals.sourceId })
    .from(journals)
    .where(and(eq(journals.type, "revaluation"), eq(journals.sourceType, "period"), isNull(journals.reversesJournalId)));
  for (const period of await tx.select().from(periods).orderBy(asc(periods.month))) {
    const last = revaluations.filter((r) => r.periodId === period.id).reduce<number | null>((m, r) => (m === null || r.id > m ? r.id : m), null);
    if (period.status === "closed") {
      if (period.revaluationJournalId) await restateSettled(tx, period.month, period.id, period.revaluationJournalId, "closed", userId, only);
    } else if (last) await restateSettled(tx, period.month, period.id, last, "open", userId, only);
  }
}
setRestater((tx, keys, from, posted, userId) => restateAfter(tx, keys as ForeignKey[], from, posted, userId));

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
  // The balances settled since the month's end, as they stand now (see restateSettled).
  await restateSettled(tx, month, period.id, revaluationJournalId, "closed", userId);

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
  if (period.revaluationJournalId) {
    await reverseJournal(tx, period.revaluationJournalId, {
      date: monthRange(month).to,
      type: "revaluation",
      memo: `Réouverture ${deMonth(month)}\u00a0: annulation de la réévaluation`,
      userId,
      skipPeriodCheck: true,
    });
  }
  // What was settled since of the revaluation, as reopened (see restateSettled).
  await restateSettled(tx, month, period.id, period.revaluationJournalId, "open", userId);
  await tx
    .update(periods)
    .set({ status: "open", closingJournalId: null, revaluationJournalId: null, result: null, grossProfit: null, operatingExpenses: null, closedAt: null, closedBy: null })
    .where(eq(periods.id, period.id));
}
