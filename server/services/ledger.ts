import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  counters,
  journalLines,
  journals,
  periods,
  type Currency,
  type JournalType,
} from "@shared/schema";
import { cents, dec, sum, type DecimalInput } from "@shared/money";
import type { Tx } from "../db";
import { AppError, badRequest } from "../errors";

export const SYSTEM_ACCOUNTS = {
  cashUsd: "cash_usd",
  cashCdf: "cash_cdf",
  receivables: "receivables",
  inventory: "inventory",
  goodsInTransit: "goods_in_transit",
  payables: "payables",
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
  if (!row) throw new AppError(500, `System account ${key} is missing. Run the seed.`, "SETUP");
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("Dates must be YYYY-MM-DD");
  return date.slice(0, 7);
}

export async function assertPeriodOpen(tx: Tx, date: string): Promise<void> {
  const month = monthOf(date);
  const [row] = await tx.select({ status: periods.status }).from(periods).where(eq(periods.month, month));
  if (row?.status === "closed") {
    throw new AppError(409, `${month} is closed. Reopen it before changing anything dated in that month.`, "PERIOD_CLOSED");
  }
}

/** USD equivalent of a native amount. rate is CDF per 1 USD. */
export function toUsd(currency: Currency, native: DecimalInput, rate?: DecimalInput | null): string {
  if (currency === "USD") return cents(native).toFixed(2);
  const r = dec(rate, "exchange rate");
  if (r.lte(0)) throw badRequest("A CDF amount needs an exchange rate greater than zero");
  return cents(dec(native).dividedBy(r)).toFixed(2);
}

export interface PostLine {
  accountId: number;
  debit?: DecimalInput;
  credit?: DecimalInput;
  partyId?: number | null;
  /** For CDF money accounts: unsigned native amount and the CDF per USD rate. */
  nativeAmount?: DecimalInput | null;
  rate?: DecimalInput | null;
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
}

/**
 * Post a balanced journal. Lines with no amount are dropped; a journal with no amount at all
 * is not created and null is returned.
 */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<number | null> {
  if (!input.skipPeriodCheck) await assertPeriodOpen(tx, input.date);
  else monthOf(input.date);

  const lines = input.lines
    .map((l) => ({ ...l, debit: cents(l.debit ?? 0), credit: cents(l.credit ?? 0) }))
    .map((l) => {
      if (l.debit.isNegative() || l.credit.isNegative()) {
        throw new AppError(500, "Journal amounts cannot be negative", "LEDGER");
      }
      // Net a line that has both sides.
      if (!l.debit.isZero() && !l.credit.isZero()) {
        const net = l.debit.minus(l.credit);
        return { ...l, debit: net.isPositive() ? net : dec(0), credit: net.isNegative() ? net.abs() : dec(0) };
      }
      return l;
    })
    .filter((l) => !l.debit.isZero() || !l.credit.isZero());

  if (lines.length === 0) return null;

  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  if (!totalDebit.equals(totalCredit)) {
    throw new AppError(
      500,
      `Journal does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}`,
      "LEDGER_UNBALANCED",
    );
  }
  if (lines.length < 2) throw new AppError(500, "A journal needs at least two lines", "LEDGER");

  const ids = Array.from(new Set(lines.map((l) => l.accountId)));
  const accountRows = await tx.select().from(accounts).where(inArray(accounts.id, ids));
  const byId = new Map(accountRows.map((a) => [a.id, a]));

  const values = lines.map((l) => {
    const account = byId.get(l.accountId);
    if (!account) throw badRequest(`Account ${l.accountId} does not exist`);
    if (!account.active) throw badRequest(`Account ${account.name} is inactive`);
    if (account.systemKey && PARTY_REQUIRED.includes(account.systemKey) && !l.partyId) {
      throw badRequest(`${account.name} needs a customer, supplier or agent`);
    }
    const isCdf = account.isMoney && account.currency === "CDF";
    let nativeAmount: string | null = null;
    let rate: string | null = null;
    if (isCdf) {
      if (l.nativeAmount === undefined || l.nativeAmount === null || !l.rate) {
        throw badRequest(`${account.name} is a CDF account: give the CDF amount and the rate`);
      }
      const native = cents(l.nativeAmount).abs();
      nativeAmount = (l.debit.isZero() ? native.negated() : native).toFixed(2);
      rate = dec(l.rate).toFixed(4);
    }
    return {
      accountId: l.accountId,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      partyId: l.partyId ?? null,
      currency: (isCdf ? "CDF" : "USD") as Currency,
      nativeAmount,
      rate,
      memo: l.memo ?? null,
    };
  });

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

  await tx.insert(journalLines).values(values.map((v) => ({ ...v, journalId: journal.id })));
  return journal.id;
}

/** Post the exact opposite of a journal, dated `date`, and link the two. */
export async function reverseJournal(
  tx: Tx,
  journalId: number,
  opts: { date: string; type?: JournalType; memo?: string; userId?: number | null; skipPeriodCheck?: boolean },
): Promise<number> {
  const [original] = await tx.select().from(journals).where(eq(journals.id, journalId)).for("update");
  if (!original) throw badRequest("Journal not found");
  if (original.reversedByJournalId) throw badRequest(`Journal ${original.number} is already reversed`);
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
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      nativeAmount: l.nativeAmount ? dec(l.nativeAmount).abs() : null,
      rate: l.rate,
      memo: l.memo,
    })),
  });
  if (!reversalId) throw new AppError(500, "Nothing to reverse", "LEDGER");
  await tx.update(journals).set({ reversedByJournalId: reversalId }).where(eq(journals.id, original.id));
  return reversalId;
}

export interface MoneyLeg {
  accountId: number;
  /** Amount in the account's currency. */
  amount: DecimalInput;
  /** CDF per USD, required for CDF accounts. */
  rate?: DecimalInput | null;
}

/** Resolve a money account and give its USD amount plus the native fields for the journal line. */
export async function moneyLeg(
  tx: Tx,
  leg: MoneyLeg,
): Promise<{ accountId: number; currency: Currency; usd: string; nativeAmount: string | null; rate: string | null }> {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, leg.accountId));
  if (!account || !account.isMoney) throw badRequest("Choose a cash, bank or mobile money account");
  if (!account.active) throw badRequest(`${account.name} is inactive`);
  const amount = cents(leg.amount);
  if (amount.lte(0)) throw badRequest("Amounts must be greater than zero");
  const usd = toUsd(account.currency, amount, leg.rate);
  return {
    accountId: account.id,
    currency: account.currency,
    usd,
    nativeAmount: account.currency === "CDF" ? amount.toFixed(2) : null,
    rate: account.currency === "CDF" ? dec(leg.rate).toFixed(4) : null,
  };
}

export async function accountByIds(tx: Tx, ids: number[]) {
  if (ids.length === 0) return [];
  return tx.select().from(accounts).where(and(inArray(accounts.id, ids)));
}
