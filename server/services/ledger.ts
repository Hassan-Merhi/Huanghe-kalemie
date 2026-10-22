import { and, desc, eq, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { deMonth, frDate, frMoney, frNumber } from "@shared/french";
import {
  accounts,
  auditLog,
  counters,
  exchangeRates,
  journalLines,
  journals,
  parties,
  periods,
  settings,
  users,
  type Currency,
  type LineCurrency,
  type LineKind,
  type JournalType,
} from "@shared/schema";
import { cents, dec, sum, Decimal, type DecimalInput } from "@shared/money";
import { atTransactionEnd, type Tx } from "../db";
import { log } from "../log";
import { AppError, badRequest, conflict, francDecimalsError } from "../errors";

export const SYSTEM_ACCOUNTS = {
  cashUsd: "cash_usd",
  cashCdf: "cash_cdf",
  receivables: "receivables",
  inventory: "inventory",
  goodsInTransit: "goods_in_transit",
  payables: "payables",
  payrollWithheld: "payroll_withheld",
  openingEquity: "opening_equity",
  sales: "sales",
  otherIncome: "other_income",
  fx: "fx",
  cogs: "cogs",
  stockAdjustments: "stock_adjustments",
} as const;
export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

/** Accounts that need a customer, supplier or agent on every line. */
const PARTY_REQUIRED: string[] = [SYSTEM_ACCOUNTS.receivables, SYSTEM_ACCOUNTS.payables];

const accountIdCache = new Map<string, number>();

export function clearLedgerCache(): void {
  accountIdCache.clear();
}

export async function systemAccountId(tx: Tx, key: SystemAccountKey): Promise<number> {
  const cached = accountIdCache.get(key);
  if (cached) return cached;
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, key));
  if (!row) throw new AppError(500, `System account ${key} is missing. Run the seed.`, "SETUP", `Le compte système ${key} est manquant. Lancez le seed.`);
  accountIdCache.set(key, row.id);
  return row.id;
}

/**
 * Counters drawn from a sequence. A sequence holds no lock until commit, so a posting that writes
 * several journals cannot wait on another posting's number while holding a franc balance (and the
 * other way round). A number drawn by a posting that fails is not reused.
 */
const SEQUENCES: Record<string, string> = { journal: "journal_number_seq" };

export async function nextNumber(tx: Tx, key: string, prefix: string, width = 6): Promise<string> {
  const seq = SEQUENCES[key];
  if (seq) {
    const r = await tx.execute<{ value: string }>(sql`select nextval(${seq}::regclass)::text as value`);
    return `${prefix}${r.rows[0].value.padStart(width, "0")}`;
  }
  const result = await tx.execute<{ value: number }>(sql`
    INSERT INTO ${counters} (key, value) VALUES (${key}, 1)
    ON CONFLICT (key) DO UPDATE SET value = ${counters.value} + 1
    RETURNING value
  `);
  const value = Number(result.rows[0].value);
  return `${prefix}${String(value).padStart(width, "0")}`;
}

export function monthOf(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("Dates must be YYYY-MM-DD", "Les dates doivent être au format AAAA-MM-JJ");
  return date.slice(0, 7);
}

/**
 * Every posting (and every rate saved) holds this lock shared until it commits; closing or reopening a
 * month holds it alone. A close therefore waits for the postings already under way and counts them,
 * and a posting that starts during the close waits and then sees the month closed. One key for all
 * months, so a month with no periods row yet is covered too. It is always the first lock a posting
 * takes in postJournal, before the money and franc locks, and a close takes it before anything else.
 */
const PERIODS_LOCK = "periods:close";

export async function lockPeriodsShared(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${PERIODS_LOCK}))`);
}

export async function lockPeriodsExclusive(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PERIODS_LOCK}))`);
}

/*
 * Lock order. Every transaction takes its locks in this order, so no two can wait on each other:
 *   1. the periods lock, shared (PERIODS_LOCK);
 *   2. the items' rows, in id order (lockVariants);
 *   3. the contacts' balances, in id order, then the balance sheet accounts' balances, in id order
 *      (lockBalances);
 *   4. the franc and yuan balances, in key order, then the money accounts paid from, in id order
 *      (both in postJournal).
 * A contact's balance is locked before anything reads it to decide how a payment or a bill is split or
 * applied (a dollar advance taken by a yuan bill, yuan settled by a payment, a refund capped by what was
 * paid ahead), and by every posting that writes to it: the journal number used to queue them all, but it
 * comes from a sequence now and holds nothing.
 */
type HeldLocks = { variants: Set<number>; parties: Set<number>; accounts: Set<number>; later: boolean };
const heldLocks = new WeakMap<object, HeldLocks>();

function held(tx: Tx): HeldLocks {
  const fresh = (): HeldLocks => ({ variants: new Set(), parties: new Set(), accounts: new Set(), later: false });
  // Outside a transaction a lock lasts one statement, so nothing is remembered as held.
  if (typeof (tx as { rollback?: unknown }).rollback !== "function") return fresh();
  let h = heldLocks.get(tx);
  if (!h) heldLocks.set(tx, (h = fresh()));
  return h;
}

/**
 * A lock asked for out of order could deadlock (and the transaction would be run again). It is logged
 * and taken anyway; with HK_LOCK_ORDER=strict (the lock order tests) it fails instead. Tests that run
 * several services in one transaction on purpose are not routes, so they are not logged.
 */
function outOfOrder(what: string): void {
  const message = `Lock taken out of order: ${what}`;
  if (process.env.HK_LOCK_ORDER === "strict") throw new AppError(500, message, "LOCK_ORDER", `Verrou pris dans le désordre : ${what}`);
  if (!process.env.VITEST) console.warn(message);
}

/** Notes the items' row locks (step 2 of the lock order; see lockVariants). */
export function noteVariantLocks(tx: Tx, ids: number[]): void {
  const h = held(tx);
  const fresh = ids.filter((id) => !h.variants.has(id));
  if (fresh.length && (h.parties.size || h.accounts.size || h.later)) outOfOrder(`items ${fresh.join(", ")} after a balance`);
  fresh.forEach((id) => h.variants.add(id));
}

/**
 * Lock contacts' balances (and balance sheet accounts' balances, kept apart from contacts) for the rest
 * of the transaction, in id order. Taking one already held does nothing.
 */
export async function lockBalances(tx: Tx, input: { parties?: (number | null | undefined)[]; accounts?: (number | null | undefined)[] }): Promise<void> {
  const h = held(tx);
  const fresh = (ids: (number | null | undefined)[] | undefined, have: Set<number>) =>
    Array.from(new Set((ids ?? []).filter((x): x is number => !!x && !have.has(x)))).sort((a, b) => a - b);
  const parties = fresh(input.parties, h.parties);
  const accounts = fresh(input.accounts, h.accounts);
  if (!parties.length && !accounts.length) return;
  if (h.later) outOfOrder(`balances ${[...parties, ...accounts].join(", ")} after a franc or money lock`);
  if (parties.length && (h.accounts.size || parties[0] < Math.max(0, ...h.parties))) outOfOrder(`contact ${parties.join(", ")} after ${[...h.parties].join(", ") || "an account"}`);
  if (accounts.length && accounts[0] < Math.max(0, ...h.accounts)) outOfOrder(`account ${accounts.join(", ")} after ${[...h.accounts].join(", ")}`);
  await lockPeriodsShared(tx);
  for (const id of parties) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`party:${id}`}))`);
    h.parties.add(id);
  }
  for (const id of accounts) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit:account:${id}`}))`);
    h.accounts.add(id);
  }
}

/** Lock franc and yuan balances (step 4 of the lock order), in key order. */
export async function lockForeignBalances(tx: Tx, keys: { accountId: number; partyId: number | null; currency: string }[]): Promise<void> {
  const h = held(tx);
  h.later = true;
  for (const key of Array.from(new Set(keys.map((k) => `${k.accountId}|${k.partyId ?? ""}|${k.currency}`))).sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fx:${key}`}))`);
  }
}

/**
 * Refuse a posting dated in a closed month, or before the last closed month: months close in
 * order, so a posting into an earlier open month would still change balances already closed.
 */
export async function assertPeriodOpen(tx: Tx, date: string): Promise<void> {
  const month = monthOf(date);
  // Read the periods only once no close is under way (see PERIODS_LOCK).
  await lockPeriodsShared(tx);
  const [row] = await tx
    .select({ month: periods.month })
    .from(periods)
    .where(and(eq(periods.status, "closed"), sql`${periods.month} >= ${month}`))
    .orderBy(sql`${periods.month} desc`)
    .limit(1);
  if (row) {
    const closed = row.month;
    if (closed === month) {
      throw new AppError(409, `${month} is closed. Reopen it before changing anything dated in that month.`, "PERIOD_CLOSED", `Le mois ${deMonth(month)} est clôturé. Rouvrez-le avant de modifier quoi que ce soit daté de ce mois.`);
    }
    throw new AppError(
      409,
      `${closed} is closed, so nothing dated in ${month} or earlier can change. Reopen the closed months first.`,
      "PERIOD_CLOSED",
      `Le mois ${deMonth(closed)} est clôturé\u00a0: rien de daté ${deMonth(month)} ou avant ne peut changer. Rouvrez d'abord les mois clôturés.`,
    );
  }
}

/** USD equivalent of a native amount. rate is CDF per 1 USD. */
export function toUsd(currency: Currency, native: DecimalInput, rate?: DecimalInput | null): string {
  if (currency === "USD") return cents(native).toFixed(2);
  const r = dec(rate, "exchange rate");
  if (r.lte(0)) throw badRequest("A CDF amount needs an exchange rate greater than zero", "Un montant en FC nécessite un taux de change supérieur à zéro");
  return cents(dec(native).dividedBy(r)).toFixed(2);
}

export type ForeignCurrency = "CDF" | "CNY";

export interface PostLine {
  accountId: number;
  debit?: DecimalInput;
  credit?: DecimalInput;
  partyId?: number | null;
  /**
   * Unsigned native amount and its rate (units per 1 USD). Required on CDF money accounts; on a
   * contact line it puts the amount in that contact's balance in that currency.
   */
  nativeAmount?: DecimalInput | null;
  rate?: DecimalInput | null;
  /** Currency of nativeAmount on a non-money line (money accounts use their own currency). */
  currency?: ForeignCurrency | null;
  memo?: string | null;
  /** Only on a line the books write themselves (see LineKind); a person's line has none, whatever its memo. */
  kind?: LineKind | null;
  /** Only on a reversal's copy of a line valued at average cost: the opposite of what that one moved (see fxUsd). */
  fxUsd?: DecimalInput | null;
}

export interface PostJournalInput {
  date: string;
  type: JournalType;
  memo?: string | null;
  sourceType?: string | null;
  sourceId?: number | null;
  reversesJournalId?: number | null;
  userId?: number | null;
  lines: PostLine[];
  /** Period close posts into the month it closes, so it skips the lock check. */
  skipPeriodCheck?: boolean;
  /**
   * Keep every USD amount exactly as given. Otherwise francs (or yuan) leaving a balance are
   * valued at what that balance cost on average, and the difference is an exchange gain or loss.
   */
  exactValues?: boolean;
  /**
   * A reversal: dollars a month-end revaluation, or the rate's moves, left on a franc or yuan balance this
   * journal empties go to exchange differences in it (see revaluedDollarLines).
   */
  clearRevalued?: boolean;
}

