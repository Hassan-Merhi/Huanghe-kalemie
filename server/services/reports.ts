import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  accounts,
  categories,
  containers,
  journalLines,
  journals,
  parties,
  partners,
  products,
  saleLines,
  sales,
  stockLevels,
  variants,
} from "@shared/schema";
import { cents, dec, sum, Decimal, type DecimalInput } from "@shared/money";
import type { Tx } from "../db";
import { notFound } from "../errors";
import { monthRange, pnlByAccount, summarizePnl } from "./periods";
import { contactForeignBalances, COST_FX_MEMO, SYSTEM_ACCOUNTS, systemAccountId } from "./ledger";

/** Debit − credit per account (and native CDF balance) up to a date. */
export async function accountBalances(tx: Tx, asOf?: string) {
  const dateFilter = asOf ? sql`and j.date <= ${asOf}` : sql``;
  const result = await tx.execute<{
    id: number;
    code: string;
    name: string;
    type: string;
    system_key: string | null;
    is_money: boolean;
    currency: string;
    partner_id: number | null;
    active: boolean;
    debit: string;
    credit: string;
    native: string;
  }>(sql`
    select a.id, a.code, a.name, a.type, a.system_key, a.is_money, a.currency, a.partner_id, a.active,
      coalesce(sum(l.debit), 0) as debit,
      coalesce(sum(l.credit), 0) as credit,
      coalesce(sum(l.native_amount), 0) as native
    from ${accounts} a
    left join ${journalLines} l on l.account_id = a.id
      and exists (select 1 from ${journals} j where j.id = l.journal_id ${dateFilter})
    group by a.id
    order by a.code
  `);
  return result.rows.map((r) => {
    const balance = dec(r.debit).minus(r.credit);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      systemKey: r.system_key,
      isMoney: r.is_money,
      currency: r.currency,
      partnerId: r.partner_id,
      active: r.active,
      debit: dec(r.debit).toFixed(2),
      credit: dec(r.credit).toFixed(2),
      /** Debit-positive balance in USD. */
      balance: balance.toFixed(2),
      /** Balance in the account's own currency (CDF accounts). */
      nativeBalance: r.currency === "CDF" ? dec(r.native).toFixed(2) : balance.toFixed(2),
    };
  });
}

type BalanceRow = Awaited<ReturnType<typeof accountBalances>>[number];

/**
 * What a partner may see of the chart: their own capital and current accounts, and the other
 * partners' accounts added up in one line, so totals still balance without showing the others.
 */
export function maskOtherPartners(rows: BalanceRow[], partnerId: number | null | undefined): BalanceRow[] {
  const others = rows.filter((r) => r.partnerId && r.partnerId !== partnerId);
  if (!others.length) return rows;
  const debit = sum(others.map((r) => r.debit));
  const credit = sum(others.map((r) => r.credit));
  const merged: BalanceRow = {
    id: -1,
    code: others[0].code,
    name: "Autres associés",
    type: "equity",
    systemKey: null,
    isMoney: false,
    currency: "USD",
    partnerId: -1,
    active: true,
    debit: debit.toFixed(2),
    credit: credit.toFixed(2),
    balance: debit.minus(credit).toFixed(2),
    nativeBalance: debit.minus(credit).toFixed(2),
  };
  const kept = rows.filter((r) => !others.includes(r));
  const at = rows.indexOf(others[0]);
  const before = rows.slice(0, at).filter((r) => !others.includes(r)).length;
  return [...kept.slice(0, before), merged, ...kept.slice(before)];
}

/**
 * What the shop owns, what it owes, and what belongs to the partners, on a date. Profit not yet
 * shared out by a month close shows as its own equity line, so the two sides always agree.
 */
