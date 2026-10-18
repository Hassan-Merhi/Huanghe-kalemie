import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { deMonth, frDate, frMoney, frNumber } from "@shared/french";
import {
  accounts,
  auditLog,
  counters,
  exchangeRates,
  journalLines,
  journals,
  periods,
  settings,
  users,
  type Currency,
  type LineCurrency,
  type JournalType,
} from "@shared/schema";
import { cents, dec, sum, Decimal, type DecimalInput } from "@shared/money";
import type { Tx } from "../db";
import { AppError, badRequest, francDecimalsError } from "../errors";

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
      `Le mois ${deMonth(closed)} est clôturé : rien de daté ${deMonth(month)} ou avant ne peut changer. Rouvrez d'abord les mois clôturés.`,
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

  const values = lines.map((l) => {
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
    };
  });

  // Every contact the journal writes to, before its francs and yuan (see lockBalances). A period close
  // holds the periods lock alone, so nothing else is posting.
  if (!input.skipPeriodCheck) await lockBalances(tx, { parties: values.map((v) => v.partyId) });
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
    values.map((v) => ({ ...v, debit: v.debit.toFixed(2), credit: v.credit.toFixed(2), journalId: journal.id })),
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
  return journal.id;
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

/** Memo of the exchange difference booked when foreign units leave a balance at its average cost. */
export const COST_FX_MEMO = "Écart de change (coût moyen des devises)";

/** Memo of the line that clears francs or yuan worth under half a cent left on a contact (see costForeignOutflows). */
export const RESIDUE_MEMO = "Reste de moins d'un demi-centime soldé en écart de change";

type PendingLine = { accountId: number; debit: Decimal; credit: Decimal; partyId: number | null; currency: LineCurrency; nativeAmount: string | null; rate: string | null; memo: string | null };
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
    values.push({
      accountId: k.accountId,
      debit: bal.usd.isNegative() ? bal.usd.abs() : new Decimal(0),
      credit: bal.usd.isPositive() ? bal.usd : new Decimal(0),
      partyId: k.partyId,
      currency: k.currency,
      nativeAmount: bal.native.negated().toFixed(2),
      rate: rate.toFixed(4),
      memo: RESIDUE_MEMO,
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
    });
  }
}

/** Memo of the lines that move to exchange differences the dollars left on a balance a reversal emptied (see revaluedDollarLines). */
export const REVALUED_MEMO = "Écart de change à l'annulation";

type RevaluedKey = { accountId: number; partyId: number | null; currency: ForeignCurrency };

/**
 * A reversal gives francs or yuan back at the dollars they were booked at. When a month-end revaluation
 * restated them in between, or the rate moved between the postings it undoes and those it leaves, a
 * balance can be left with no francs or yuan but some dollars. These lines move them to exchange
 * differences, as the next revaluation would have done. Only for balances of `keys` with exactly no francs
 * or yuan once `pending` (the lines of the journal being posted, if any) is added, and nothing dated after
 * `date`; and only the dollars exchange explains, counted since the balance last stood at no francs or
 * yuan (dollars left from before are not this posting's):
 * - those revaluations booked on it;
 * - on a contact (or another account that is not money), what its own francs or yuan can be worth apart at
 *   the rates they were posted at: half of them at the lowest rate against half at the highest, plus half a
 *   cent per line for its rounding.
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
        native: journalLines.nativeAmount,
        usd: sql<string>`${journalLines.debit} - ${journalLines.credit}`,
        rate: journalLines.rate,
        memo: journalLines.memo,
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
      .orderBy(journals.date, journals.id, journalLines.id);
    if (rows.some((r) => r.date > date)) continue;
    const own = pending.filter((v) => keyOf(v) === keyOf(k));
    // Every line, by journal in date order, the journal being posted last.
    const posted = rows.map((r) => ({ group: r.journalId, revaluation: r.type === "revaluation", cleared: r.memo === REVALUED_MEMO, native: dec(r.native ?? 0), usd: dec(r.usd), rate: r.rate }));
    const all = [...posted, ...own.map((v) => ({ group: 0, revaluation: false, cleared: false, native: dec(v.nativeAmount ?? 0), usd: v.debit.minus(v.credit), rate: v.rate }))];
    const native = sum(all.map((r) => r.native));
    const usd = sum(all.map((r) => r.usd));
    if (!native.isZero() || usd.isZero()) continue;
    let moved: Decimal;
    if (moneyIds.has(k.accountId)) {
      // A drawer: only what revaluations booked on it.
      const revalued = sum(all.filter((r) => r.revaluation).map((r) => r.usd.abs()));
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
      moved = sum(since.map((r) => r.usd));
      if (moved.isZero()) continue;
      if (since.some((r) => r.native.isZero() && !r.usd.isZero() && !r.revaluation && !r.cleared)) continue;
      const revalued = sum(since.filter((r) => r.revaluation).map((r) => r.usd.abs()));
      const posts = since.filter((r) => !r.native.isZero() && r.rate && dec(r.rate).gt(0));
      const rates = posts.map((r) => dec(r.rate!));
      const apart = posts.length
        ? sum(posts.map((r) => r.native.abs())).dividedBy(2).times(new Decimal(1).dividedBy(Decimal.min(...rates)).minus(new Decimal(1).dividedBy(Decimal.max(...rates))))
        : new Decimal(0);
      if (moved.abs().gt(revalued.plus(apart).plus(new Decimal("0.005").times(posts.length)))) continue;
    }
    const rate = own.find((v) => v.rate)?.rate ?? (k.currency === "CDF" ? (await rateFor(tx, date)).rate.toFixed(4) : (await cnyRateFor(tx, date))?.toFixed(4) ?? null);
    gain = gain.plus(moved);
    lines.push({
      accountId: k.accountId,
      debit: moved.isNegative() ? moved.abs() : new Decimal(0),
      credit: moved.isPositive() ? moved : new Decimal(0),
      partyId: k.partyId,
      currency: k.currency,
      nativeAmount: "0.00",
      rate,
      memo: REVALUED_MEMO,
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
  });
  return lines;
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
    clearRevalued: true,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      nativeAmount: l.nativeAmount ? dec(l.nativeAmount).abs() : null,
      rate: l.rate,
      currency: l.currency === "USD" ? null : (l.currency as ForeignCurrency),
      memo: l.memo,
    })),
  });
  if (!reversalId) throw new AppError(500, "Nothing to reverse", "LEDGER", "Rien à contre-passer");
  await tx.update(journals).set({ reversedByJournalId: reversalId }).where(eq(journals.id, original.id));
  return reversalId;
}

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
        `${frNumber(next.toString())}\u00a0FC pour 1\u00a0$ s'écarte de plus de ${frNumber(limit.toString())} % du dernier taux (${frNumber(prev.toString())}\u00a0FC). Seul le propriétaire peut faire ce changement.`,
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
          `${frNumber(nextCny.toString())}\u00a0¥ pour 1\u00a0$ s'écarte de plus de ${frNumber(limit.toString())} % du dernier taux du yuan (${frNumber(ref.toString())}\u00a0¥). Seul le propriétaire peut faire ce changement.`,
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