/** Native and USD totals of one foreign-currency balance: a CDF money account, or a contact's CDF/CNY balance. */
export async function foreignBalance(tx: Tx, accountId: number, partyId: number | null, currency: LineCurrency, asOf?: string) {
  const [row] = await tx
    .select({
      native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`,
      usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(
      and(
        eq(journalLines.accountId, accountId),
        partyId ? eq(journalLines.partyId, partyId) : sql`true`,
        eq(journalLines.currency, currency),
        asOf ? lte(journals.date, asOf) : sql`true`,
      ),
    );
  return { native: dec(row.native), usd: dec(row.usd) };
}

/**
 * USD value, at average book cost, of `native` units taken out of a balance of `bal`. Only the part
 * the balance covers is at book cost; anything beyond it keeps `fallbackUsd` in proportion.
 */
export function bookValue(bal: { native: Decimal; usd: Decimal }, native: Decimal, fallbackUsd: Decimal): Decimal {
  const n = bal.native.abs();
  const u = bal.usd.abs();
  // Only a balance whose USD side has the same sign as its native side has a meaningful cost.
  if (n.isZero() || (!bal.usd.isZero() && bal.usd.isNegative() !== bal.native.isNegative())) return fallbackUsd;
  if (native.lte(n)) return native.equals(n) ? u : cents(u.times(native).dividedBy(n));
  const rest = native.minus(n);
  return u.plus(cents(fallbackUsd.times(rest).dividedBy(native)));
}

/**
 * Post a balanced journal. Lines with no amount are dropped; a journal with no amount at all
 * is not created and null is returned.
 */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<number | null> {
  if (!input.skipPeriodCheck) {
    await assertPeriodOpen(tx, input.date);
    assertNotFuture(input.date);
  } else monthOf(input.date);

  const netted = input.lines
    .map((l) => ({ ...l, debit: cents(l.debit ?? 0), credit: cents(l.credit ?? 0) }))
    .map((l) => {
      if (l.debit.isNegative() || l.credit.isNegative()) {
        throw new AppError(500, "Journal amounts cannot be negative", "LEDGER", "Les montants d'une écriture ne peuvent pas être négatifs");
      }
      // Net a line that has both sides.
      if (!l.debit.isZero() && !l.credit.isZero()) {
        const net = l.debit.minus(l.credit);
        return { ...l, debit: net.isPositive() ? net : dec(0), credit: net.isNegative() ? net.abs() : dec(0) };
      }
      return l;
    });

  // Francs (or yuan) worth less than a cent would disappear from the books with no trace.
  const tiny = netted.find((l) => l.debit.isZero() && l.credit.isZero() && l.nativeAmount != null && !cents(l.nativeAmount).isZero());
  if (tiny && !input.skipPeriodCheck && !input.exactValues) {
    const [account] = await tx.select({ name: accounts.name, isMoney: accounts.isMoney }).from(accounts).where(eq(accounts.id, tiny.accountId));
    if (account) {
      throw badRequest(
        `${cents(tiny.nativeAmount!).toFixed(2)} is worth less than one cent: enter a larger amount`,
        `${cents(tiny.nativeAmount!).toFixed(2)} vaut moins d'un centime de dollar : saisissez un montant plus grand`,
      );
    }
  }
  const lines = netted.filter((l) => !l.debit.isZero() || !l.credit.isZero());

  if (lines.length === 0) return null;

  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  if (!totalDebit.equals(totalCredit)) {
    throw new AppError(
      500,
      `Journal does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}`,
      "LEDGER_UNBALANCED",
      `Écriture déséquilibrée : débits ${frMoney(totalDebit)} contre crédits ${frMoney(totalCredit)}`,
    );
  }
  if (lines.length < 2) throw new AppError(500, "A journal needs at least two lines", "LEDGER", "Une écriture doit avoir au moins deux lignes");

  const ids = Array.from(new Set(lines.map((l) => l.accountId)));
  const accountRows = await tx.select().from(accounts).where(inArray(accounts.id, ids));
  const byId = new Map(accountRows.map((a) => [a.id, a]));

  const values: PendingLine[] = lines.map((l) => {
    const account = byId.get(l.accountId);
    if (!account) throw badRequest(`Account ${l.accountId} does not exist`, `Le compte ${l.accountId} n'existe pas`);
    if (!account.active) throw badRequest(`Account ${account.name} is inactive`, `Le compte ${account.name} est inactif`);
    if (account.systemKey && PARTY_REQUIRED.includes(account.systemKey) && !l.partyId) {
      throw badRequest(`${account.name} needs a customer, supplier or agent`, `${account.name} nécessite un client, un fournisseur ou un agent`);
    }
    const isCdfMoney = account.isMoney && account.currency === "CDF";
    const currency: Currency | ForeignCurrency = isCdfMoney ? "CDF" : !account.isMoney && l.currency && l.nativeAmount != null ? l.currency : "USD";
    let nativeAmount: string | null = null;
    let rate: string | null = null;
    if (currency !== "USD") {
      if (l.nativeAmount === undefined || l.nativeAmount === null || !l.rate) {
        throw badRequest(`${account.name} is a CDF account: give the CDF amount and the rate`, `${account.name} est un compte en FC : indiquez le montant en FC et le taux`);
      }
      const native = cents(l.nativeAmount).abs();
      nativeAmount = (l.debit.isZero() ? native.negated() : native).toFixed(2);
      rate = dec(l.rate).toFixed(4);
    }
    return {
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      partyId: l.partyId ?? null,
      currency: currency as LineCurrency,
      nativeAmount,
      rate,
      memo: l.memo ?? null,
      kind: l.kind ?? null,
      fxUsd: l.fxUsd != null ? cents(l.fxUsd) : null,
    };
  });

  // Every contact the journal writes to, before its francs and yuan (see lockBalances). A period close
  // holds the periods lock alone, so nothing else is posting.
  if (!input.skipPeriodCheck) {
    await lockBalances(tx, { parties: values.map((v) => v.partyId) });
    await assertYuanInOrder(tx, values, input.date);
  }
  if (!input.exactValues) await costForeignOutflows(tx, values, input.date, byId, !input.skipPeriodCheck);
  if (input.clearRevalued && !input.skipPeriodCheck) {
    const emptied = values.filter((v) => v.currency !== "USD" && v.nativeAmount && !byId.get(v.accountId)?.isMoney);
    values.push(...(await revaluedDollarLines(tx, emptied as RevaluedKey[], input.date, values)));
  }

  const number = await nextNumber(tx, "journal", "J-");
  const [journal] = await tx
    .insert(journals)
    .values({
      number,
      date: input.date,
      type: input.type,
      memo: input.memo ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reversesJournalId: input.reversesJournalId ?? null,
      createdBy: input.userId ?? null,
    })
    .returning({ id: journals.id });

  // Money paid out is checked against what the account holds, one posting at a time per account.
  const paidFrom = input.skipPeriodCheck
    ? []
    : Array.from(new Set(values.filter((v) => v.credit.gt(0) && byId.get(v.accountId)?.isMoney).map((v) => v.accountId))).sort((a, b) => a - b);
  if (paidFrom.length) held(tx).later = true;
  for (const id of paidFrom) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`money:${id}`}))`);

  await tx.insert(journalLines).values(
    values.map((v) => ({ ...v, debit: v.debit.toFixed(2), credit: v.credit.toFixed(2), fxUsd: v.fxUsd ? v.fxUsd.toFixed(2) : null, journalId: journal.id })),
  );
  for (const id of paidFrom) await assertNotOverdrawn(tx, byId.get(id)!, input.date);
  // Every posting is in the activity log, written in the same transaction so neither exists without the other.
  const total = values.reduce((s, v) => s.plus(v.debit), new Decimal(0));
  await tx.insert(auditLog).values({
    userId: input.userId ?? null,
    action: input.reversesJournalId ? "reverse" : "post",
    entity: input.type,
    entityId: journal.id,
    data: { number, date: input.date, memo: input.memo ?? null, total: total.toFixed(2), sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null },
  });
  if (!input.skipPeriodCheck && input.type !== "revaluation") {
    await noteRestate(
      tx,
      values.filter((v) => (v.currency === "CDF" || v.currency === "CNY") && !!v.nativeAmount && !dec(v.nativeAmount).isZero() && !byId.get(v.accountId)?.isMoney),
      input.date,
      input.userId ?? null,
      journal.id,
    );
  }
  return journal.id;
}

/**
 * What the months' revaluations leave on the francs and yuan a transaction's postings moved, once it is
 * done (see restateSettled in periods.ts, which sets it): a posting dated before others on a balance can
 * empty it on a later day, or no longer, and the month's revaluation goes with that as a close would.
 */
type Restater = (tx: Tx, keys: RevaluedKey[], from: string, posted: number[], userId: number | null) => Promise<void>;
let restater: Restater | null = null;
export function setRestater(fn: Restater) {
  restater = fn;
}
const toRestate = new WeakMap<object, { keys: Map<string, RevaluedKey>; from: string; posted: number[]; userId: number | null }>();

async function noteRestate(tx: Tx, lines: { accountId: number; partyId: number | null; currency: string }[], date: string, userId: number | null, journalId: number) {
  if (!lines.length || !restater) return;
  const known = toRestate.get(tx);
  const pending = known ?? { keys: new Map<string, RevaluedKey>(), from: date, posted: [] as number[], userId };
  pending.posted.push(journalId);
  if (date < pending.from) pending.from = date;
  for (const l of lines) pending.keys.set(`${l.accountId}|${l.partyId ?? ""}|${l.currency}`, { accountId: l.accountId, partyId: l.partyId, currency: l.currency as ForeignCurrency });
  if (known) return;
  toRestate.set(tx, pending);
  await atTransactionEnd(tx, async () => {
    toRestate.delete(tx);
    await restater!(tx, [...pending.keys.values()], pending.from, pending.posted, pending.userId);
  });
}

/** Today in Kalemie (UTC+2). */
export function shopToday(): string {
  return new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
}

/** Refuse postings dated after tomorrow: a typo in the year would otherwise sit in the books unseen. */
export function assertNotFuture(date: string): void {
  const limit = new Date(Date.parse(`${shopToday()}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  if (date > limit) {
    throw badRequest(`${date} is in the future. Check the date.`, `La date ${date} est dans le futur. Vérifiez la date.`);
  }
}

/**
 * Refuse a payment that would take a cash, bank or mobile money account below zero, on its date
 * or on any later day (a payment typed for an earlier day must not empty the till retroactively).
 */
async function assertNotOverdrawn(tx: Tx, account: typeof accounts.$inferSelect, date: string): Promise<void> {
  const amount = account.currency === "USD" ? sql`${journalLines.debit} - ${journalLines.credit}` : sql`coalesce(${journalLines.nativeAmount}, 0)`;
  const result = await tx.execute<{ low: string | null; date: string | null }>(sql`
    with d as (
      select ${journals.date} as date, sum(${amount}) as amt
      from ${journalLines} join ${journals} on ${journals.id} = ${journalLines.journalId}
      where ${journalLines.accountId} = ${account.id}
      group by ${journals.date}
    ), c as (select date, sum(amt) over (order by date) as cum from d)
    select cum::text as low, date::text as date from c where date >= ${date} order by cum asc, date asc limit 1`);
  const row = result.rows[0];
  if (!row?.low) return;
  const low = dec(row.low);
  if (low.lt(-0.005)) {
    const short = low.abs().toFixed(2);
    const cur = account.currency === "CDF" ? "FC" : account.currency;
    throw new AppError(
      409,
      `${account.name} does not hold enough: it would be ${short} ${cur} short on ${row.date}.`,
      "INSUFFICIENT_FUNDS",
      `Solde insuffisant sur ${account.name} : il manquerait ${frMoney(short, account.currency)} au ${frDate(String(row.date))}.`,
    );
  }
}

/**
 * Refuse moving a contact's yuan (a payment, a refund, a reversal, an offload) dated before the latest
 * entry already on their yuan. Yuan taken out are valued at their average cost as of the posting's date
 * (see costForeignOutflows), while what a container's reversal takes back follows the order postings were
 * made in (see foreignPool): dated back, a payment would be costed against yuan a later entry already took,
 * and leave dollars on no yuan. On the same day or later, the two orders are one. Everyone, the owner too:
 * an entry for an earlier day is dated on the day of the latest one instead. The caller holds the
 * contacts' locks, so no later one is posted in between.
 */
async function assertYuanInOrder(tx: Tx, values: { accountId: number; partyId: number | null; currency: LineCurrency; nativeAmount: string | null }[], date: string): Promise<void> {
  // Only lines that move yuan: a month-end revaluation, dated on the last day of the month it closes,
  // moves dollars alone.
  const moves = (v: (typeof values)[number]) => v.currency === "CNY" && !!v.partyId && !dec(v.nativeAmount ?? 0).isZero();
  if (!values.some(moves)) return;
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const ids = Array.from(new Set(values.filter((v) => moves(v) && v.accountId === payables).map((v) => v.partyId!)));
  if (!ids.length) return;
  const [late] = await tx
    .select({ partyId: journalLines.partyId, date: sql<string>`max(${journals.date})::text`, name: parties.name })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(parties, eq(parties.id, journalLines.partyId))
    .where(
      and(
        eq(journalLines.accountId, payables),
        eq(journalLines.currency, "CNY"),
        inArray(journalLines.partyId, ids),
        // Only what moved yuan, as above: a month-end revaluation (and the reversal that undoes it when the
        // month is reopened, and those settled since) moves dollars alone, so a reopened month still takes
        // the yuan work dated before its end. Their dollars spread over the yuan held in the order posted
        // (see foreignPool), and the month closed again revalues what is held by then, in both orders alike.
        sql`coalesce(${journalLines.nativeAmount}, 0) <> 0`,
        ne(journals.type, "revaluation"),
      ),
    )
    .groupBy(journalLines.partyId, parties.name)
    .having(sql`max(${journals.date}) > ${date}`)
    .limit(1);
  if (!late) return;
  throw new AppError(
    409,
    `${late.name} already has a yuan entry dated ${late.date}: their yuan cannot move dated earlier. Date this on ${late.date} or later.`,
    "YUAN_DATE_ORDER",
    `${late.name} a déjà une écriture en yuans datée du ${frDate(late.date)} : ses yuans ne peuvent pas bouger à une date antérieure. Datez celle-ci du ${frDate(late.date)} ou après.`,
  );
}