export async function balanceSheet(tx: Tx, asOf?: string, partnerId?: number | null) {
  const all = await accountBalances(tx, asOf);
  const rows = partnerId === undefined ? all : maskOtherPartners(all, partnerId);
  const line = (r: BalanceRow, sign: 1 | -1) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    currency: r.currency,
    nativeBalance: r.currency === "CDF" ? dec(r.nativeBalance).times(sign).toFixed(2) : null,
    amount: dec(r.balance).times(sign).toFixed(2),
  });
  const nonZero = (r: BalanceRow) => !dec(r.balance).isZero();
  // Contacts on the wrong side are shown on the other side, not netted: an advance paid to a supplier
  // is something the shop owns, and a customer's deposit is something it owes.
  const partyAccounts = [await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables), await systemAccountId(tx, SYSTEM_ACCOUNTS.payables)];
  const dateFilter = asOf ? sql`and j.date <= ${asOf}` : sql``;
  const byParty = await tx.execute<{ account_id: number; debit: string; credit: string }>(sql`
    select account_id,
      coalesce(sum(case when b > 0 then b else 0 end), 0)::text as debit,
      coalesce(sum(case when b < 0 then -b else 0 end), 0)::text as credit
    from (
      select l.account_id, l.party_id, sum(l.debit - l.credit) as b
      from ${journalLines} l join ${journals} j on j.id = l.journal_id
      where l.account_id in (${sql.join(partyAccounts.map((id) => sql`${id}`), sql`, `)}) ${dateFilter}
      group by l.account_id, l.party_id
    ) x group by account_id`);
  const assets: ReturnType<typeof line>[] = [];
  const liabilities: ReturnType<typeof line>[] = [];
  for (const r of rows) {
    if ((r.type !== "asset" && r.type !== "liability") || !nonZero(r) && !partyAccounts.includes(r.id)) continue;
    const split = byParty.rows.find((b) => b.account_id === r.id);
    if (split) {
      const debit = dec(split.debit);
      const credit = dec(split.credit);
      // The other side named for what it is, not with a second bracket: "Clients (créances) (avances reçues)"
      // reads "Avances reçues des clients".
      const owedToUs = r.type === "asset" ? r.name : r.systemKey === SYSTEM_ACCOUNTS.payables ? "Avances versées aux fournisseurs, agents et employés" : `${r.name} (avances versées)`;
      const weOwe = r.type === "liability" ? r.name : r.systemKey === SYSTEM_ACCOUNTS.receivables ? "Avances reçues des clients" : `${r.name} (avances reçues)`;
      if (!debit.isZero()) assets.push({ ...line(r, 1), name: owedToUs, amount: debit.toFixed(2), nativeBalance: null });
      if (!credit.isZero()) liabilities.push({ ...line(r, -1), name: weOwe, amount: credit.toFixed(2), nativeBalance: null });
      continue;
    }
    // Any other account sits on the side its balance says.
    if (dec(r.balance).isPositive()) assets.push({ ...line(r, 1), name: r.type === "asset" ? r.name : `${r.name} (solde débiteur)` });
    else liabilities.push({ ...line(r, -1), name: r.type === "liability" ? r.name : `${r.name} (solde créditeur)` });
  }
  const equity = rows.filter((r) => r.type === "equity" && nonZero(r)).map((r) => line(r, -1));
  // Income is a credit, costs a debit: what is left in them is this period's profit, not yet shared.
  const result = sum(rows.filter((r) => ["income", "cost_of_sales", "expense"].includes(r.type)).map((r) => r.balance)).negated();
  if (!result.isZero()) {
    equity.push({ id: 0, code: "", name: "Résultat non encore réparti (mois non clôturés)", currency: "USD", nativeBalance: null, amount: result.toFixed(2) });
  }
  const total = (xs: { amount: string }[]) => sum(xs.map((x) => x.amount));
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  const totalEquity = total(equity);
  return {
    asOf: asOf ?? null,
    assets,
    liabilities,
    equity,
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    totalEquity: totalEquity.toFixed(2),
    balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
  };
}

/** Accounts a partner must not see in detail: the other partners' capital and current accounts. */
export async function otherPartnerAccountIds(tx: Tx, viewer: number | null | undefined): Promise<Set<number>> {
  const rows = await tx.select({ id: accounts.id, partnerId: accounts.partnerId }).from(accounts).where(sql`${accounts.partnerId} is not null`);
  return new Set(rows.filter((r) => r.partnerId !== viewer).map((r) => r.id));
}

const PARTNER_MONEY_TYPES = new Set(["partner_contribution", "partner_withdrawal"]);
/** Journals whose memo is typed by hand, so it may name what another partner did. */
export const PARTNER_MEMO_TYPES = new Set([...PARTNER_MONEY_TYPES, "manual", "opening", "payment", "receipt", "transfer", "reversal"]);

/**
 * A journal as a partner sees it: the other partners' lines are added up into one "Autres associés"
 * line (as in the trial balance), and a contribution or withdrawal by another partner loses its name.
 */
export function maskPartnerJournal<
  J extends { type: string; memo: string | null },
  L extends { accountId: number; debit: string; credit: string; accountName: string; memo: string | null },
