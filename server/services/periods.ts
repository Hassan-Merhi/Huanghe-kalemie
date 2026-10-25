import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { accounts, exchangeRates, journalLines, journals, parties, partners, periods } from "@shared/schema";
import { splitProfit, type PartnerSplitResult } from "@shared/partnerSplit";
import { dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict } from "../errors";
import { deMonth, frDate, frNumber, monthText } from "@shared/french";
import { cents } from "@shared/money";
import { cnyRateFor, lockBalances, lockPeriodsExclusive, postJournal, rateFor, REVALUATION_SETTLED_MEMO, REVALUATION_SOURCES, REVALUED_MEMO, reverseJournal, setRestater, SYSTEM_ACCOUNTS, systemAccountId, foreignMarkedOwed, type PostLine } from "./ledger";
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
  posts: { key: ForeignKey; date: string; usd: Decimal; restates: number | null }[],
  journal: { memo: string; sourceType: string; sourceId: number; userId: number | null; settled: boolean },
) {
  const label = journal.settled ? { memo: REVALUATION_SETTLED_MEMO, kind: null } : { memo: REVALUED_MEMO, kind: "revalued" as const };
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  // Every contact restated, all at once and in id order, before the day's journals take theirs (see
  // lockBalances): a day's contacts after the day before's would be out of order. After a posting (see
  // restateAfter) they are the posting's own, held already.
  await lockBalances(tx, { parties: posts.map((p) => p.key.partyId) });
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
          restatesJournalId: p.restates,
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
 * - a container's reversal that takes a supplier's yuan or franc bill away: of the revaluation still on
 *   their yuan or francs owed (or paid since it was posted), the share of those it leaves stays (see
 *   foreignMarkedOwed), the rest left with the bill. Otherwise, a posting that turns what is owed into a
 *   claim (or a claim into yuan or francs owed) leaves none of it. Posted with the month closed, the
 *   posting moved it to exchange differences (see yuanTrueUpLines), so reopened it is taken back there;
 *   posted with it reopened, closing it again moves it there;
 * - a part of them paid (or refunded) before the month was closed, at what they cost before the
 *   revaluation, or taken away by the undoing of a posting from before the month's end at what it booked
 *   them: its share of the revaluation leaves with it (closed, the state is the same whether the month was
 *   closed before or after it), as a part paid with the month closed takes its share at the revalued cost.
 *   The undoing of a posting since the month's end gives back what that posting took.
 * Drawers keep their revaluation (see selfCheck): only the revaluation and its undoing are on them.
 */
async function restateSettled(tx: Tx, month: string, periodId: number, revaluationJournalId: number | null, state: "closed" | "open", userId: number | null, only?: { keys: Set<string>; from: string }): Promise<boolean> {
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
  if (!keys.size) return false;
  // When the month was closed: from each of its revaluations until the reversal that undid it.
  const closes = await tx
    .select({ id: journals.id, reversedBy: journals.reversedByJournalId })
    .from(journals)
    .where(and(eq(journals.type, "revaluation"), eq(journals.sourceType, "period"), eq(journals.sourceId, periodId), isNull(journals.reversesJournalId)));
  const postedClosed = (id: number) => closes.some((c) => c.id < id && (!c.reversedBy || c.reversedBy > id));
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  // Not an employee's francs: a cancelled run leaves what the rate left with them (see reverseJournal), so
  // their francs are counted as any balance's, not as a supplier's bills (see foreignMarkedOwed).
  const partyIds = Array.from(new Set(Array.from(keys.values()).filter((k) => k.accountId === payables && k.partyId).map((k) => k.partyId!)));
  const employees = new Set(partyIds.length ? (await tx.select({ id: parties.id }).from(parties).where(and(inArray(parties.id, partyIds), eq(parties.type, "employee")))).map((p) => p.id) : []);
  const posts: { key: ForeignKey; date: string; usd: Decimal; restates: number | null }[] = [];
  for (const [k, key] of keys) {
    const cap = restated.get(k) ?? new Decimal(0);
    const rows = await tx
      .select({ journalId: journalLines.journalId, date: journals.date, type: journals.type, reverses: journals.reversesJournalId, sourceType: journals.sourceType, sourceId: journals.sourceId, native: journalLines.nativeAmount, usd: sql<string>`${journalLines.debit} - ${journalLines.credit}`, restates: journalLines.restatesJournalId })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, key.accountId), key.partyId ? eq(journalLines.partyId, key.partyId) : isNull(journalLines.partyId), eq(journalLines.currency, key.currency)))
      .orderBy(journals.date, journals.id, journalLines.id);
    const marks = key.accountId === payables && key.partyId && !employees.has(key.partyId) ? await foreignMarkedOwed(tx, payables, key.partyId, key.currency, to, postedClosed) : null;
    const dateOf = new Map(rows.map((r) => [r.journalId, r.date]));
    // What each part paid since the month's end took off the revaluation, closed and reopened: undone, its
    // francs or yuan come back as they left (see reverseJournal), and what it took comes back with them.
    const took = new Map<number, { closed: Decimal; open: Decimal; owed?: boolean; lot?: Decimal; over?: boolean }>();
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
      // What each posting that day moves of the revaluation left on the balance (in the state it is brought
      // to), and what the month's own journals that day already put on it for each.
      const moves = new Map<number | null, Decimal>();
      const had = new Map<number | null, Decimal>();
      let mover: number | null = null;
      for (let j = 0; j < day.length; ) {
        const id = day[j].journalId;
        const was = native;
        const before = { closed, open };
        for (; j < day.length && day[j].journalId === id; j++) {
          const r = day[j];
          native = native.plus(dec(r.native ?? 0));
          if (ofMonth(r)) {
            if (date > to) {
              current = current.plus(dec(r.usd));
              had.set(r.restates, (had.get(r.restates) ?? new Decimal(0)).plus(dec(r.usd)));
            }
          } else others = others.plus(dec(r.usd));
        }
        if (date <= to) continue;
        const last = day[j - 1];
        const undoes = last.reverses && last.type !== "revaluation" && dateOf.has(last.reverses) ? last.reverses : null;
        // Only to the yuan or francs it paid (or refunded): once a bill's reversal has turned what was owed
        // into a claim (or the other way), the undoing trues them up at what was paid (see yuanTrueUpLines),
        // its share with them. A payment that emptied the balance gives back what it took, whatever was billed
        // since: a bill dated after the month's end holds none of the revaluation, so owed again or not, the
        // yuan or francs it took come back as they left.
        const gave = undoes ? took.get(undoes) : undefined;
        const restored = !!gave && !!marks && (gave.owed === undefined || (!native.isZero() && native.isNegative() === gave.owed));
        if (restored) {
          // In the share of its yuan or francs that come back owed to the bills owed at the month's end (see
          // foreignMarkedOwed): those that paid a bill of them taken away since left their share with it, and
          // are a claim now, or pay a bill since. A payment of all that was owed and more: in the share of what
          // it took that the francs or yuan coming back owed hold, each by its share (see over below, and
          // YuanPool.markedWeight): those it paid itself hold its average, those its claim met hold their
          // bill's (none for a bill since), and those that paid a bill of the month taken away since left
          // theirs with that bill.
          const m0 = marks?.get(id);
          const back = gave.over ? m0?.owed.after.minus(m0.owed.before) : m0?.lot;
          const share = gave.lot?.gt(0) && back ? Decimal.min(back.dividedBy(gave.lot), 1) : new Decimal(1);
          closed = closed.plus(cents(gave.closed.times(share)));
          open = open.plus(cents(gave.open.times(share)));
        }
        const m = restored || ofMonth(last) ? undefined : marks?.get(id);
        // What was owed turned into a claim, or the other way: none of what the revaluation restated is
        // left, so none of it stays.
        // A bill taken away leaves the share of those still owed: counted by the yuan or francs owed at the
        // month's end that carry it, or, when those were all paid before the month was closed (they carry none
        // of it then: see YuanPool.markedOwed), by the share those still owed hold (see YuanPool.markedWeight),
        // a bill since among them, as when the month was closed first and the payment carried its own.
        const shared = !!m?.removal && (m.before.gt(0) ? !m.after.equals(m.before) : m.owed.before.gt(0) && !m.owed.after.equals(m.owed.before));
        // The revaluation still on the balance is on the yuan or francs still owed, each by its share (see
        // YuanPool.markedWeight): a part paid of them took its share at their average cost as it was paid (see
        // paidPart below), whenever the month was closed, so those paid keep none of it here, and a bill since
        // holds what that average left on it. In the share of those owed, when any were.
        const sharedOf = m?.owed.before.gt(0) ? m.owed.after.dividedBy(m.owed.before) : m ? m.after.dividedBy(m.before) : null;
        const crossed = !restored && !shared && !ofMonth(last) && !was.isZero() && !native.isZero() && was.isNegative() !== native.isNegative();
        // A part of them paid (or refunded) before the month was closed, at what they cost before the
        // revaluation, or taken away by the undoing of a posting from before the month's end (a cancelled
        // salary run, a sale returned), which gives them back at what they were booked: its share of the
        // revaluation leaves with it, as a payment made once the month is closed takes its share at the
        // revalued cost. A payment takes the yuan or francs owed out at their average cost (see bookValue),
        // a bill since among them: its share is in proportion to the yuan or francs, as closed first; paid
        // with the month closed, it took that share itself, so reopened it is taken back (see below). An
        // undoing takes its own: the share of the supplier's yuan or francs owed at the month's end it took
        // (see foreignMarkedOwed: a bill since, paid or taken away, leaves them as they were). A supplier's
        // bills only: other balances (an employee's francs, the withholdings) keep the rules above. Not the
        // undoing of a posting since the month's end. Once the bills owed at the month's end are paid, before
        // the month was closed, what the revaluation left on those still owed (bills since) goes the same way
        // with the parts paid of them before the close, as the books take them out at their average cost.
        const paidPart = !undoes && !!m && !m.removal && (m.before.gt(0) || (!postedClosed(id) && !closed.minus(open).isZero())) && was.isNegative() && native.isNegative() && native.gt(was);
        const owedPart = !!undoes && !!m && m.before.gt(0) && m.after.lt(m.before);
        // A supplier's franc claim (francs they owe back, none of their bills owed at the month's end)
        // refunded in part: its share in proportion to the francs, closed or reopened alike. Not yuan: a
        // yuan claim's revaluation goes with the yuan refunded in the pool, and the true-up books it (see
        // YuanPool.takeClaim, yuanTrueUpLines), while the franc true-up can be skipped (see there).
        const claimPart = key.currency === "CDF" && !!m && !m.before.gt(0) && was.gt(0) && native.gt(0) && native.lt(was);
        const ratio = owedPart ? m!.after.dividedBy(m!.before) : paidPart || claimPart ? native.dividedBy(was) : null;
        const part = !restored && !shared && !crossed && last.type !== "revaluation" && (paidPart || claimPart || !postedClosed(id) || !!undoes) && !(undoes && dateOf.get(undoes)! > to) && ratio !== null;
        if (shared || crossed || part) {
          const kept = shared ? cents(closed.minus(open).times(sharedOf!)) : part ? cents(closed.minus(open).times(ratio!)) : new Decimal(0);
          // Posted with the month closed, a payment took its share at the revalued cost, and a bill's
          // removal moved it to exchange differences (see yuanTrueUpLines): reopened, it is taken back.
          if (postedClosed(id) && !(part && undoes)) open = closed.minus(kept);
          else closed = open.plus(kept);
        }
        // Only a posting empties a balance: a revaluation moves no yuan or francs. The undoing of a posting
        // since the month's end too: its francs or yuan come back as they left, but the balance they come
        // back to may hold none by then (its bill taken away since).
        const emptied = native.isZero() && last.type !== "revaluation";
        if (emptied) closed = open = clampTo(others.negated(), cap);
        // What a part released (see above), or a payment that emptied the balance or paid all that was owed
        // and more, comes back with its undoing: its francs or yuan come back at what they left, and the
        // revaluation they left with (a payment before the close took none of it) with them, so a payment
        // that met them first, undone too, finds them owed as it left them. The other cases have their own.
        // Paying all that was owed and more, it takes them out at its own average cost, the claim's among them,
        // and its undoing brings back owed (to the bills they paid, one since among them) those they paid at
        // that cost (see YuanPool.removeLot): of what they left with, the share of those comes back, the claim's
        // leaves with the claim. Counted by the share of the revaluation they hold (see YuanPool.markedWeight):
        // what it paid held all it took.
        const over = crossed && !undoes && was.isNegative();
        const paidWeight = over && marks?.get(id) ? marks.get(id)!.owed.before.minus(marks.get(id)!.owed.after) : undefined;
        if ((part && !native.isZero()) || (emptied && !undoes) || over) took.set(id, { closed: before.closed.minus(closed), open: before.open.minus(open), owed: was.isZero() ? undefined : was.isNegative(), lot: over ? paidWeight : marks?.get(id)?.lot, over });
        const move = state === "closed" ? closed.minus(before.closed) : open.minus(before.open);
        if (!move.isZero()) {
          moves.set(id, (moves.get(id) ?? new Decimal(0)).plus(move));
          mover = id;
        }
      }
      if (date <= to) continue;
      // Closed, the revaluation itself puts `cap` on it at the month's end.
      const want = (state === "closed" ? closed.minus(cap) : open).minus(current).minus(posted);
      // After a posting (see restateAfter), only what it can change: the days from its date on.
      if (only && date < only.from) {
        posted = posted.plus(want);
        continue;
      }
      // Each line says which posting it restates (see foreignPool, which puts it on that posting's francs or
      // yuan, whatever was posted the same day since): what each moved, less what the month's journals that
      // day already put on it. What is left (lines written before they said so) goes with the last that moved.
      const parts = new Map<number | null, Decimal>(moves);
      for (const [x, v] of had) if (x !== null) parts.set(x, (parts.get(x) ?? new Decimal(0)).minus(v));
      const rest = want.minus(sum(Array.from(parts.values())));
      const anchor = mover ?? Array.from(had.keys()).filter((x) => x !== null).at(-1) ?? null;
      if (!rest.isZero()) parts.set(anchor, (parts.get(anchor) ?? new Decimal(0)).plus(rest));
      for (const [x, usd] of parts) if (!usd.isZero()) posts.push({ key, date, usd, restates: x });
      posted = posted.plus(want);
    }
  }
  if (!posts.length) return false;
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
  return true;
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
  // An undoing changes what the months' revaluations leave on its own day (what the posting it undoes
  // took off them comes back, a posting from before a month's end taken away leaves with its share: see
  // restateSettled), whatever is dated after.
  const [undoing] = await tx
    .select({ id: journals.id })
    .from(journals)
    .where(and(inArray(journals.id, posted), isNotNull(journals.reversesJournalId)))
    .limit(1);
  for (const key of keys) {
    if (undoing) {
      later.push(foreignKeyOf(key));
      continue;
    }
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
  const months = (await tx.select().from(periods).orderBy(asc(periods.month))).flatMap((period): { period: typeof periods.$inferSelect; journalId: number; state: "closed" | "open" }[] => {
    const last = revaluations.filter((r) => r.periodId === period.id).reduce<number | null>((m, r) => (m === null || r.id > m ? r.id : m), null);
    if (period.status === "closed") return period.revaluationJournalId ? [{ period, journalId: period.revaluationJournalId, state: "closed" as const }] : [];
    return last ? [{ period, journalId: last, state: "open" as const }] : [];
  });
  // Each month counts what the others' journals moved on a day (see restateSettled), so one month's journals
  // posted here can change what an earlier one leaves that day: again, until none moves anything (closing or
  // reopening any of them would then book nothing new).
  for (let pass = 0; pass < (months.length > 1 ? 4 : 1); pass++) {
    let moved = false;
    for (const m of months) if (await restateSettled(tx, m.period.month, m.period.id, m.journalId, m.state, userId, only)) moved = true;
    if (!moved) break;
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
  // Every contact the close restates (see restateSettled: those the revaluation restates, and those its
  // journals moved since the month's end), all at once and in id order, before the revaluation's money
  // lines: a drawer it credits takes its money lock (see lockBalances).
  const settledParties = await tx
    .selectDistinct({ partyId: journalLines.partyId })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journals.type, "revaluation"), eq(journals.sourceId, period.id), inArray(journals.sourceType, REVALUATION_SOURCES), isNotNull(journalLines.partyId)));
  await lockBalances(tx, { parties: [...reval.lines.map((l) => l.partyId), ...settledParties.map((p) => p.partyId)] });
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