/** Memo of the exchange difference booked when foreign units leave a balance at its average cost. */
export const COST_FX_MEMO = "Écart de change (coût moyen des devises)";

/** Memo of the line that clears francs or yuan worth under half a cent left on a contact (see costForeignOutflows). */
export const RESIDUE_MEMO = "Reste de moins d'un demi-centime soldé en écart de change";

type PendingLine = {
  accountId: number;
  debit: Decimal;
  credit: Decimal;
  partyId: number | null;
  currency: LineCurrency;
  nativeAmount: string | null;
  rate: string | null;
  memo: string | null;
  kind?: LineKind | null;
  fxUsd?: Decimal | null;
};
type AccountRow = typeof accounts.$inferSelect;

/**
 * Value each foreign-currency line that takes units out of a balance at that balance's average
 * USD cost, and book the difference from the given value as an exchange gain or loss.
 * Francs or yuan left on a contact (or a balance sheet account settled like one) that are worth under
 * half a cent at the rate used could never be paid or refunded: the journal that leaves them, or the
 * next one on that contact, clears them against exchange differences, with no money. Only when their
 * dollars are a cent at most too, as every posting leaves them: dollars that do not match the francs
 * or yuan (a journal posted by hand) are a mistake for a person to correct, shown by the self-check.
 */
async function costForeignOutflows(tx: Tx, values: PendingLine[], date: string, byId: Map<number, AccountRow>, clearResidues: boolean) {
  const running = new Map<string, { native: Decimal; usd: Decimal }>();
  // Francs this journal itself put into a drawer: a part of them given back in the same journal (a sale's
  // change from the drawer it was paid into) leaves at the journal's own value, as one amount with them.
  const cameIn = new Map<string, Decimal>();
  let fxDebit = new Decimal(0);
  const keyOf = (k: { accountId: number; partyId: number | null; currency: string }) => `${k.accountId}|${k.partyId ?? ""}|${k.currency}`;
  const foreign = values.filter((v) => v.currency !== "USD" && v.nativeAmount);
  // The balances that may hold such a residue: those the journal moves, and the franc and yuan balances of
  // every contact it touches (a residue left by an older posting), read here only to see whether to lock them.
  const settled = (accountId: number, partyId: number | null) => {
    const a = byId.get(accountId);
    return !!a && !a.isMoney && (partyId !== null || ((a.type === "asset" || a.type === "liability") && !(a.systemKey && PARTY_REQUIRED.includes(a.systemKey))));
  };
  const residueKeys = new Map<string, { accountId: number; partyId: number | null; currency: ForeignCurrency }>();
  if (clearResidues) {
    for (const v of foreign) if (settled(v.accountId, v.partyId)) residueKeys.set(keyOf(v), { accountId: v.accountId, partyId: v.partyId, currency: v.currency as ForeignCurrency });
    const read = new Set<string>();
    const dayRates: Partial<Record<ForeignCurrency, Decimal | null>> = {};
    for (const v of values) {
      if (!settled(v.accountId, v.partyId)) continue;
      for (const currency of ["CDF", "CNY"] as const) {
        const k = { accountId: v.accountId, partyId: v.partyId, currency };
        if (residueKeys.has(keyOf(k)) || read.has(keyOf(k))) continue;
        read.add(keyOf(k));
        const native = (await foreignBalance(tx, v.accountId, v.partyId, currency, date)).native.abs();
        if (native.isZero()) continue;
        if (!(currency in dayRates)) dayRates[currency] = currency === "CDF" ? (await rateFor(tx, date)).rate : await cnyRateFor(tx, date);
        // Roughly under half a cent (checked again exactly under the lock); a larger balance is left unlocked.
        const r = dayRates[currency];
        if (r && native.dividedBy(r).lt("0.006")) residueKeys.set(keyOf(k), k);
      }
    }
  }
  // One posting at a time per balance, so two payments cannot both spend the same francs. All of the
  // journal's balances at once, in key order, so two journals touching the same two cannot cross.
  if (foreign.length || residueKeys.size) await lockForeignBalances(tx, [...foreign, ...residueKeys.values()]);
  for (const v of values) {
    if (v.currency === "USD" || !v.nativeAmount) continue;
    const key = keyOf(v);
    let bal = running.get(key);
    if (!bal) {
      bal = await foreignBalance(tx, v.accountId, v.partyId, v.currency, date);
      running.set(key, bal);
    }
    const native = dec(v.nativeAmount);
    const given = v.debit.minus(v.credit);
    v.fxUsd = new Decimal(0);
    const reduces = !bal.native.isZero() && !native.isZero() && bal.native.isNegative() !== native.isNegative();
    const own = cameIn.get(key);
    if (v.partyId === null && reduces && own && !own.isZero() && own.isNegative() !== native.isNegative() && native.abs().lte(own.abs())) {
      cameIn.set(key, own.plus(native));
    } else if (reduces) {
      const value = bookValue(bal, native.abs(), given.abs());
      if (v.credit.gt(0)) {
        fxDebit = fxDebit.plus(value.minus(v.credit));
        v.credit = value;
      } else {
        fxDebit = fxDebit.minus(value.minus(v.debit));
        v.debit = value;
      }
      // Each line's own share, so a journal settling two contacts' yuan (or paid from a franc drawer) keeps
      // apart what each was given (see foreignPool).
      v.fxUsd = v.debit.minus(v.credit).minus(given);
    } else if (v.partyId === null) cameIn.set(key, (cameIn.get(key) ?? new Decimal(0)).plus(native));
    bal.native = bal.native.plus(native);
    bal.usd = bal.usd.plus(v.debit.minus(v.credit));
  }
  for (const [key, k] of residueKeys) {
    const bal = running.get(key) ?? (await foreignBalance(tx, k.accountId, k.partyId, k.currency, date));
    if (bal.native.isZero()) continue;
    // Worth under half a cent at the rate this journal used for that balance, else the day's rate.
    const lineRate = foreign.find((v) => keyOf(v) === key && v.rate && dec(v.rate).gt(0))?.rate;
    const rate = lineRate ? dec(lineRate) : k.currency === "CDF" ? (await rateFor(tx, date)).rate : await cnyRateFor(tx, date);
    if (!rate || !bal.native.abs().dividedBy(rate).lt("0.005")) continue;
    // And booked at no more than a cent: a posting can leave one on them (a part taken out at average
    // cost is rounded to the cent), which goes to exchange differences with them, never to a drawer.
    // Larger dollars on so few francs or yuan are not an exchange difference, so they are left where
    // they are for a person to correct (see selfCheck).
    if (bal.usd.abs().gt("0.01")) continue;
    // Only a balance with nothing dated after this journal: clearing it on an earlier day would change
    // what later postings settled.
    const all = await foreignBalance(tx, k.accountId, k.partyId, k.currency);
    const asOf = await foreignBalance(tx, k.accountId, k.partyId, k.currency, date);
    if (!all.native.equals(asOf.native) || !all.usd.equals(asOf.usd)) continue;
    // Dollars of the other sign (a debit brings francs in) cannot carry the francs off: they stay, at none.
    if (!bal.usd.isZero() && bal.usd.isNegative() !== bal.native.isNegative()) continue;
    values.push({
      accountId: k.accountId,
      debit: bal.usd.isNegative() ? bal.usd.abs() : new Decimal(0),
      credit: bal.usd.isPositive() ? bal.usd : new Decimal(0),
      partyId: k.partyId,
      currency: k.currency,
      nativeAmount: bal.native.negated().toFixed(2),
      rate: rate.toFixed(4),
      memo: RESIDUE_MEMO,
      kind: "residue",
    });
    fxDebit = fxDebit.plus(bal.usd);
  }
  if (!fxDebit.isZero()) {
    values.push({
      accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.fx),
      debit: fxDebit.isPositive() ? fxDebit : new Decimal(0),
      credit: fxDebit.isNegative() ? fxDebit.abs() : new Decimal(0),
      partyId: null,
      currency: "USD",
      nativeAmount: null,
      rate: null,
      memo: COST_FX_MEMO,
      kind: "cost_fx",
    });
  }
}

/** Memo of the lines that move to exchange differences the dollars left on a balance a reversal emptied (see revaluedDollarLines). */
export const REVALUED_MEMO = "Écart de change à l'annulation";

/**
 * Memo of the lines by which a container's reversal takes back what its yuan's payments booked to exchange
 * differences, and undoing such a payment gives it back (see yuanTrueUpLines).
 */
export const SETTLED_FX_MEMO = "Écart de change du règlement repris à l'annulation";

type RevaluedKey = { accountId: number; partyId: number | null; currency: ForeignCurrency };

/** Sources of the journals a month's revaluation posts, all with the month's period as their source (see restateSettled). */
export const REVALUATION_SOURCES = ["period", "period_settled", "period_reopened"];

/**
 * Mark the lines the books wrote before lines kept their kind (a backup made before then, restored): by
 * their memo and their shape, never in a journal typed by hand. The same as migration 0015.
 */
export async function markSystemLines(tx: Tx): Promise<void> {
  await tx.execute(sql`
    update journal_lines l set kind = case
        when l.memo = ${COST_FX_MEMO} then 'cost_fx'
        when l.memo = ${RESIDUE_MEMO} then 'residue'
        when l.memo = ${SETTLED_FX_MEMO} then 'settled_fx'
        else 'revalued' end
      from journals j, accounts a
      where j.id = l.journal_id and a.id = l.account_id and l.kind is null and j.type not in ('manual', 'opening') and (
        (l.memo = ${COST_FX_MEMO} and a.system_key = 'fx')
        or (l.memo = ${RESIDUE_MEMO} and abs(l.debit - l.credit) <= 0.01)
        or (l.memo = ${SETTLED_FX_MEMO} and j.type in ('container_reversal', 'reversal')
            and (a.system_key = 'fx' or (l.currency = 'CNY' and l.native_amount = 0)))
        or (l.memo = ${REVALUED_MEMO} and j.type not in ('payment', 'receipt')
            and (a.system_key = 'fx' or l.native_amount is null or l.native_amount = 0 or (l.rate > 0 and abs(l.native_amount) / l.rate < 0.006)))
      )`);
}

/** Memo of the lines that take a revaluation off a balance settled after the month's end (see restateSettled in periods.ts). */
export const REVALUATION_SETTLED_MEMO = "Réévaluation soldée\u00a0: devises réglées après la fin du mois";

/** The labels of the lines the books write themselves (see LineKind). */
const RESERVED_MEMOS = [COST_FX_MEMO, RESIDUE_MEMO, REVALUED_MEMO, SETTLED_FX_MEMO, REVALUATION_SETTLED_MEMO];

/**
 * Refuse a line memo typed as one of the books' own labels. Nothing goes by a memo any more (a line the
 * books write has its kind), but the daybook and the statements would show the typed line as theirs.
 * Whatever the case, accents, spacing or punctuation, or a letter of another alphabet that looks like one.
 */
export function assertMemoNotReserved(memo: string | null | undefined, line: number): void {
  if (!memo) return;
  // Letters and digits alone: accents (and compatibility forms, such as full-width letters), punctuation,
  // symbols, spaces and invisible characters (a zero-width space, a soft hyphen) are dropped before comparing.
  const fold = (t: string) => t.normalize("NFKD").replace(/[\p{M}\p{P}\p{S}\p{Z}\p{C}\s]/gu, "").toLowerCase();
  const typed = Array.from(fold(memo));
  // The labels fold to Latin letters alone: any other letter, of whatever alphabet (a Cyrillic "е", a Greek
  // "ο", an Armenian "օ", a Cherokee "ꭼ", a Latin "ø" no accent folds), or a digit (a "0" for an "o"), stands
  // for whichever letter it sits in place of, while most of the label is there as typed. A note written in
  // another alphabet (Chinese, Russian) is never one.
  const lookalike = (c: string, want: string) => (/\p{L}/u.test(c) && !/[a-z]/.test(c)) || (/\p{N}/u.test(c) && /[a-z]/.test(want));
  const same = (label: string) => {
    const want = Array.from(fold(label));
    if (want.length !== typed.length || !want.every((c, i) => typed[i] === c || lookalike(typed[i], c))) return false;
    return want.filter((c, i) => typed[i] === c).length * 2 > want.length;
  };
  if (!RESERVED_MEMOS.some(same)) return;
  throw badRequest(
    `Line ${line}: "${memo.trim()}" is the label of an entry the books make themselves. Write another note.`,
    `Ligne ${line} : « ${memo.trim()} » est le libellé d'une écriture que la comptabilité passe elle-même. Écrivez une autre note.`,
  );
}