>(journal: J, lines: L[], hidden: Set<number>): { journal: J; lines: L[] } {
  const masked = lines.filter((l) => hidden.has(l.accountId));
  if (!masked.length) return { journal, lines };
  const net = masked.reduce((s, l) => s.plus(l.debit).minus(l.credit), new Decimal(0));
  const typed = PARTNER_MEMO_TYPES.has(journal.type);
  // A hand-typed memo on a visible line may name the other partner's movement too.
  const kept = lines.filter((l) => !hidden.has(l.accountId)).map((l) => (typed ? { ...l, memo: null } : l));
  const at = lines.indexOf(masked[0]);
  const merged = {
    ...masked[0],
    accountId: -1,
    accountName: "Autres associés",
    ...("accountCode" in masked[0] ? { accountCode: "" } : {}),
    memo: null,
    debit: net.isPositive() ? net.toFixed(2) : "0.00",
    credit: net.isNegative() ? net.abs().toFixed(2) : "0.00",
  } as L;
  const out = net.isZero() ? kept : [...kept.slice(0, lines.slice(0, at).filter((l) => !hidden.has(l.accountId)).length), merged, ...kept.slice(lines.slice(0, at).filter((l) => !hidden.has(l.accountId)).length)];
  return {
    journal: typed ? { ...journal, memo: "Mouvement d'un autre associé" } : journal,
    lines: out,
  };
}

export async function trialBalance(tx: Tx, asOf?: string, partnerId?: number | null) {
  const all = await accountBalances(tx, asOf);
  const rows = (partnerId === undefined ? all : maskOtherPartners(all, partnerId)).filter((r) => !dec(r.balance).isZero());
  const debit = sum(rows.filter((r) => dec(r.balance).isPositive()).map((r) => r.balance));
  const credit = sum(rows.filter((r) => dec(r.balance).isNegative()).map((r) => dec(r.balance).abs()));
  return { asOf: asOf ?? null, rows, totalDebit: debit.toFixed(2), totalCredit: credit.toFixed(2), balanced: debit.equals(credit) };
}

