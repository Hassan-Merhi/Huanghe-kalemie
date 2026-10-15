import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
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

export async function nextNumber(tx: Tx, key: string, prefix: string, width = 6): Promise<string> {
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
 * Refuse a posting dated in a closed month, or before the last closed month: months close in
 * order, so a posting into an earlier open month would still change balances already closed.
 */
export async function assertPeriodOpen(tx: Tx, date: string): Promise<void> {
  const month = monthOf(date);
  const [row] = await tx
    .select({ month: periods.month })
    .from(periods)
    .where(and(eq(periods.status, "closed"), sql`${periods.month} >= ${month}`))
    .orderBy(sql`${periods.month} desc`)
    .limit(1);
  if (row) {
    const closed = row.month;
    if (closed === month) {
      throw new AppError(409, `${month} is closed. Reopen it before changing anything dated in that month.`, "PERIOD_CLOSED", `Le mois ${month} est clôturé. Rouvrez-le avant de modifier quoi que ce soit daté de ce mois.`);
    }
    throw new AppError(
      409,
      `${closed} is closed, so nothing dated in ${month} or earlier can change. Reopen the closed months first.`,
      "PERIOD_CLOSED",
      `Le mois ${closed} est clôturé : rien de daté de ${month} ou avant ne peut changer. Rouvrez d'abord les mois clôturés.`,
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
      `Écriture déséquilibrée : débits ${totalDebit.toFixed(2)} contre crédits ${totalCredit.toFixed(2)}`,
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

  if (!input.exactValues) await costForeignOutflows(tx, values, input.date);

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
      `Solde insuffisant sur ${account.name} : il manquerait ${short} ${cur} au ${row.date}.`,
    );
  }
}

type PendingLine = { accountId: number; debit: Decimal; credit: Decimal; partyId: number | null; currency: LineCurrency; nativeAmount: string | null; rate: string | null; memo: string | null };

/**
 * Value each foreign-currency line that takes units out of a balance at that balance's average
 * USD cost, and book the difference from the given value as an exchange gain or loss.
 */
async function costForeignOutflows(tx: Tx, values: PendingLine[], date: string) {
  const running = new Map<string, { native: Decimal; usd: Decimal }>();
  let fxDebit = new Decimal(0);
  for (const v of values) {
    if (v.currency === "USD" || !v.nativeAmount) continue;
    const key = `${v.accountId}|${v.partyId ?? ""}|${v.currency}`;
    let bal = running.get(key);
    if (!bal) {
      // One posting at a time per balance, so two payments cannot both spend the same francs.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fx:${key}`}))`);
      bal = await foreignBalance(tx, v.accountId, v.partyId, v.currency, date);
      running.set(key, bal);
    }
    const native = dec(v.nativeAmount);
    const given = v.debit.minus(v.credit);
    const reduces = !bal.native.isZero() && !native.isZero() && bal.native.isNegative() !== native.isNegative();
    if (reduces) {
      const value = bookValue(bal, native.abs(), given.abs());
      if (v.credit.gt(0)) {
        fxDebit = fxDebit.plus(value.minus(v.credit));
        v.credit = value;
      } else {
        fxDebit = fxDebit.minus(value.minus(v.debit));
        v.debit = value;
      }
    }
    bal.native = bal.native.plus(native);
    bal.usd = bal.usd.plus(v.debit.minus(v.credit));
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
      memo: "Écart de change (coût moyen des devises)",
    });
  }
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
      `La date d'annulation ne peut pas être antérieure à ${original.number} (${original.date})`,
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
        .select({ cdf: exchangeRates.cdfPerUsd, cny: exchangeRates.cnyPerUsd })
        .from(exchangeRates)
        .innerJoin(users, eq(users.id, exchangeRates.createdBy))
        .where(and(inArray(exchangeRates.date, [today, input.date]), eq(users.role, "owner")))
    );
    const prevs = [prevRow ? dec(prevRow.cdfPerUsd) : (await rateFor(tx, "0000-01-01")).rate, ...ownerRows.map((r) => dec(r.cdf))];
    const next = dec(input.cdfPerUsd);
    const near = (ref: Decimal, value: Decimal) => value.minus(ref).abs().dividedBy(ref).times(100).lte(limit);
    const prev = prevs.reduce((best, r) => (r.minus(next).abs().lt(best.minus(next).abs()) ? r : best));
    const unchanged = (stored: string | null | undefined, given: string) => stored != null && dec(stored).equals(dec(given));
    if (!unchanged(existing?.cdfPerUsd, input.cdfPerUsd) && !near(prev, next) && next.minus(prev).abs().dividedBy(prev).times(100).gt(limit)) {
      throw new AppError(
        403,
        `${next.toString()} is more than ${limit.toString()}% away from the last rate (${prev.toString()}). Only the owner can make that change.`,
        "FORBIDDEN",
        `${next.toString()} s'écarte de plus de ${limit.toString()} % du dernier taux (${prev.toString()}). Seul le propriétaire peut faire ce changement.`,
      );
    }
    if (input.cnyPerUsd && !unchanged(existing?.cnyPerUsd, input.cnyPerUsd)) {
      const [cnyRow] = await tx
        .select({ rate: exchangeRates.cnyPerUsd })
        .from(exchangeRates)
        .where(and(lt(exchangeRates.date, today), sql`${exchangeRates.cnyPerUsd} is not null`))
        .orderBy(desc(exchangeRates.date))
        .limit(1);
      const cnyRefs = [...(cnyRow?.rate ? [dec(cnyRow.rate)] : []), ...ownerRows.filter((r) => r.cny).map((r) => dec(r.cny!))];
      if (!cnyRefs.length) {
        throw new AppError(403, "Only the owner can set the first yuan rate", "FORBIDDEN", "Seul le propriétaire peut saisir le premier taux du yuan");
      }
      if (!cnyRefs.some((r) => near(r, dec(input.cnyPerUsd!)))) {
        throw new AppError(403, "Only the owner can move the yuan rate that far", "FORBIDDEN", "Seul le propriétaire peut modifier autant le taux du yuan");
      }
    }
  }
  const cny = input.cnyPerUsd ? { cnyPerUsd: input.cnyPerUsd } : {};
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
      `Le taux ${r.toString()} s'écarte de plus de ${tolerance.toString()} % du taux du jour (${day.rate.toString()}). Modifiez d'abord le taux du jour s'il a changé.`,
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
  const native = cents(nativeUsd.times(rate));
  const portion = Decimal.min(native, fc);
  const portionUsd = portion.equals(native) ? nativeUsd : cents(nativeUsd.times(portion).dividedBy(native));
  if (portionUsd.isZero()) return plain;
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