/**
 * A reversal gives francs or yuan back at the dollars they were booked at. When a month-end revaluation
 * restated them in between, or the rate moved between the postings it undoes and those it leaves, a
 * balance can be left with no francs or yuan but some dollars. These lines move them to exchange
 * differences, as the next revaluation would have done. Only for balances of `keys` with no francs or
 * yuan once `pending` (the lines of the journal being posted, if any) is added (in that journal, off a
 * drawer, francs or yuan worth under half a cent count as none and are cleared with the dollars), and
 * nothing dated after `date` (yuan left at none whatever is dated after: see assertYuanInOrder); and only
 * the dollars exchange explains, counted since the balance last stood at no francs or yuan, in the order
 * posted (dollars left from before are not this posting's):
 * - those revaluations booked on it, net of the reversals that undid them;
 * - on a contact (or another account that is not money), what its own francs or yuan can be worth apart at
 *   the rates they were posted at: half of them at the lowest rate against half at the highest, plus half a
 *   cent per line for its rounding;
 * - what a container's reversal took back from the exchange differences of its yuan's payments, or
 *   undoing such a payment gave back (see yuanTrueUpLines).
 * A balance the reversal leaves holding francs or yuan whose dollars have the other sign has its dollars
 * restated to them at the day's rate instead, within the same bound, moving no francs or yuan.
 * Dollars booked on it by hand with no francs or yuan, or more than that, are for a person to correct
 * (see selfCheck), and stay. The lines move no francs or yuan, so no money leaves a drawer: the callers pass
 * no money account a reversal could empty but the one a cancelled payroll paid from, and on it only a
 * revaluation's dollars move.
 */
export async function revaluedDollarLines(tx: Tx, keys: RevaluedKey[], date: string, pending: PendingLine[] = []): Promise<PendingLine[]> {
  const keyOf = (k: { accountId: number; partyId: number | null; currency: string }) => `${k.accountId}|${k.partyId ?? ""}|${k.currency}`;
  const unique = Array.from(new Map(keys.map((k) => [keyOf(k), { accountId: k.accountId, partyId: k.partyId, currency: k.currency }])).values());
  if (!unique.length) return [];
  await lockForeignBalances(tx, unique);
  const moneyIds = new Set(
    (await tx.select({ id: accounts.id }).from(accounts).where(and(inArray(accounts.id, unique.map((k) => k.accountId)), eq(accounts.isMoney, true)))).map((a) => a.id),
  );
  const lines: PendingLine[] = [];
  let gain = new Decimal(0);
  for (const k of unique) {
    const rows = await tx
      .select({
        journalId: journalLines.journalId,
        date: journals.date,
        type: journals.type,
        reverses: journals.reversesJournalId,
        sourceType: journals.sourceType,
        sourceId: journals.sourceId,
        native: journalLines.nativeAmount,
        usd: sql<string>`${journalLines.debit} - ${journalLines.credit}`,
        rate: journalLines.rate,
        kind: journalLines.kind,
      })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(
        and(
          eq(journalLines.accountId, k.accountId),
          k.partyId ? eq(journalLines.partyId, k.partyId) : sql`${journalLines.partyId} is null`,
          eq(journalLines.currency, k.currency),
        ),
      )
      .orderBy(journals.id, journalLines.id);
    const own = pending.filter((v) => keyOf(v) === keyOf(k));
    // A yuan balance left at no yuan is cleared whatever is dated after: no yuan of a contact moves dated
    // before their latest (see assertYuanInOrder), so what is dated later cannot be settled differently.
    const noYuanLeft = k.currency === "CNY" && sum([...rows.map((r) => dec(r.native ?? 0)), ...own.map((v) => dec(v.nativeAmount ?? 0))]).isZero();
    if (!noYuanLeft && rows.some((r) => r.date > date)) continue;
    // Every line, by journal in the order they were posted, the journal being posted last: a reversal
    // dated back before a payment it follows must not start the window after that payment.
    // A month's revaluation, the reversal that undid it (the month reopened) and what closing or reopening
    // it moved on the balances settled since count as one, so closing and reopening a month again and again
    // cannot widen what revaluations explain.
    // A container's reversal takes them back, and undoing what paid or billed the yuan gives them back
    // (see yuanTrueUpLines): only the lines the books wrote as such (their kind), never a memo typed by hand.
    // A journal undone since, and its undoing, count as neither: the francs or yuan it took out came back
    // with their dollars (a payment that emptied the balance, undone, brings back the revaluations it took
    // with it), so the window runs from before it; the dollars the undoing moved beyond its own lines (what
    // a container's reversal took back, given back) stay, in its place.
    const family = (r: (typeof rows)[number]) =>
      r.type === "revaluation" && r.sourceId && r.sourceType && REVALUATION_SOURCES.includes(r.sourceType) ? -r.sourceId : (r.reverses ?? r.journalId);
    const ids = new Set(rows.map((r) => r.journalId));
    const undone = new Set(rows.filter((r) => r.reverses && r.type !== "revaluation" && ids.has(r.reverses)).map((r) => r.reverses!));
    const paired = (r: (typeof rows)[number]) => undone.has(r.journalId) || (!!r.reverses && undone.has(r.reverses) && r.type !== "revaluation");
    const pairOf = (r: (typeof rows)[number]) => (undone.has(r.journalId) ? r.journalId : r.reverses!);
    const left = new Map<number, Decimal>();
    for (const r of rows) if (paired(r)) left.set(pairOf(r), (left.get(pairOf(r)) ?? new Decimal(0)).plus(dec(r.usd)));
    const lastOf = new Map(rows.map((r, i) => [r.journalId, i]));
    const posted = rows.flatMap((r, i) => {
      if (paired(r)) {
        // Only on the undoing's last line, once: what the pair still moves.
        const last = !undone.has(r.journalId) && lastOf.get(r.journalId) === i;
        const net = last ? (left.get(pairOf(r)) ?? new Decimal(0)) : new Decimal(0);
        return net.isZero() ? [] : [{ group: r.journalId, origin: r.journalId, revaluation: false, cleared: true, takenBack: true, native: new Decimal(0), usd: net, rate: null }];
      }
      return [{ group: r.journalId, origin: family(r), revaluation: r.type === "revaluation", cleared: r.kind === "revalued" || r.kind === "settled_fx", takenBack: r.kind === "settled_fx", native: dec(r.native ?? 0), usd: dec(r.usd), rate: r.rate }];
    });
    const all = [...posted, ...own.map((v) => ({ group: 0, origin: 0, revaluation: false, cleared: v.kind === "settled_fx", takenBack: v.kind === "settled_fx", native: dec(v.nativeAmount ?? 0), usd: v.debit.minus(v.credit), rate: v.rate }))];
    const revaluedIn = (some: typeof all) => {
      const net = new Map<number, Decimal>();
      for (const r of some) if (r.revaluation) net.set(r.origin, (net.get(r.origin) ?? new Decimal(0)).plus(r.usd));
      return sum([...net.values()].map((u) => u.abs()));
    };
    const native = sum(all.map((r) => r.native));
    const usd = sum(all.map((r) => r.usd));
    if (usd.isZero()) continue;
    const rate = own.find((v) => v.rate)?.rate ?? (k.currency === "CDF" ? (await rateFor(tx, date)).rate.toFixed(4) : (await cnyRateFor(tx, date))?.toFixed(4) ?? null);
    // Francs or yuan worth under half a cent at that rate count as none, and are cleared with the dollars
    // (as costForeignOutflows does): a reversal can leave a franc or two that a refund took beyond the
    // receipt it undoes. Only in the journal being posted, and never on a drawer, whose francs are counted.
    const residue = !native.isZero();
    if (residue && (!pending.length || moneyIds.has(k.accountId) || !rate)) continue;
    // More francs or yuan left on a contact whose dollars say the other way (the shop owing 68 $ on 15 FC
    // the customer owes, the rates of the postings undone and kept far apart): their dollars are restated
    // to them at the day's rate, as the next revaluation would, within the same bound. Their dollars then
    // have their sign, so no cap pays out what they do not hold. Dollars of their sign are left to it.
    let restated: Decimal | null = null;
    let dayRate: string | null = null;
    if (residue && !native.abs().dividedBy(dec(rate)).lt("0.005")) {
      if (usd.isZero() || usd.isNegative() === native.isNegative()) continue;
      const day = k.currency === "CDF" ? (await rateFor(tx, date)).rate : await cnyRateFor(tx, date);
      if (!day || !day.gt(0)) continue;
      restated = cents(native.dividedBy(day));
      dayRate = day.toFixed(4);
    }
    let moved: Decimal;
    if (moneyIds.has(k.accountId)) {
      // A drawer: only what revaluations booked on it.
      const revalued = revaluedIn(all);
      if (usd.abs().gt(revalued)) continue;
      moved = usd;
    } else {
      // Since the last journal (before the last one) after which the balance held no francs or yuan.
      let start = 0;
      let running = new Decimal(0);
      for (let i = 0; i < all.length - 1; i++) {
        running = running.plus(all[i].native);
        if (all[i + 1].group !== all[i].group && running.isZero()) start = i + 1;
      }
      const since = all.slice(start);
      moved = sum(since.map((r) => r.usd)).minus(restated ?? 0);
      if (moved.isZero()) continue;
      // Dollars from before that window stay: the balance must still end with the sign of its francs or yuan.
      if (restated && !usd.minus(moved).isZero() && usd.minus(moved).isNegative() !== native.isNegative()) continue;
      if (since.some((r) => r.native.isZero() && !r.usd.isZero() && !r.revaluation && !r.cleared)) continue;
      const revalued = revaluedIn(since);
      const posts = since.filter((r) => !r.native.isZero() && r.rate && dec(r.rate).gt(0));
      const rates = posts.map((r) => dec(r.rate!));
      const apart = posts.length
        ? sum(posts.map((r) => r.native.abs())).dividedBy(2).times(new Decimal(1).dividedBy(Decimal.min(...rates)).minus(new Decimal(1).dividedBy(Decimal.max(...rates))))
        : new Decimal(0);
      const takenBackUsd = sum(since.filter((r) => r.takenBack).map((r) => r.usd.abs()));
      if (moved.abs().gt(revalued.plus(apart).plus(takenBackUsd).plus(new Decimal("0.005").times(posts.length)))) continue;
    }
    gain = gain.plus(moved);
    lines.push({
      accountId: k.accountId,
      debit: moved.isNegative() ? moved.abs() : new Decimal(0),
      credit: moved.isPositive() ? moved : new Decimal(0),
      partyId: k.partyId,
      currency: k.currency,
      nativeAmount: restated ? "0.00" : native.negated().toFixed(2),
      rate: dayRate ?? rate,
      memo: REVALUED_MEMO,
      kind: "revalued",
    });
  }
  if (!lines.length) return [];
  lines.push({
    accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.fx),
    debit: gain.isPositive() ? gain : new Decimal(0),
    credit: gain.isNegative() ? gain.abs() : new Decimal(0),
    partyId: null,
    currency: "USD",
    nativeAmount: null,
    rate: null,
    memo: REVALUED_MEMO,
    kind: "revalued",
  });
  return lines;
}

/**
 * A supplier's yuan as their payments and bills met them, journal by journal in the order they were
 * posted (a reversal dated back before a payment still undoes a bill that payment paid). Each payment
 * (a "lot") pays the oldest bill yuan still owed; what it pays beyond them is yuan the supplier owes us
 * (a claim). A bill, or a refund, takes claimed yuan from every lot in proportion, as the books take
 * them at their average cost. Undoing a container takes its bill away: the yuan paid against it pay the
 * next bill still owed, and only the rest become a claim. Undoing a payment takes its yuan away from the
 * bills (owed again) and from the claim. The claim and yuan owed never stand side by side: they meet
 * as soon as both exist.
 * The pool's value counts claimed yuan at what was paid for them (their lot's dollars less the exchange
 * difference its journal booked, plus what a month's revaluation left on them since: see revalue) and yuan
 * owed at what the books carry them at: the bill's own dollars, or, owed again once a payment is undone,
 * the dollars that payment took them out at.
 * A supplier's francs are replayed the same way (see foreignPool): a franc bill, its payments and its
 * reversal meet as the yuan do, so a reversal takes with the bill its share of what a month-end
 * revaluation left on the francs, and the francs paid for it come back at what was paid.
 */
class YuanPool {
  /** `reval`: what the months' revaluations left on the lot's claimed yuan (see revalue). */
  lots = new Map<number, { paid: Decimal; claim: Decimal; reval: Decimal }>();
  /**
   * Yuan owed, oldest bill first, at the dollars per yuan they are carried at. `marked`: owed at a month's
   * end (see mark), so they carry their part of that month's revaluation wherever they go.
   */
  open: { bill: number; q: Decimal; rate: Decimal; marked: boolean }[] = [];
  /** A lot's yuan matched to a bill's: when they part, the bill's yuan are owed again at `rate`. */
  portions: { lot: number; bill: number; q: Decimal; rate: Decimal; marked: boolean; carries: boolean }[] = [];
  /** Each bill and its own dollars per yuan. */
  bills = new Map<number, Decimal>();
  /** The day of each bill (see revalue). */
  billDates = new Map<number, string>();
  /** The month's revaluation (see mark) is on the yuan owed. */
  revalued = false;
  /** Whether a payment was posted while the month was closed (see foreignMarkedOwed): if given, `revalued` is not relied on. */
  postedClosed: ((journalId: number) => boolean) | null = null;
  /**
   * The last bill taken away (see removeBill): its yuan owed and paid, and from which of `portions` start
   * those its paid yuan made paying the bills still owed (see foreignPool, which restates them).
   */
  removed: { q: Decimal; from: number } | null = null;