export async function accountLedger(tx: Tx, accountId: number, from: string, to: string) {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw notFound("Account", "Compte introuvable");
  const [opening] = await tx
    .select({
      bal: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
      native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journalLines.accountId, accountId), lt(journals.date, from)));
  const rows = await tx
    .select({
      journalId: journals.id,
      number: journals.number,
      date: journals.date,
      type: journals.type,
      memo: journals.memo,
      lineMemo: journalLines.memo,
      debit: journalLines.debit,
      credit: journalLines.credit,
      nativeAmount: journalLines.nativeAmount,
      rate: journalLines.rate,
      partyName: parties.name,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .leftJoin(parties, eq(parties.id, journalLines.partyId))
    .where(and(eq(journalLines.accountId, accountId), gte(journals.date, from), lte(journals.date, to)))
    .orderBy(asc(journals.date), asc(journals.id));
  let running = dec(opening.bal);
  let runningNative = dec(opening.native);
  const isCdf = account.currency === "CDF";
  return {
    account,
    from,
    to,
    openingBalance: running.toFixed(2),
    openingNative: isCdf ? runningNative.toFixed(2) : null,
    rows: rows.map((r) => {
      running = running.plus(r.debit).minus(r.credit);
      runningNative = runningNative.plus(r.nativeAmount ?? 0);
      return { ...r, balance: running.toFixed(2), nativeBalance: isCdf ? runningNative.toFixed(2) : null };
    }),
    closingBalance: running.toFixed(2),
    closingNative: isCdf ? runningNative.toFixed(2) : null,
  };
}

/**
 * Customer, supplier or agent statement. Positive balance = they owe us. A typed memo on a journal
 * that also moves one of the `hidden` partner accounts is replaced, as in the daybook.
 */
export async function partyStatement(tx: Tx, partyId: number, hidden?: Set<number>) {
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw notFound("Customer, supplier or agent", "Client, fournisseur ou agent introuvable");
  const rows = await tx
    .select({
      journalId: journals.id,
      lineId: journalLines.id,
      number: journals.number,
      date: journals.date,
      type: journals.type,
      memo: journals.memo,
      debit: journalLines.debit,
      credit: journalLines.credit,
      currency: journalLines.currency,
      nativeAmount: journalLines.nativeAmount,
      sourceType: journals.sourceType,
      sourceId: journals.sourceId,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(eq(journalLines.partyId, partyId))
    .orderBy(asc(journals.date), asc(journals.id), asc(journalLines.id));
  // A payment split over several of the contact's lines lists the parts that settle a debt first and an
  // advance last (10 000 000 FC: the 84 000 FC owed, then the 3 200 $, then the advance), so no running
  // balance reads a debt that never existed. Display only: each line keeps its own amount.
  const ordered: typeof rows = [];
  let before = dec(0);
  for (let i = 0; i < rows.length; ) {
    let end = i;
    while (end < rows.length && rows[end].journalId === rows[i].journalId) end++;
    const pending = rows.slice(i, end);
    while (pending.length) {
      const settles = pending.findIndex((r) => {
        const move = dec(r.debit).minus(r.credit);
        return !before.isZero() && move.isNegative() !== before.isNegative() && move.abs().lte(before.abs());
      });
      const [next] = pending.splice(settles >= 0 ? settles : 0, 1);
      before = before.plus(next.debit).minus(next.credit);
      ordered.push(next);
    }
    i = end;
  }
  rows.splice(0, rows.length, ...ordered);
  // A payment whose francs or yuan left a balance at their average cost is booked on the contact at that
  // cost: the row shows the money actually paid (`paid`) and the exchange difference apart (`fxDiff`).
  const journalIds = Array.from(new Set(rows.map((r) => r.journalId)));
  const others = journalIds.length
    ? await tx
        .select({ id: journalLines.id, journalId: journalLines.journalId, debit: journalLines.debit, credit: journalLines.credit, partyId: journalLines.partyId, currency: journalLines.currency, nativeAmount: journalLines.nativeAmount, rate: journalLines.rate, memo: journalLines.memo, isMoney: accounts.isMoney, systemKey: accounts.systemKey })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(and(inArray(journalLines.journalId, journalIds), or(eq(accounts.isMoney, true), and(eq(accounts.systemKey, SYSTEM_ACCOUNTS.fx), eq(journalLines.memo, COST_FX_MEMO)), sql`${journalLines.partyId} is not null`)))
    : [];
  // When the payment is split over several of the contact's lines (francs owed, then dollars), each line
  // shows its own part: a dollar line as booked, with no exchange difference; a franc (or yuan) line what
  // the money paid less the dollar lines when it is the only one, else its units at the payment's rate.
  const paidOf = (journalId: number, lineId: number) => {
    const ls = others.filter((l) => l.journalId === journalId);
    const fx = ls.filter((l) => l.systemKey === SYSTEM_ACCOUNTS.fx).reduce((s, l) => s.plus(l.debit).minus(l.credit), dec(0));
    const theirs = ls.filter((l) => l.partyId !== null);
    const contacts = new Set(theirs.map((l) => l.partyId));
    if (fx.isZero() || contacts.size !== 1) return null;
    const value = (l: (typeof ls)[number], side: "debit" | "credit") =>
      dec(l[side]).isZero() || l.currency !== "CDF" || !l.nativeAmount || !dec(l.rate ?? 0).gt(0) ? dec(l[side]) : cents(dec(l.nativeAmount).abs().dividedBy(dec(l.rate!)));
    const money = ls.filter((l) => l.isMoney);
    const out = money.reduce((s, l) => s.plus(value(l, "credit")), dec(0));
    const into = money.reduce((s, l) => s.plus(value(l, "debit")), dec(0));
    const total = out.gt(0) !== into.gt(0) ? Decimal.max(out, into) : null;
    if (theirs.length === 1) return total;
    const own = theirs.find((l) => l.id === lineId);
    if (!own || own.currency === "USD" || !own.nativeAmount || !dec(own.rate ?? 0).gt(0)) return null;
    const side = dec(own.debit).gt(0) ? "debit" : "credit";
    const sameSide = theirs.filter((l) => dec(l[side]).gt(0));
    const foreign = sameSide.filter((l) => l.currency !== "USD");
    if (total && foreign.length === 1) {
      const rest = total.minus(sameSide.filter((l) => l.currency === "USD").reduce((s, l) => s.plus(l[side]), dec(0)));
      if (rest.gt(0)) return rest;
    }
    return cents(dec(own.nativeAmount).abs().dividedBy(dec(own.rate!)));
  };
  // A dollar line paid out of (or into) a franc box shows the francs handed over for it: the box's francs,
  // less the francs of the contact's franc lines on the same side (10 000 000 FC, of which 84 000 FC settle
  // the francs owed: 9 916 000 FC for the 3 531,34 $). Only when those francs are worth the line at the
  // payment's rate, so a voucher with other lines never shows the francs of someone else's part.
  const tenderedOf = (journalId: number, lineId: number) => {
    const ls = others.filter((l) => l.journalId === journalId);
    const theirs = ls.filter((l) => l.partyId !== null);
    const own = theirs.find((l) => l.id === lineId);
    if (!own || own.currency !== "USD" || new Set(theirs.map((l) => l.partyId)).size !== 1) return null;
    const side = dec(own.debit).gt(0) ? "debit" : "credit";
    const sameSide = theirs.filter((l) => dec(l[side]).gt(0));
    const foreign = sameSide.filter((l) => l.id !== own.id);
    if (foreign.some((l) => l.currency !== "CDF" || !l.nativeAmount)) return null;
    const money = ls.filter((l) => l.isMoney);
    const box = money[0];
    if (money.length !== 1 || box.currency !== "CDF" || !box.nativeAmount || !dec(box.rate ?? 0).gt(0) || !dec(box[side === "debit" ? "credit" : "debit"]).gt(0)) return null;
    const rest = dec(box.nativeAmount).abs().minus(foreign.reduce((s, l) => s.plus(dec(l.nativeAmount!).abs()), dec(0)));
    if (!rest.gt(0) || cents(rest.dividedBy(dec(box.rate!))).minus(dec(own[side])).abs().gt(0.01)) return null;
    return rest.toFixed(2);
  };
  const typedIds = rows.filter((r) => PARTNER_MEMO_TYPES.has(r.type)).map((r) => r.journalId);
  const masked =
    hidden?.size && typedIds.length
      ? new Set((await tx.select({ id: journalLines.journalId }).from(journalLines).where(and(inArray(journalLines.journalId, typedIds), inArray(journalLines.accountId, Array.from(hidden))))).map((r) => r.id))
      : new Set<number>();
  let running = dec(0);
  return {
    party,
    rows: rows.map((r) => {
      if (masked.has(r.journalId)) r = { ...r, memo: "Mouvement d'un autre associé" };
      running = running.plus(r.debit).minus(r.credit);
      const booked = dec(r.debit).minus(r.credit).abs();
      const paid = paidOf(r.journalId, r.lineId);
      const doc = paid && !paid.equals(booked) ? { paid: paid.toFixed(2), fxDiff: booked.minus(paid).toFixed(2) } : {};
      const tendered = r.currency === "USD" ? tenderedOf(r.journalId, r.lineId) : null;
      return { ...r, ...doc, ...(tendered ? { tendered } : {}), balance: running.toFixed(2) };
    }),
    balance: running.toFixed(2),
    foreign: await contactForeignBalances(tx, partyId),
  };
}

export async function partyBalances(tx: Tx, type?: string) {
  const rows = await tx
    .select({
      id: parties.id,
      type: parties.type,
      name: parties.name,
      phone: parties.phone,
      notes: parties.notes,
      position: parties.position,
      monthlySalary: parties.monthlySalary,
      startDate: parties.startDate,
      active: parties.active,
      balance: sql<string>`coalesce((select sum(l.debit - l.credit) from ${journalLines} l where l.party_id = "parties"."id"), 0)`,
    })
    .from(parties)
    .where(type ? eq(parties.type, type as "customer") : undefined)
    .orderBy(asc(parties.name));
  const foreign = await contactForeignBalances(tx);
  return rows.map((r) => ({
    ...r,
    balance: dec(r.balance).toFixed(2),
    foreign: foreign.filter((f) => f.partyId === r.id && !dec(f.native).isZero()).map(({ currency, native, usd }) => ({ currency, native, usd })),
  }));
}

export async function partnerSummaries(tx: Tx) {
  const ps = await tx.select().from(partners).orderBy(asc(partners.id));
  const balances = await accountBalances(tx);
  return ps.map((p) => {
    const current = balances.find((b) => b.id === p.currentAccountId);
    const capital = balances.find((b) => b.id === p.capitalAccountId);
    // Equity accounts have credit balances: show them positive (what the business owes the partner).
    return {
      ...p,
      currentBalance: dec(current?.balance ?? 0).negated().toFixed(2),
      capitalBalance: dec(capital?.balance ?? 0).negated().toFixed(2),
    };
  });
}

export async function partnerStatement(tx: Tx, partnerId: number) {
  const [p] = await tx.select().from(partners).where(eq(partners.id, partnerId));
  if (!p) throw notFound("Partner", "Associé introuvable");
  const rows = await tx
    .select({
      journalId: journals.id,
      number: journals.number,
      date: journals.date,
      type: journals.type,
      memo: journals.memo,
      accountId: journalLines.accountId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(sql`${journalLines.accountId} in (${p.currentAccountId}, ${p.capitalAccountId})`)
    .orderBy(asc(journals.date), asc(journals.id));
  let running = dec(0);
  return {
    partner: p,
    rows: rows.map((r) => {
      const amount = dec(r.credit).minus(r.debit);
      running = running.plus(amount);
      return { ...r, account: r.accountId === p.capitalAccountId ? "capital" : "current", amount: amount.toFixed(2), balance: running.toFixed(2) };
    }),
    balance: running.toFixed(2),
  };
}

export async function profitAndLoss(tx: Tx, from: string, to: string) {
  const rows = await pnlByAccount(tx, from, to);
  return { from, to, accounts: rows, totals: summarizePnl(rows) };
}

/**
 * The per-unit cost a stock value kept to the cent stands for, for display: 2,25 L at 0,125 $ are kept as
 * 0,28 $, which divided back reads 0,1244 $. The roundest cost (to the cent, then 0,005, 0,001, 0,0005 and
 * 0,0001 $) that still gives that value to the cent is shown: 0,125 $. Read only: the value, the ledger and
 * every cost a sale takes stay value ÷ qty; when no rounder figure gives the value, value ÷ qty is shown.
 */
export function shownUnitCost(value: DecimalInput, qty: DecimalInput): Decimal {
  const q = dec(qty);
  const v = cents(value);
  if (!q.gt(0)) return dec(0);
  const exact = v.dividedBy(q);
  for (const step of ["0.01", "0.005", "0.001", "0.0005", "0.0001"]) {
    const near = exact.dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(step);
    if (near.gt(0) && cents(near.times(q)).equals(v)) return near;
  }
  return exact;
}

export async function stockValuation(tx: Tx) {
  const rows = await tx
    .select({
      variantId: variants.id,
      sku: variants.sku,
      barcode: variants.barcode,
      attributes: variants.attributes,
      productId: products.id,
      productName: products.name,
      categoryName: categories.name,
      unit: products.unit,
      qty: variants.stockQty,
      value: variants.stockValue,
      sellPrice: variants.sellPrice,
      reorderLevel: variants.reorderLevel,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    // Inactive items still count while they hold stock or value, so the total always equals the ledger.
    .where(or(eq(variants.active, true), ne(variants.stockQty, "0"), ne(variants.stockValue, "0")))
    .orderBy(asc(products.name), asc(variants.sku));
  const items = rows.map((r) => {
    const q = dec(r.qty);
    return {
      ...r,
      avgCost: q.isZero() ? "0.000000" : shownUnitCost(r.value, q).toFixed(6),
      retailValue: q.times(r.sellPrice).toFixed(2),
      low: dec(r.reorderLevel).gt(0) && q.lte(r.reorderLevel),
    };
  });
  const inventoryAccount = (await accountBalances(tx)).find((a) => a.systemKey === SYSTEM_ACCOUNTS.inventory);
  const total = sum(items.map((i) => i.value));
  return {
    items,
    totalValue: total.toFixed(2),
    totalRetailValue: sum(items.map((i) => i.retailValue)).toFixed(2),
    ledgerInventory: dec(inventoryAccount?.balance ?? 0).toFixed(2),
    reconciled: total.equals(dec(inventoryAccount?.balance ?? 0)),
  };
}

/**
 * What each item sold in a period, net of cancellations and returns, each counted on its own date:
 * a sale on its sale date, a cancellation on its cancellation date and a return on its return date.
 * That is how the ledger books them, so revenue and cost always equal the P&L (accounts 4000 and 5000).
 */
export async function salesByProduct(tx: Tx, from: string, to: string) {
  const result = await tx.execute<{ variant_id: number; qty: string; revenue: string; cogs: string }>(sql`
    select x.variant_id, sum(x.qty) as qty, sum(x.revenue) as revenue, sum(x.cogs) as cogs from (
      select sl.variant_id, sl.qty, sl.line_total as revenue, sl.cogs
        from sale_lines sl join sales s on s.id = sl.sale_id
        where s.date between ${from} and ${to}
      union all
      select sl.variant_id, -sl.qty, -sl.line_total, -sl.cogs
        from sale_lines sl join sales s on s.id = sl.sale_id join journals vj on vj.id = s.void_journal_id
        where vj.date between ${from} and ${to}
      union all
      select sl.variant_id, -rl.qty, -rl.amount, -rl.cogs
        from sale_return_lines rl join sale_returns r on r.id = rl.return_id join sale_lines sl on sl.id = rl.sale_line_id
        where r.date between ${from} and ${to}
    ) x
    group by x.variant_id
  `);
  const ids = result.rows.map((r) => r.variant_id);
  const info = ids.length
    ? await tx
        .select({ variantId: variants.id, sku: variants.sku, attributes: variants.attributes, productName: products.name, categoryName: categories.name })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(inArray(variants.id, ids))
    : [];
  return result.rows
    .filter((r) => !(dec(r.qty).isZero() && dec(r.revenue).isZero() && dec(r.cogs).isZero()))
    .map((r) => {
      const v = info.find((x) => x.variantId === r.variant_id)!;
      return {
        ...v,
        qty: dec(r.qty).toFixed(3),
        revenue: dec(r.revenue).toFixed(2),
        cogs: dec(r.cogs).toFixed(2),
        profit: dec(r.revenue).minus(r.cogs).toFixed(2),
      };
    })
    .sort((a, b) => dec(b.profit).comparedTo(a.profit));
}

export async function dashboard(tx: Tx, today: string) {
  const month = today.slice(0, 7);
  const { from, to } = monthRange(month);
  const [todaySales] = await tx
    .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${sales.total}), 0)` })
    .from(sales)
    .where(and(eq(sales.date, today), eq(sales.status, "completed")));
  // Goods brought back today come off today's sales, as on the Sales page.
  const todayReturns = await tx.execute<{ total: string }>(sql`select coalesce(sum(total), 0)::text as total from sale_returns where date = ${today}`);
  const returnsToday = dec(todayReturns.rows[0]?.total ?? 0);
  const monthRows = await pnlByAccount(tx, from, to);
  const monthPnl = summarizePnl(monthRows);
  // The gross profit apart: the margin on sales (as on the Sales page), then stock losses and gains,
  // exchange differences and other income, which the gross profit shared at month close also holds.
  const signed = (r: (typeof monthRows)[number]) => (r.type === "income" ? dec(r.amount) : dec(r.amount).negated());
  const [salesId, cogsId, stockAdjId, fxId] = await Promise.all([SYSTEM_ACCOUNTS.sales, SYSTEM_ACCOUNTS.cogs, SYSTEM_ACCOUNTS.stockAdjustments, SYSTEM_ACCOUNTS.fx].map((k) => systemAccountId(tx, k)));
  const part = (ids: number[]) => sum(monthRows.filter((r) => r.type !== "expense" && ids.includes(r.accountId)).map(signed));
  const salesMargin = part([salesId, cogsId]);
  const stockAdjustments = part([stockAdjId]);
  const fxDifferences = part([fxId]);
  const monthMargin = {
    sales: salesMargin.toFixed(2),
    stockAdjustments: stockAdjustments.toFixed(2),
    fx: fxDifferences.toFixed(2),
    other: dec(monthPnl.grossProfit).minus(salesMargin).minus(stockAdjustments).minus(fxDifferences).toFixed(2),
  };
  const balances = await accountBalances(tx);
  const money = balances.filter((b) => b.isMoney && b.active);
  const receivablesId = await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables);
  const payablesId = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const inventoryId = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const [low] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(variants)
    .where(and(eq(variants.active, true), sql`${variants.reorderLevel} > 0`, sql`${variants.stockQty} <= ${variants.reorderLevel}`));
  const openContainers = await tx
    .select({
      id: containers.id,
      number: containers.number,
      status: containers.status,
      arrivalDate: containers.arrivalDate,
      // Purchase value at the container's rate; it reaches the books (stock and supplier debt) on offload.
      // The outer columns are named in full: a select from one table renders ${containers.id} as a bare "id",
      // which inside the subquery would be the line's own id.
      purchaseUsd: sql<string>`coalesce((select round(sum(l.quantity * l.unit_price) * "containers"."rate_to_usd", 2) from container_lines l where l.container_id = "containers"."id"), 0)::text`,
    })
    .from(containers)
    .where(ne(containers.status, "finalized"))
    .orderBy(asc(containers.arrivalDate));
  const recentSales = await tx
    .select({
      id: sales.id,
      number: sales.number,
      date: sales.date,
      total: sales.total,
      status: sales.status,
      customerName: parties.name,
      // What came back, so the card shows each sale net of its returns like the Sales list.
      returnedTotal: sql<string>`(select coalesce(sum(sr.total), 0)::text from sale_returns sr where sr.sale_id = ${sales.id})`,
    })
    .from(sales)
    .leftJoin(parties, eq(parties.id, sales.customerId))
    .orderBy(desc(sales.id))
    .limit(8);
  // Each contact's balance on its own: Transit's advance is not netted against what we owe Huanghe, nor
  // one customer's avoir against another's debt. Lines with no contact count by their own sign. Employees'
  // salaries owed and salary advances sit on payables too: they are said apart from the suppliers'.
  const byParty = await tx
    .select({ accountId: journalLines.accountId, employee: sql<boolean>`coalesce(max(${parties.type}::text) = 'employee', false)`, usd: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})::text` })
    .from(journalLines)
    .leftJoin(parties, eq(parties.id, journalLines.partyId))
    .where(inArray(journalLines.accountId, [receivablesId, payablesId]))
    .groupBy(journalLines.accountId, journalLines.partyId);
  const side = (accountId: number, sign: 1 | -1, employees = false) =>
    sum(byParty.filter((r) => r.accountId === accountId && (accountId !== payablesId || !!r.employee === employees) && dec(r.usd).times(sign).gt(0)).map((r) => dec(r.usd).abs())).toFixed(2);
  return {
    today,
    month,
    contactBalances: {
      customersOwe: side(receivablesId, 1),
      customerAvoirs: side(receivablesId, -1),
      weOweSuppliers: side(payablesId, -1),
      supplierAdvances: side(payablesId, 1),
      salariesOwed: side(payablesId, -1, true),
      salaryAdvances: side(payablesId, 1, true),
    },
    todaySales: { count: todaySales.count, total: dec(todaySales.total).minus(returnsToday).toFixed(2), returns: returnsToday.toFixed(2) },
    monthPnl,
    monthMargin,
    money: money.map((m) => ({ id: m.id, name: m.name, currency: m.currency, balance: m.balance, nativeBalance: m.nativeBalance })),
    receivables: balances.find((b) => b.id === receivablesId)?.balance ?? "0.00",
    payables: dec(balances.find((b) => b.id === payablesId)?.balance ?? 0).negated().toFixed(2),
    stockValue: balances.find((b) => b.id === inventoryId)?.balance ?? "0.00",
    lowStockCount: low.count,
    openContainers,
    recentSales,
    partners: await partnerSummaries(tx),
    position: netPosition(balances),
  };
}

export async function stockByLocation(tx: Tx, variantId: number) {
  return tx.select().from(stockLevels).where(eq(stockLevels.variantId, variantId));
}

/** What the shop has minus what it owes, from the ledger. */
export function netPosition(balances: Awaited<ReturnType<typeof accountBalances>>) {
  const by = (key: string) => dec(balances.find((b) => b.systemKey === key)?.balance ?? 0);
  const money = sum(balances.filter((b) => b.isMoney).map((b) => b.balance));
  const stock = by(SYSTEM_ACCOUNTS.inventory);
  const transit = by(SYSTEM_ACCOUNTS.goodsInTransit);
  const receivables = by(SYSTEM_ACCOUNTS.receivables);
  const payables = by(SYSTEM_ACCOUNTS.payables).negated();
  const named: string[] = [SYSTEM_ACCOUNTS.inventory, SYSTEM_ACCOUNTS.goodsInTransit, SYSTEM_ACCOUNTS.receivables, SYSTEM_ACCOUNTS.payables];
  const rest = balances.filter((b) => !b.isMoney && !(b.systemKey && named.includes(b.systemKey)));
  // Everything else on the balance sheet: deposits and advances, withholdings to remit, loans…
  const otherAssets = sum(rest.filter((b) => b.type === "asset").map((b) => b.balance));
  const otherLiabilities = sum(rest.filter((b) => b.type === "liability").map((b) => b.balance)).negated();
  return {
    money: money.toFixed(2),
    stock: stock.toFixed(2),
    transit: transit.toFixed(2),
    receivables: receivables.toFixed(2),
    payables: payables.toFixed(2),
    otherAssets: otherAssets.toFixed(2),
    otherLiabilities: otherLiabilities.toFixed(2),
    net: money.plus(stock).plus(transit).plus(receivables).plus(otherAssets).minus(payables).minus(otherLiabilities).toFixed(2),
  };
}