  value(): Decimal {
    let v = new Decimal(0);
    for (const l of this.lots.values()) v = v.plus(l.claim.times(l.paid)).plus(l.reval);
    for (const s of this.open) v = v.minus(s.q.times(s.rate));
    return v;
  }

  /** Yuan held: claimed less owed, as the books' balance counts them. */
  native(): Decimal {
    let n = new Decimal(0);
    for (const l of this.lots.values()) n = n.plus(l.claim);
    for (const s of this.open) n = n.minus(s.q);
    return n;
  }

  /**
   * Yuan of `lot` pay the yuan still owed, oldest bill first; returns what is left, and in `met` the
   * dollars the yuan owed they met are carried at.
   */
  private payOpen(lot: number, q: Decimal, rate: Decimal | null, met?: { usd: Decimal }): Decimal {
    let left = q;
    for (const s of this.open) {
      if (!left.gt(0)) break;
      const t = Decimal.min(s.q, left);
      if (!t.gt(0)) continue;
      s.q = s.q.minus(t);
      left = left.minus(t);
      if (met) met.usd = met.usd.plus(t.times(s.rate));
      // Paid once the month's revaluation is on them (with the month closed: francs are replayed by date,
      // and the revaluation before a payment made before the close), the marked yuan carry their part of it
      // with them; met by a removed bill's paid yuan, they leave it with that bill (see removeBill).
      this.portions.push({ lot, bill: s.bill, q: t, rate: rate ?? s.rate, marked: s.marked, carries: s.marked && rate !== null && (this.postedClosed ? this.postedClosed(lot) : this.revalued) });
    }
    this.open = this.open.filter((s) => s.q.gt(0));
    return left;
  }

  /** Up to `q` claimed yuan meet `bill`'s, from every lot in proportion; returns the yuan left over. */
  private takeClaim(q: Decimal, bill: number, rate: Decimal, marked = false): Decimal {
    const claims = [...this.lots].filter(([, l]) => l.claim.gt(0));
    const total = sum(claims.map(([, l]) => l.claim));
    if (!total.gt(0) || !q.gt(0)) return q;
    const take = Decimal.min(q, total);
    let taken = new Decimal(0);
    claims.forEach(([id, l], i) => {
      const t = i === claims.length - 1 ? take.minus(taken) : take.times(l.claim).dividedBy(total);
      taken = taken.plus(t);
      // Taken out at the claim's average cost, as the books do: their part of the revaluation goes with them.
      l.reval = l.reval.minus(l.reval.times(t).dividedBy(l.claim));
      l.claim = l.claim.minus(t);
      this.portions.push({ lot: id, bill, q: t, rate, marked, carries: false });
    });
    return q.minus(take);
  }

  /** Claimed yuan meet yuan owed again (a payment or a refund undone left both). */
  private meet() {
    for (const s of this.open) s.q = this.takeClaim(s.q, s.bill, s.rate, s.marked);
    this.open = this.open.filter((s) => s.q.gt(0));
  }

  private reopen(bill: number, q: Decimal, rate: Decimal, marked = false) {
    if (!this.bills.has(bill) || !q.gt(0)) return;
    this.open.push({ bill, q, rate, marked });
    this.open.sort((a, b) => a.bill - b.bill);
  }

  addLot(id: number, q: Decimal, book: Decimal, gain: Decimal) {
    const lot = { paid: book.minus(gain).dividedBy(q), claim: new Decimal(0), reval: new Decimal(0) };
    this.lots.set(id, lot);
    const met = { usd: new Decimal(0) };
    lot.claim = this.payOpen(id, q, book.dividedBy(q), met);
    // The books take yuan owed out at what they carry them at on average (see bookValue), not the oldest
    // bill's: the yuan still owed carry the difference, as the books' do.
    if (!lot.claim.gt(0)) this.revalue(book.minus(met.usd));
  }

  addBill(id: number, q: Decimal, given: Decimal, date?: string) {
    const rate = given.dividedBy(q);
    this.bills.set(id, rate);
    if (date) this.billDates.set(id, date);
    const left = this.takeClaim(q, id, rate);
    if (left.gt(0)) this.reopen(id, left, rate);
  }

  /**
   * A payment undone: its yuan leave the bills (owed again) and the claim. What a revaluation left on its
   * claimed yuan goes with them: those yuan are claimed no more, so the books hold none of it (see
   * yuanTrueUpLines, which moves it to exchange differences with the undoing).
   */
  removeLot(id: number) {
    for (const p of this.portions.filter((x) => x.lot === id)) this.reopen(p.bill, p.q, p.rate, p.marked);
    this.portions = this.portions.filter((x) => x.lot !== id);
    this.lots.delete(id);
    this.meet();
  }

  /** The yuan owed now are those owed at a month's end (see yuanMarkedOwed). */
  mark() {
    for (const s of this.open) s.marked = true;
  }

  /** The yuan owed now of those owed at the month's end (see mark). */
  markedOpen(): Decimal {
    return sum(this.open.filter((s) => s.marked).map((s) => s.q));
  }

  /**
   * Of the yuan of the bills now, those owed at the month's end marked: owed still, or paid since the
   * month's revaluation was on them, so they still carry their part of it until their bill is taken away.
   */
  markedOwed(): Decimal {
    return sum([...this.open.filter((s) => s.marked), ...this.portions.filter((p) => p.carries)].map((s) => s.q));
  }

  /**
   * A month-end revaluation restates the yuan still owed (in proportion), else the yuan claimed: a claim
   * keeps what it holds, and what the revaluation leaves on it goes with the yuan as they are taken out at
   * their cost (see takeClaim), or to exchange differences with the payment that is undone (see
   * removeLot). So do the dollars the books move on them when the month is reopened or closed again (see
   * restateSettled). Those journals (`asOf`: their day) restate only the yuan of bills dated by then, when
   * any are owed: yuan are replayed in the order they were posted, and a month closed or reopened after a
   * bill dated since its end restates no part of that bill, as when it was closed first.
   */
  revalue(usd: Decimal, asOf?: string) {
    const dated = asOf ? this.open.filter((s) => (this.billDates.get(s.bill) ?? "") <= asOf) : [];
    const on = dated.length ? dated : this.open;
    const owed = sum(on.map((s) => s.q));
    if (owed.gt(0)) {
      for (const s of on) s.rate = s.rate.minus(usd.dividedBy(owed));
      return;
    }
    const claimed = sum([...this.lots.values()].map((l) => l.claim));
    if (!claimed.gt(0)) return;
    for (const l of this.lots.values()) l.reval = l.reval.plus(usd.times(l.claim).dividedBy(claimed));
  }

  /**
   * Take a bill away. Returns what its paid yuan are worth now (claimed at what was paid, or paying
   * another bill at what that one carries them at) beyond the bill's own dollars for them, which go
   * with it: a payment's yuan come back at exactly what it paid. And the dollars a revaluation (or a
   * payment undone) left on its yuan still owed beyond its own dollars, which go with them.
   */
  removeBill(id: number): Decimal {
    const own = this.bills.get(id) ?? new Decimal(0);
    let worth = sum(this.open.filter((s) => s.bill === id).map((s) => s.q.times(s.rate.minus(own))));
    const owed = sum(this.open.filter((s) => s.bill === id).map((s) => s.q));
    this.open = this.open.filter((s) => s.bill !== id);
    const freed = this.portions.filter((x) => x.bill === id).sort((a, b) => a.lot - b.lot);
    this.portions = this.portions.filter((x) => x.bill !== id);
    this.bills.delete(id);
    const from = this.portions.length;
    this.removed = { q: owed.plus(sum(freed.map((p) => p.q))), from };
    for (const p of freed) {
      const lot = this.lots.get(p.lot);
      if (!lot) continue;
      const met = { usd: new Decimal(0) };
      const left = this.payOpen(p.lot, p.q, null, met);
      lot.claim = lot.claim.plus(left);
      worth = worth.plus(met.usd).plus(left.times(lot.paid)).minus(p.q.times(own));
    }
    return worth;
  }
}

/**
 * Lines the books write that move dollars on a supplier's yuan, not the yuan they settle (see foreignPool). A
 * residue line clears yuan or francs worth under half a cent (see costForeignOutflows): skipped for yuan, as
 * ever, while for francs it moves the francs it clears, so the pool's francs stay the books' (see
 * yuanTrueUpLines, which trues francs up only when they are).
 */
const POOL_SKIPPED_KINDS = new Set<string>(["revalued", "settled_fx"]);
const poolSkipped = (l: { kind: string | null; currency?: string | null }) => !!l.kind && (POOL_SKIPPED_KINDS.has(l.kind) || (l.kind === "residue" && l.currency !== "CDF"));

/**
 * Replay a supplier's yuan (or francs: `currency`) on `payables` into a YuanPool, every journal in the
 * order it was posted. Francs in the order of their dates instead (posted in that order on a day): yuan
 * move dated no earlier than the latest that moved (see assertYuanInOrder), francs can be dated back
 * (an advance, salaries typed for an earlier day: see francsMetAfter), and a month's revaluation
 * restates the francs owed at its end, whatever was posted since, as its closing and reopening count
 * them (see restateSettled).
 * A payment's exchange difference is the one its journal booked on this supplier's own yuan lines (each
 * line keeps its own, so a voucher that also pays another supplier's yuan, or pays from a franc drawer,
 * still counts this one's). A journal posted before lines kept theirs counts the one its journal booked
 * when its only francs or yuan are this supplier's (another balance's difference in the same journal
 * cannot be told apart, so none is counted: its yuan are claimed back at their book cost).
 * A journal the books post for a month's revaluation (the revaluation, its undoing when the month is
 * reopened, what closing or reopening the month moves on the balances settled since) moves dollars on the
 * yuan and no yuan: all of it restates the yuan still owed when it is posted, as it moves the books' own
 * dollars on them, so the pool's yuan owed stay at what the books carry them at, in whatever order the
 * month is closed and reopened.
 * `markAfter` marks the yuan owed at the end of that day (see YuanPool.mark); `marks` gets, for each
 * journal, the marked yuan owed before and after it, whether it took a bill away, and for a payment or its
 * undoing the marked yuan owed it paid or brings back (see foreignMarkedOwed).
 */
async function foreignPool(
  tx: Tx,
  payables: number,
  partyId: number,
  currency: ForeignCurrency,
  opts: { markAfter?: string; marks?: Map<number, { before: Decimal; after: Decimal; removal: boolean; lot?: Decimal }>; postedClosed?: (journalId: number) => boolean } = {},
) {
  const rows = await tx
    .select({
      journalId: journalLines.journalId,
      date: journals.date,
      type: journals.type,
      reverses: journals.reversesJournalId,
      sourceType: journals.sourceType,
      sourceId: journals.sourceId,
      native: journalLines.nativeAmount,
      usd: sql<string>`${journalLines.debit} - ${journalLines.credit}`,
      rate: journalLines.rate,
      kind: journalLines.kind,
      fxUsd: journalLines.fxUsd,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)))
    .orderBy(...(currency === "CDF" ? [journals.date, journals.id, journalLines.id] : [journals.id, journalLines.id]));
  // The lines of each journal, gathered once (in the order replayed, as the rows come).
  const byJournal = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byJournal.get(r.journalId);
    if (list) list.push(r);
    else byJournal.set(r.journalId, [r]);
  }
  // The other lines only of the journals posted before lines kept their own exchange difference.
  const legacy = [...byJournal].filter(([, own]) => own.every((r) => r.fxUsd == null)).map(([id]) => id);
  const others = new Map<number, { accountId: number; partyId: number | null; currency: string; usd: string; kind: string | null }[]>();
  for (let i = 0; i < legacy.length; i += 5000) {
    const found = await tx
      .select({ journalId: journalLines.journalId, accountId: journalLines.accountId, partyId: journalLines.partyId, currency: journalLines.currency, usd: sql<string>`${journalLines.credit} - ${journalLines.debit}`, kind: journalLines.kind })
      .from(journalLines)
      .where(inArray(journalLines.journalId, legacy.slice(i, i + 5000)));
    for (const l of found) {
      const list = others.get(l.journalId);
      if (list) list.push(l);
      else others.set(l.journalId, [l]);
    }
  }
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  const pool = new YuanPool();
  pool.postedClosed = opts.postedClosed ?? null;
  const refunds = new Set<number>(); // receipts: the supplier's refunds of yuan they owed back
  const kinds = new Map<number, { kind: "lot" | "bill"; native: Decimal; usd: Decimal; rate: string }>();
  // container -> the journals that billed it, still owed. Francs are replayed by date, and a container
  // offloaded again dated before its reversal was: that reversal takes away the bill posted before it.
  const liveBill = new Map<number, number[]>();
  /** Replays one journal; true when it took a bill away. */
  const step = (id: number, lines: typeof rows): boolean => {
    if (lines[0].type === "revaluation") {
      // A month closed (or reopened, its revaluation undone), and what either moved on the balances settled
      // since: dollars, no yuan, every line of it (see above).
      if (sum(lines.map((r) => dec(r.native ?? 0))).isZero()) pool.revalue(sum(lines.map((r) => dec(r.usd))), lines[0].date);
      return false;
    }
    const own = lines.filter((r) => !poolSkipped({ kind: r.kind, currency }));
    if (!own.length) return false;
    const j = own[0];
    const native = sum(own.map((r) => dec(r.native ?? 0)));
    const usd = sum(own.map((r) => dec(r.usd)));
    // A bill taken away moves on the francs what the books booked when it was posted (its own lines and the
    // exchange difference it moved: see yuanTrueUpLines), not what the pool would make of it now. Francs
    // are replayed by date, so a month reopened or closed since restates the francs before that reversal,
    // and the pool would take away again the share of the month's revaluation the reversal already took
    // (or put back what the reopening restated after it): the pool keeps what the books booked, the francs
    // still owed taking the difference, and those the bill's paid francs pay since (owed again at what
    // they pay) theirs, so they leave with that share when they part. A payment undone needs none: its
    // francs come back at exactly what it took (see removeLot).
    const worth = currency === "CDF" && (j.type === "container_reversal" || j.reverses) ? pool.value() : null;
    const adopt = () => {
      if (worth === null) return;
      const gap = sum(lines.map((r) => dec(r.usd))).minus(pool.value().minus(worth));
      pool.revalue(gap);
      const removed = pool.removed;
      if (removed && removed.q.gt(0)) for (const p of pool.portions.slice(removed.from)) p.rate = p.rate.plus(gap.dividedBy(removed.q));
    };
    if (j.type === "container_reversal") {
      const billed = j.sourceId ? (liveBill.get(j.sourceId) ?? []) : [];
      const bill = billed.filter((b) => b < id).at(-1) ?? billed.at(-1);
      if (bill) {
        pool.removeBill(bill);
        adopt();
        billed.splice(billed.indexOf(bill), 1);
      }
      return !!bill;
    }
    if (j.reverses) {
      if (pool.lots.has(j.reverses)) pool.removeLot(j.reverses);
      else if (pool.bills.has(j.reverses)) {
        pool.removeBill(j.reverses);
        adopt();
        return true;
      }
      return false;
    }
    if (native.isZero()) return false;
    const kept = own.some((r) => r.fxUsd != null);
    const rest = others.get(id) ?? [];
    const clean = kept || !rest.some((l) => l.currency !== "USD" && !(l.accountId === payables && l.partyId === partyId && l.currency === currency));
    const gain = kept
      ? sum(own.map((r) => dec(r.fxUsd ?? 0)))
      : clean
        ? sum(rest.filter((l) => l.accountId === fx && l.kind === "cost_fx").map((l) => dec(l.usd)))
        : new Decimal(0);
    const rate = own.find((r) => r.rate && dec(r.rate).gt(0))?.rate;
    if (!rate) return false;
    if (native.gt(0)) {
      pool.addLot(id, native, usd, gain);
      kinds.set(id, { kind: "lot", native, usd, rate });
    } else {
      // What the bill or refund was worth before its yuan met a claim at the claim's cost.
      const given = clean ? usd.abs().plus(gain) : sum(own.filter((r) => r.rate && dec(r.rate).gt(0)).map((r) => dec(r.native ?? 0).abs().dividedBy(dec(r.rate!))));
      pool.addBill(id, native.abs(), given, j.date);
      kinds.set(id, { kind: "bill", native, usd, rate });
      if (j.type === "receipt" || j.type === "customer_receipt") refunds.add(id);
      if (j.type === "container_finalize" && j.sourceType === "container" && j.sourceId) liveBill.set(j.sourceId, [...(liveBill.get(j.sourceId) ?? []), id].sort((a, b) => a - b));
    }
    return false;
  };
  // No yuan move dated before the latest that moved (see assertYuanInOrder): the yuan owed at the end of a
  // day are those owed before the first journal dated after it that moves any.
  let marked = !opts.markAfter;
  for (const [id, lines] of byJournal) {
    if (!marked && lines[0].type !== "revaluation" && lines[0].date > opts.markAfter!) {
      pool.mark();
      marked = true;
    }
    const before = pool.markedOwed();
    const owedBefore = pool.markedOpen();
    const undoesLot = !!lines[0].reverses && pool.lots.has(lines[0].reverses);
    const removal = step(id, lines);
    if (opts.markAfter && lines[0].type === "revaluation" && lines[0].sourceType === "period" && !lines[0].reverses && lines[0].date === opts.markAfter) pool.revalued = true;
    // The yuan owed at the month's end a payment paid, or its undoing brings back owed to them (not those a
    // claim meets on the way, nor those that paid a bill of them taken away since).
    const lot = undoesLot ? pool.markedOpen().minus(owedBefore) : kinds.get(id)?.kind === "lot" ? owedBefore.minus(pool.markedOpen()) : undefined;
    opts.marks?.set(id, { before, after: pool.markedOwed(), removal, lot });
  }
  return { pool, kinds, refunds };
}

/**
 * A supplier's yuan owed at the end of `monthEnd` (a month's revaluation restated them, each by as much),
 * as they leave and come back, journal by journal (see YuanPool): how many of them each journal leaves
 * owed, and whether it took a bill away. A container's reversal that takes its bill away moves the share
 * of the revaluation those leaving held to exchange differences (see yuanTrueUpLines), and the share of
 * those coming back owed (a payment undone) comes back with them: so reopening that month takes back,
 * or closing it again gives back, the part of the revaluation the yuan still owed carry (see restateSettled).
 * `postedClosed` says whether a journal was posted with the month closed: paid then, marked yuan carry
 * their part; paid before the close (or with the month reopened), they leave it on those still owed.
 * `lot`, for a payment: the yuan owed at the month's end it paid; for its undoing: those it brings back
 * owed to them, fewer when a bill they paid was taken away since or a claim meets them (see restateSettled).
 */
export async function foreignMarkedOwed(tx: Tx, payables: number, partyId: number, currency: ForeignCurrency, monthEnd: string, postedClosed: (journalId: number) => boolean) {
  const marks = new Map<number, { before: Decimal; after: Decimal; removal: boolean; lot?: Decimal }>();
  await foreignPool(tx, payables, partyId, currency, { markAfter: monthEnd, marks, postedClosed });
  return marks;
}

/** A supplier's yuan (or franc) lines a journal moves (as YuanPool counts them): those its undoing trues up. */
async function foreignPartiesOf(tx: Tx, lines: (typeof journalLines.$inferSelect)[], currency: ForeignCurrency) {
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const suppliers = Array.from(
    new Set(lines.filter((l) => l.accountId === payables && l.partyId && l.currency === currency && !dec(l.nativeAmount ?? 0).isZero() && !poolSkipped(l)).map((l) => l.partyId!)),
  );
  return { payables, suppliers };
}

/**
 * Refuse undoing a payment (or an advance applied) whose yuan a container's reversal turned into yuan the
 * supplier owes back and the supplier has refunded since: undone, the payment would leave that refund as
 * yuan the shop owes them, at a rate no payment explains. The refund is undone first (or the container
 * offloaded again), then the payment. Yuan only claimed back are fine: undoing the payment gives back
 * what the reversal took back from its exchange difference (see yuanTrueUpLines).
 */
export async function assertUndoKeepsRefunds(tx: Tx, journalId: number): Promise<void> {
  const lines = await tx.select().from(journalLines).where(eq(journalLines.journalId, journalId));
  // Every contact the undoing writes to, all at once and in id order (see lockBalances): the reversal
  // takes them again, and a supplier's lock alone first would take a lower one after it.
  await lockBalances(tx, { parties: lines.map((l) => l.partyId) });
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  await assertUndoKeepsAdvanceRefunds(tx, journalId, lines, payables);
  // The same for francs: a franc bill's payment, its reversal and the refund meet in the pool as the yuan do.
  for (const currency of ["CNY", "CDF"] as const) {
    const { suppliers } = await foreignPartiesOf(tx, lines, currency);
    for (const partyId of suppliers) {
      const { pool, kinds, refunds } = await foreignPool(tx, payables, partyId, currency);
      if (kinds.get(journalId)?.kind !== "lot") continue;
      const refunded = sum(pool.portions.filter((p) => p.lot === journalId && refunds.has(p.bill)).map((p) => p.q));
      if (!refunded.gt(0)) continue;
      const [unit, what, quoi] = currency === "CNY" ? ["CNY", "yuan", "yuans"] : ["FC", "francs", "francs"];
      throw conflict(
        `The supplier has refunded ${refunded.toFixed(2)} ${unit} of this payment's ${what} since a container was undone. Undo that refund first (or offload the container again), then this payment.`,
        `Le fournisseur a remboursé ${frMoney(refunded, currency)} des ${quoi} de ce paiement depuis l'annulation d'un conteneur. Annulez d'abord ce remboursement (ou déchargez de nouveau le conteneur), puis ce paiement.`,
      );
    }
  }
}

/**
 * Refuse undoing a dollar advance to a supplier, agent or employee (dollars paid that they owe back) once
 * a receipt from them since was taken off it: a receipt settles the dollars they owe first (see
 * payablesReceiptLines), so with the advance undone the shop would owe them those dollars back, while the
 * yuan or francs the receipt settled beyond them stay settled. The receipt is undone first, then the
 * advance. Counted in the order they were posted: a receipt meets the advance only while the advance
 * still stands.
 */
async function assertUndoKeepsAdvanceRefunds(tx: Tx, journalId: number, lines: (typeof journalLines.$inferSelect)[], payables: number): Promise<void> {
  const own = new Map<number, Decimal>();
  for (const l of lines) {
    if (l.accountId !== payables || !l.partyId || l.currency !== "USD") continue;
    own.set(l.partyId, (own.get(l.partyId) ?? new Decimal(0)).plus(dec(l.debit)).minus(dec(l.credit)));
  }
  for (const [partyId, paid] of own) {
    if (!paid.gt(0)) continue;
    const rows = await tx
      .select({ journalId: journalLines.journalId, number: journals.number, type: journals.type, reversedBy: journals.reversedByJournalId, usd: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, "USD")))
      .groupBy(journalLines.journalId, journals.number, journals.type, journals.reversedByJournalId)
      .orderBy(journalLines.journalId);
    const before = sum(rows.filter((r) => r.journalId < journalId).map((r) => dec(r.usd)));
    // The part of the payment that went beyond what the shop owed them: their advance.
    if (!Decimal.max(before.plus(paid), 0).minus(Decimal.max(before, 0)).gt(0)) continue;
    let balance = before.plus(paid);
    for (const r of rows.filter((x) => x.journalId > journalId)) {
      const usd = dec(r.usd);
      // What the receipt took off the dollars they owed beyond what it would have without this advance.
      const covered = (b: Decimal) => Decimal.min(usd.abs(), Decimal.max(b, 0));
      const taken = covered(balance).minus(covered(balance.minus(paid)));
      if (r.type === "receipt" && !r.reversedBy && usd.isNegative() && taken.gt(0)) {
        throw conflict(
          `A receipt since (${r.number}) took ${taken.toFixed(2)} $ off this advance. Undo that receipt first, then this advance.`,
          `Un encaissement depuis (${r.number}) a déjà soldé ${frMoney(taken)} de cette avance. Annulez d'abord ce remboursement, puis cette avance.`,
        );
      }
      balance = balance.plus(usd);
    }
  }
}

/**
 * The lines by which undoing a supplier's yuan bill (a container's reversal: `bill` with the dollars
 * `usd` it debits) or a journal on their yuan (`undo`: a payment, an advance applied, a refund) keeps
 * their yuan at what they are worth (see YuanPool): yuan claimed back at what was paid for them, and
 * yuan owed at what the books carry them at. A container undone after its yuan were paid at a discount
 * (or at another rate) takes that exchange difference back from gains or losses, so refunding exactly
 * what was paid closes the claim; a payment undone after such a takeback gives its share back, so it
 * is not booked off twice; claimed yuan that meet yuan owed again (a payment undone while another
 * container's yuan are claimed) book their difference as the payment that settled them did. A month's
 * revaluation on the yuan still owed goes with the bill that leaves, in the share of its yuan (so the
 * yuan still owed keep theirs); on yuan claimed, it goes with the payment undone (the yuan are claimed no
 * more). The same for a supplier's francs (`currency` "CDF": a franc bill, its payments, its reversal).
 * The lines move no yuan and no money, only dollars between the supplier's yuan and exchange
 * differences. Never when the yuan left would carry dollars of the other sign. The caller holds the
 * supplier's lock.
 */
export async function yuanTrueUpLines(
  tx: Tx,
  input: { payables: number; partyId: number; currency?: ForeignCurrency } & ({ bill: number; native: Decimal; usd: Decimal; rate: DecimalInput } | { undo: number }),
): Promise<PostLine[]> {
  const { payables, partyId } = input;
  const currency = input.currency ?? "CNY";
  const { pool, kinds } = await foreignPool(tx, payables, partyId, currency);
  let extra: Decimal;
  let move: Decimal;
  let moved: Decimal;
  let rate: string;
  const bal = await foreignBalance(tx, payables, partyId, currency);
  if ("bill" in input) {
    // The bill's own dollars leave with it: only its paid yuan's worth moves.
    if (!pool.bills.has(input.bill)) return [];
    extra = cents(pool.removeBill(input.bill));
    move = cents(input.usd);
    moved = input.native;
    rate = dec(input.rate).toFixed(4);
  } else {
    // The journal's own lines leave exactly as they came: the pool's worth moves by the rest.
    const undone = kinds.get(input.undo);
    if (!undone) return [];
    const before = pool.value();
    if (undone.kind === "lot") pool.removeLot(input.undo);
    else pool.removeBill(input.undo);
    move = undone.usd.negated();
    moved = undone.native.negated();
    rate = undone.rate;
    if (currency === "CDF") {
      // What its francs settled of a bill dated after them leaves with it too (see reverseJournal): the
      // bill is then owed as booked, as the pool reopens it.
      const [met] = await tx
        .select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .where(
          and(
            eq(journals.sourceType, FRANCS_MET_SOURCE),
            eq(journals.sourceId, input.undo),
            isNull(journals.reversedByJournalId),
            isNull(journals.reversesJournalId),
            eq(journalLines.accountId, payables),
            eq(journalLines.partyId, partyId),
            eq(journalLines.currency, currency),
          ),
        );
      move = move.minus(dec(met.usd));
    }
    extra = cents(pool.value().minus(before).minus(move));
  }
  // The cents the books' average costs rounded off on the way go too, so refunding exactly what was
  // paid closes the claim. Yuan: only cents, as more is not rounding, and stays. Francs: whenever the
  // pool's francs are the books', the books are brought to exactly the pool's worth, however far its
  // dollars are from theirs (a part paid in dollars and a month's revaluation leave more than cents
  // between them, as yuan's are not). Francs can be posted dated back (see francsMetAfter) and a residue
  // of them cleared (see costForeignOutflows), so the pool's francs must be the books' for its worth to
  // be theirs.
  const native = bal.native.plus(moved);
  const exact = cents(pool.value()).minus(bal.usd).minus(move);
  if (currency === "CNY" ? exact.minus(extra).abs().lte("0.05") : pool.native().equals(native)) extra = exact;
  // Francs the pool does not hold as the books do (a residue cleared, francs met dated back: see
  // francsMetAfter) are not the pool's: what it would move is left to the balance's emptying or the month's
  // end (see revaluedDollarLines). Logged: the pool's francs are meant to be the books' (see
  // POOL_SKIPPED_KINDS), and a share of a month's revaluation left unbooked here is found by the fuzzers.
  else if (currency === "CDF") {
    log("Franc true-up skipped: the pool and the books disagree", { partyId, undo: "undo" in input ? input.undo : null, bill: "bill" in input ? input.bill : null, exact: exact.toFixed(2), extra: extra.toFixed(2), poolNative: pool.native().toFixed(2), native: native.toFixed(2) });
    return [];
  }
  if (extra.isZero()) return [];
  const usd = bal.usd.plus(move).plus(extra);
  if ((native.gt(0) && !usd.gt(0)) || (native.lt(0) && !usd.lt(0))) return [];
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  return [
    { accountId: payables, partyId, debit: extra.isPositive() ? extra : 0, credit: extra.isNegative() ? extra.abs() : 0, currency, nativeAmount: "0.00", rate, memo: SETTLED_FX_MEMO, kind: "settled_fx" },
    { accountId: fx, debit: extra.isNegative() ? extra.abs() : 0, credit: extra.isPositive() ? extra : 0, memo: SETTLED_FX_MEMO, kind: "settled_fx" },
  ];
}

/** Post the exact opposite of a journal, dated `date`, and link the two. */
export async function reverseJournal(
  tx: Tx,
  journalId: number,
  opts: { date: string; type?: JournalType; memo?: string; userId?: number | null; skipPeriodCheck?: boolean },
): Promise<number> {
  const [original] = await tx.select().from(journals).where(eq(journals.id, journalId)).for("update");
  if (!original) throw badRequest("Journal not found", "Écriture introuvable");
  if (original.reversedByJournalId) throw badRequest(`Journal ${original.number} is already reversed`, `L'écriture ${original.number} est déjà contre-passée`);
  if (opts.date < original.date) {
    throw badRequest(
      `The cancellation date cannot be before ${original.number} (${original.date})`,
      `La date d'annulation ne peut pas être antérieure à ${original.number} (${frDate(original.date)})`,
    );
  }
  const lines = await tx.select().from(journalLines).where(eq(journalLines.journalId, journalId));
  // A supplier's yuan (or francs) it paid or billed: what a container's reversal took back since is given
  // back with them, and a franc bill undone (a container's reversal does its own: see reverseContainer)
  // takes its share of the revaluations with it (see yuanTrueUpLines). A period close's own reversals
  // move no yuan.
  const trueUp: PostLine[] = [];
  if (!opts.skipPeriodCheck) {
    // Every contact it writes to, in id order, before the suppliers' yuan are read (see lockBalances).
    await lockBalances(tx, { parties: lines.map((l) => l.partyId) });
    for (const currency of ["CNY", "CDF"] as const) {
      const { payables, suppliers } = await foreignPartiesOf(tx, lines, currency);
      // Not an employee's francs: salaries are paid in parts, in dollars and in francs, often dated back, so
      // the books carry them at other than their average cost (see contactLines) and the pool's worth is
      // not theirs; a cancelled run or an advance undone leaves what the rate left to the balance's
      // emptying (see revaluedDollarLines, clearFrancResidue).
      const employees = currency === "CDF" && suppliers.length ? new Set((await tx.select({ id: parties.id }).from(parties).where(and(inArray(parties.id, suppliers), eq(parties.type, "employee")))).map((p) => p.id)) : new Set<number>();
      for (const partyId of suppliers) if (!employees.has(partyId)) trueUp.push(...(await yuanTrueUpLines(tx, { payables, partyId, currency, undo: journalId })));
    }
  }

  // What its francs settled of a franc bill dated after them goes with them (see francsMetAfter), undone
  // after it: the reversal clears the dollars left on a balance it empties (see revaluedDollarLines) only
  // once the last of them is posted, not on the way, with what they move still to come.
  const met = opts.skipPeriodCheck
    ? []
    : await tx
        .select({ id: journals.id, date: journals.date })
        .from(journals)
        .where(and(eq(journals.sourceType, FRANCS_MET_SOURCE), eq(journals.sourceId, original.id), isNull(journals.reversedByJournalId), isNull(journals.reversesJournalId)));
  const reversalId = await postJournal(tx, {
    date: opts.date,
    type: opts.type ?? "reversal",
    memo: opts.memo ?? `Contre-passation de ${original.number}`,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    reversesJournalId: original.id,
    userId: opts.userId,
    skipPeriodCheck: opts.skipPeriodCheck,
    exactValues: true,
    clearRevalued: !met.length,
    lines: lines.map((l): PostLine => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      nativeAmount: l.nativeAmount ? dec(l.nativeAmount).abs() : null,
      rate: l.rate,
      currency: l.currency === "USD" ? null : (l.currency as ForeignCurrency),
      memo: l.memo,
      kind: l.kind,
      fxUsd: l.fxUsd != null ? dec(l.fxUsd).negated() : null,
    })).concat(trueUp),
  });
  if (!reversalId) throw new AppError(500, "Nothing to reverse", "LEDGER", "Rien à contre-passer");
  await tx.update(journals).set({ reversedByJournalId: reversalId }).where(eq(journals.id, original.id));
  for (const m of met) await reverseJournal(tx, m.id, { date: opts.date < m.date ? m.date : opts.date, userId: opts.userId });
  return reversalId;
}

/** Source of the journal by which francs paid dated before a franc bill already booked settle it (see francsMetAfter). */
export const FRANCS_MET_SOURCE = "francs_met";

/** CDF per 1 USD for a date: that day's rate, else the latest before it, else the default setting. */
export async function rateFor(tx: Tx, date: string): Promise<{ rate: Decimal; source: string }> {
  const [row] = await tx.select().from(exchangeRates).where(lte(exchangeRates.date, date)).orderBy(desc(exchangeRates.date)).limit(1);
  if (row) return { rate: dec(row.cdfPerUsd), source: row.date };
  const [setting] = await tx.select().from(settings).where(eq(settings.key, "defaultCdfRate"));
  return { rate: dec((setting?.value as string | undefined) ?? "2800"), source: "default" };
}

/** CNY per 1 USD on file for a date (that day's, else the latest before it), or null when none was entered. */
export async function cnyRateFor(tx: Tx, date: string): Promise<Decimal | null> {
  const [row] = await tx
    .select({ rate: exchangeRates.cnyPerUsd })
    .from(exchangeRates)
    .where(and(lte(exchangeRates.date, date), sql`${exchangeRates.cnyPerUsd} is not null`))
    .orderBy(desc(exchangeRates.date))
    .limit(1);
  return row?.rate ? dec(row.rate) : null;
}

/** Set the rate of a day. A closed month's balances were valued at its rates, so they cannot change after. */
export async function setExchangeRate(
  tx: Tx,
  input: { date: string; cdfPerUsd: string; cnyPerUsd?: string | null },
  userId: number,
  opts: { owner: boolean } = { owner: true },
) {
  await assertPeriodOpen(tx, input.date);
  assertNotFuture(input.date);
  if (!opts.owner && input.date < shopToday()) {
    // A past day's rate values entries already made; rewriting back days one by one would also
    // walk today's rate anywhere, so only the owner changes them.
    throw new AppError(403, "Only the owner can change a past day's rate", "FORBIDDEN", "Seul le propriétaire peut modifier le taux d'un jour passé");
  }
  if (!opts.owner) {
    // Every franc check compares with the day's rate, so only the owner may move it far in one step.
    const limit = Decimal.max(await rateTolerancePct(tx), 5);
    // Compare with the last rate before today (for today and tomorrow alike), so neither overwriting
    // a day in small steps nor stacking tomorrow on today can walk it far. Keeping a day's rate as
    // it is needs no check.
    const today = shopToday();
    const [existing] = await tx.select().from(exchangeRates).where(eq(exchangeRates.date, input.date));
    const [prevRow] = await tx.select().from(exchangeRates).where(lt(exchangeRates.date, today)).orderBy(desc(exchangeRates.date)).limit(1);
    // A rate the owner set today (or for this day) is also a fair starting point.
    const ownerRows = (
      await tx
        .select({ cdf: exchangeRates.cdfPerUsd })
        .from(exchangeRates)
        .innerJoin(users, eq(users.id, exchangeRates.createdBy))
        .where(and(inArray(exchangeRates.date, [today, input.date]), eq(users.role, "owner")))
    );
    // The owner's yuan rate of the day is kept apart, so a manager's save of the row does not take it away.
    const ownerCnyRows = await tx
      .select({ cny: exchangeRates.ownerCnyPerUsd })
      .from(exchangeRates)
      .where(and(inArray(exchangeRates.date, [today, input.date]), sql`${exchangeRates.ownerCnyPerUsd} is not null`));
    // No rate before today: the default rate (Postgres has no year 0, so "0000-01-01" failed the save).
    const prevs = [prevRow ? dec(prevRow.cdfPerUsd) : (await rateFor(tx, "0001-01-01")).rate, ...ownerRows.map((r) => dec(r.cdf))];
    const next = dec(input.cdfPerUsd);
    const near = (ref: Decimal, value: Decimal) => value.minus(ref).abs().dividedBy(ref).times(100).lte(limit);
    const prev = prevs.reduce((best, r) => (r.minus(next).abs().lt(best.minus(next).abs()) ? r : best));
    const unchanged = (stored: string | null | undefined, given: string) => stored != null && dec(stored).equals(dec(given));
    if (!unchanged(existing?.cdfPerUsd, input.cdfPerUsd) && !near(prev, next) && next.minus(prev).abs().dividedBy(prev).times(100).gt(limit)) {
      throw new AppError(
        403,
        `${next.toString()} is more than ${limit.toString()}% away from the last rate (${prev.toString()}). Only the owner can make that change.`,
        "FORBIDDEN",
        `${frNumber(next.toString())}\u00a0FC pour 1\u00a0$ s'écarte de plus de ${frNumber(limit.toString())}\u00a0% du dernier taux (${frNumber(prev.toString())}\u00a0FC). Seul le propriétaire peut faire ce changement.`,
      );
    }
    // A day that has its rate already is also held to it: 2 950 is 4,9 % from yesterday's 2 812 but
    // 5,06 % from today's 2 808, and a day's rate moves only that far in one step.
    if (existing && !unchanged(existing.cdfPerUsd, input.cdfPerUsd) && !near(dec(existing.cdfPerUsd), next)) {
      const own = dec(existing.cdfPerUsd);
      throw new AppError(
        403,
        `${next.toString()} is more than ${limit.toString()}% away from the rate already set for ${input.date} (${own.toString()}). Only the owner can make that change.`,
        "FORBIDDEN",
        `${frNumber(next.toString())}\u00a0FC pour 1\u00a0$ s'écarte de plus de ${frNumber(limit.toString())}\u00a0% du taux déjà saisi pour ce jour (${frNumber(own.toString())}\u00a0FC). Seul le propriétaire peut faire ce changement.`,
      );
    }
    if (input.cnyPerUsd && !unchanged(existing?.cnyPerUsd, input.cnyPerUsd)) {
      const [cnyRow] = await tx
        .select({ rate: exchangeRates.cnyPerUsd })
        .from(exchangeRates)
        .where(and(lt(exchangeRates.date, today), sql`${exchangeRates.cnyPerUsd} is not null`))
        .orderBy(desc(exchangeRates.date))
        .limit(1);
      const cnyRefs = [...(cnyRow?.rate ? [dec(cnyRow.rate)] : []), ...ownerCnyRows.map((r) => dec(r.cny!))];
      if (!cnyRefs.length) {
        throw new AppError(403, "Only the owner can set the first yuan rate", "FORBIDDEN", "Seul le propriétaire peut saisir le premier taux du yuan");
      }
      const nextCny = dec(input.cnyPerUsd);
      if (!cnyRefs.some((r) => near(r, nextCny))) {
        const ref = cnyRefs.reduce((best, r) => (r.minus(nextCny).abs().lt(best.minus(nextCny).abs()) ? r : best));
        throw new AppError(
          403,
          `${nextCny.toString()} CNY is more than ${limit.toString()}% away from the last yuan rate (${ref.toString()}). Only the owner can make that change.`,
          "FORBIDDEN",
          `${frNumber(nextCny.toString())}\u00a0¥ pour 1\u00a0$ s'écarte de plus de ${frNumber(limit.toString())}\u00a0% du dernier taux du yuan (${frNumber(ref.toString())}\u00a0¥). Seul le propriétaire peut faire ce changement.`,
        );
      }
    }
  }
  // Saving a day's rates as they are changes nothing, and keeps who set them: an owner's rate stays
  // the owner's, so a manager re-saving it does not take away the owner's reference.
  const [current] = await tx.select().from(exchangeRates).where(eq(exchangeRates.date, input.date));
  if (current && dec(current.cdfPerUsd).equals(dec(input.cdfPerUsd)) && (!input.cnyPerUsd || (current.cnyPerUsd != null && dec(current.cnyPerUsd).equals(dec(input.cnyPerUsd))))) {
    return current;
  }
  // The owner's yuan rate is also kept apart, as the reference for a manager's later change.
  const cny = input.cnyPerUsd ? { cnyPerUsd: input.cnyPerUsd, ...(opts.owner ? { ownerCnyPerUsd: input.cnyPerUsd } : {}) } : {};
  const [row] = await tx
    .insert(exchangeRates)
    .values({ date: input.date, cdfPerUsd: input.cdfPerUsd, createdBy: userId, ...cny })
    .onConflictDoUpdate({ target: exchangeRates.date, set: { cdfPerUsd: input.cdfPerUsd, createdBy: userId, ...cny } })
    .returning();
  return row;
}

/** How far a typed rate may be from the day's rate, in percent. */
export async function rateTolerancePct(tx: Tx): Promise<Decimal> {
  const [setting] = await tx.select().from(settings).where(eq(settings.key, "rateTolerancePct"));
  return dec((setting?.value as string | undefined) ?? "3");
}

/**
 * The rate to use for a franc amount on `date`: the day's rate when none is given, or the given one
 * when it is within the tolerance of the day's rate.
 */
export async function resolveRate(tx: Tx, date: string, given?: DecimalInput | null): Promise<string> {
  const day = await rateFor(tx, date);
  if (given === undefined || given === null || given === "") return day.rate.toFixed(4);
  const r = dec(given, "exchange rate");
  if (r.lte(0)) throw badRequest("The exchange rate must be greater than zero", "Le taux de change doit être supérieur à zéro");
  const tolerance = await rateTolerancePct(tx);
  const gap = r.minus(day.rate).abs().dividedBy(day.rate).times(100);
  if (gap.gt(tolerance)) {
    throw badRequest(
      `The rate ${r.toString()} is more than ${tolerance.toString()}% away from the rate of the day (${day.rate.toString()}). Change the day's rate first if it moved.`,
      `Le taux ${frNumber(r.toString())}\u00a0FC pour 1\u00a0$ s'écarte de plus de ${frNumber(tolerance.toString())} % du taux du jour (${frNumber(day.rate.toString())}\u00a0FC). Modifiez d'abord le taux du jour s'il a changé.`,
    );
  }
  return r.toFixed(4);
}

export interface MoneyLeg {
  accountId: number;
  /** Amount in the account's currency. */
  amount: DecimalInput;
  /** CDF per USD; the day's rate when left out. */
  rate?: DecimalInput | null;
  /** Date of the posting, for the day's rate. */
  date: string;
}

/** Resolve a money account and give its USD amount plus the native fields for the journal line. */
export async function moneyLeg(
  tx: Tx,
  leg: MoneyLeg,
): Promise<{ accountId: number; currency: Currency; usd: string; nativeAmount: string | null; rate: string | null }> {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, leg.accountId));
  if (!account || !account.isMoney) throw badRequest("Choose a cash, bank or mobile money account", "Choisissez un compte caisse, banque ou mobile money");
  if (!account.active) throw badRequest(`${account.name} is inactive`, `Le compte ${account.name} est inactif`);
  const amount = cents(leg.amount);
  if (amount.lte(0)) throw badRequest("Amounts must be greater than zero", "Les montants doivent être supérieurs à zéro");
  // Francs change hands in whole notes: "12 500,50 FC" is a typing slip, not an amount.
  if (account.currency === "CDF" && !amount.isInteger()) throw francDecimalsError(amount);
  const rate = account.currency === "CDF" ? await resolveRate(tx, leg.date, leg.rate) : null;
  const usd = toUsd(account.currency, amount, rate);
  return {
    accountId: account.id,
    currency: account.currency,
    usd,
    nativeAmount: account.currency === "CDF" ? amount.toFixed(2) : null,
    rate,
  };
}

/**
 * Lines for the contact side of a payment or receipt. Francs paid to (or received from) a contact
 * who has a balance in francs settle that balance first, in francs; the rest goes to their USD
 * balance. The franc part is then valued at that balance's own cost when posted.
 */
export async function contactLines(
  tx: Tx,
  input: {
    accountId: number;
    /** Null for a balance sheet account with no contact (withholdings, deposits). */
    partyId: number | null;
    side: "debit" | "credit";
    usd: DecimalInput;
    money: { currency: string; nativeAmount: string | null; rate: string | null };
    date: string;
    memo?: string | null;
  },
): Promise<PostLine[]> {
  const usd = cents(input.usd);
  // The balances read below decide the split, so they are locked first (see lockBalances).
  await lockBalances(tx, input.partyId ? { parties: [input.partyId] } : { accounts: [input.accountId] });
  const base = { accountId: input.accountId, partyId: input.partyId, memo: input.memo ?? null };
  const plain = [{ ...base, [input.side]: usd }];
  if (usd.isZero()) return plain;
  // Balances as of the payment's date, so an entry typed later for an earlier day sees the past.
  const owed = (b: { native: Decimal; usd: Decimal }, field: "native" | "usd") =>
    // A payment (debit) settles what we owe them (negative); a receipt settles what they owe us.
    input.side === "debit" ? Decimal.max(b[field].negated(), 0) : Decimal.max(b[field], 0);
  const fc = owed(await foreignBalance(tx, input.accountId, input.partyId, "CDF", input.date), "native");
  const paidInFrancs = input.money.currency === "CDF" && !!input.money.nativeAmount;
  if (fc.isZero() && !paidInFrancs) return plain;
  const dollarsOwed = owed(await foreignBalance(tx, input.accountId, input.partyId, "USD", input.date), "usd");
  const lines: PostLine[] = [];
  const fcLine = (u: Decimal, n: Decimal, rate: string) => {
    if (u.gt(0) && n.gt(0)) lines.push({ ...base, [input.side]: u, currency: "CDF", nativeAmount: n, rate });
  };
  if (paidInFrancs) {
    // Francs settle the franc balance first, then the dollar balance; anything beyond (an advance)
    // stays in francs, so an advance in francs is later settled by a salary in francs.
    const rate = input.money.rate!;
    let nativeLeft = cents(input.money.nativeAmount!);
    let usdLeft = usd;
    const first = Decimal.min(nativeLeft, fc);
    const firstUsd = first.equals(nativeLeft) ? usdLeft : cents(usdLeft.times(first).dividedBy(nativeLeft));
    if (first.gt(0) && firstUsd.gt(0)) {
      fcLine(firstUsd, first, rate);
      nativeLeft = nativeLeft.minus(first);
      usdLeft = usdLeft.minus(firstUsd);
    }
    const toDollars = Decimal.min(usdLeft, dollarsOwed);
    if (toDollars.gt(0)) {
      lines.push({ ...base, [input.side]: toDollars });
      nativeLeft = toDollars.equals(usdLeft) ? new Decimal(0) : nativeLeft.minus(cents(nativeLeft.times(toDollars).dividedBy(usdLeft)));
      usdLeft = usdLeft.minus(toDollars);
    }
    if (usdLeft.gt(0)) {
      if (nativeLeft.gt(0)) fcLine(usdLeft, nativeLeft, rate);
      else lines.push({ ...base, [input.side]: usdLeft });
    }
    return lines.length ? lines : plain;
  }
  // Dollars settle the dollar balance first; only what is left goes to the francs, at the day's rate.
  const nativeUsd = Decimal.max(usd.minus(dollarsOwed), 0);
  if (nativeUsd.isZero()) return plain;
  const rate = await resolveRate(tx, input.date);
  // The dollars shown for all the francs owed settle all of them: rounding them down to whole francs would
  // leave a few that are worth less than a cent, which could then never be paid or refunded. Francs worth
  // under half a cent show as 0 $: the dollars all go to the dollar balance, and the journal clears those
  // francs with no money (see costForeignOutflows).
  const allUsd = cents(fc.dividedBy(rate));
  let portion = fc;
  let portionUsd = allUsd;
  if (fc.isZero() || nativeUsd.lt(allUsd)) {
    // Part of them: whole francs (down, so the dollars never settle more than they buy), and the dollars
    // they are worth: a part of a franc left owed could never be paid off.
    portion = Decimal.min(nativeUsd.times(rate).toDecimalPlaces(0, Decimal.ROUND_FLOOR), fc);
    // Unless the francs still owed today beyond them (a bill since reversed leaves fewer owed than on
    // the payment's day) are worth under half a cent: they could never be paid either, so they go too.
    const now = input.date < shopToday() ? owed(await foreignBalance(tx, input.accountId, input.partyId, "CDF"), "native") : fc;
    const left = now.minus(portion);
    if (left.gt(0) && left.dividedBy(rate).lt("0.005")) portion = Decimal.min(now, fc);
    portionUsd = Decimal.min(cents(portion.dividedBy(rate)), nativeUsd);
  }
  if (portionUsd.isZero() || portion.isZero()) return plain;
  fcLine(portionUsd, portion, rate);
  if (usd.gt(portionUsd)) lines.push({ ...base, [input.side]: usd.minus(portionUsd) });
  return lines;
}

/** A contact's balances in francs and yuan (only the non-zero ones). */
export async function contactForeignBalances(tx: Tx, partyId?: number) {
  const rows = await tx
    .select({
      partyId: journalLines.partyId,
      currency: journalLines.currency,
      native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`,
      usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .where(and(sql`${journalLines.partyId} is not null`, sql`${journalLines.currency} <> 'USD'`, partyId ? eq(journalLines.partyId, partyId) : sql`true`))
    .groupBy(journalLines.partyId, journalLines.currency);
  return rows
    .filter((r) => !dec(r.native).isZero() || !dec(r.usd).isZero())
    .map((r) => ({ partyId: r.partyId!, currency: r.currency as ForeignCurrency, native: dec(r.native).toFixed(2), usd: dec(r.usd).toFixed(2) }));
}

export async function accountByIds(tx: Tx, ids: number[]) {
  if (ids.length === 0) return [];
  return tx.select().from(accounts).where(and(inArray(accounts.id, ids)));
}
