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
import { cents, dec, sum, Decimal } from "@shared/money";
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
      const owedToUs = r.type === "asset" ? r.name : `${r.name} (avances versées)`;
      const weOwe = r.type === "liability" ? r.name : `${r.name} (avances reçues)`;
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
export const PARTNER_MEMO_TYPES = new Set([...PARTNER_MONEY_TYPES, "manual", "opening", "payment", "receipt", "transfer"]);

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

/** Customer, supplier or agent statement. Positive balance = they owe us. */
export async function partyStatement(tx: Tx, partyId: number) {
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw notFound("Customer, supplier or agent", "Client, fournisseur ou agent introuvable");
  const rows = await tx
    .select({
      journalId: journals.id,
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
    .orderBy(asc(journals.date), asc(journals.id));
  // A payment whose francs or yuan left a balance at their average cost is booked on the contact at that
  // cost: the row shows the money actually paid (`paid`) and the exchange difference apart (`fxDiff`).
  const journalIds = Array.from(new Set(rows.map((r) => r.journalId)));
  const others = journalIds.length
    ? await tx
        .select({ journalId: journalLines.journalId, debit: journalLines.debit, credit: journalLines.credit, partyId: journalLines.partyId, currency: journalLines.currency, nativeAmount: journalLines.nativeAmount, rate: journalLines.rate, memo: journalLines.memo, isMoney: accounts.isMoney, systemKey: accounts.systemKey })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(and(inArray(journalLines.journalId, journalIds), or(eq(accounts.isMoney, true), and(eq(accounts.systemKey, SYSTEM_ACCOUNTS.fx), eq(journalLines.memo, COST_FX_MEMO)), sql`${journalLines.partyId} is not null`)))
    : [];
  const paidOf = (journalId: number) => {
    const ls = others.filter((l) => l.journalId === journalId);
    const fx = ls.filter((l) => l.systemKey === SYSTEM_ACCOUNTS.fx).reduce((s, l) => s.plus(l.debit).minus(l.credit), dec(0));
    const contacts = new Set(ls.filter((l) => l.partyId !== null).map((l) => l.partyId));
    if (fx.isZero() || contacts.size !== 1) return null;
    const value = (l: (typeof ls)[number], side: "debit" | "credit") =>
      dec(l[side]).isZero() || l.currency !== "CDF" || !l.nativeAmount || !dec(l.rate ?? 0).gt(0) ? dec(l[side]) : cents(dec(l.nativeAmount).abs().dividedBy(dec(l.rate!)));
    const money = ls.filter((l) => l.isMoney);
    const out = money.reduce((s, l) => s.plus(value(l, "credit")), dec(0));
    const into = money.reduce((s, l) => s.plus(value(l, "debit")), dec(0));
    return out.gt(0) !== into.gt(0) ? Decimal.max(out, into) : null;
  };
  let running = dec(0);
  return {
    party,
    rows: rows.map((r) => {
      running = running.plus(r.debit).minus(r.credit);
      const booked = dec(r.debit).minus(r.credit).abs();
      const paid = paidOf(r.journalId);
      const doc = paid && !paid.equals(booked) ? { paid: paid.toFixed(2), fxDiff: booked.minus(paid).toFixed(2) } : {};
      return { ...r, ...doc, balance: running.toFixed(2) };
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
      avgCost: q.isZero() ? "0.000000" : dec(r.value).dividedBy(q).toFixed(6),
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
  const monthPnl = summarizePnl(await pnlByAccount(tx, from, to));
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
      purchaseUsd: sql<string>`coalesce((select round(sum(l.quantity * l.unit_price) * ${containers.rateToUsd}, 2) from container_lines l where l.container_id = ${containers.id}), 0)::text`,
    })
    .from(containers)
    .where(ne(containers.status, "finalized"))
    .orderBy(asc(containers.arrivalDate));
  const recentSales = await tx
    .select({ id: sales.id, number: sales.number, date: sales.date, total: sales.total, status: sales.status, customerName: parties.name })
    .from(sales)
    .leftJoin(parties, eq(parties.id, sales.customerId))
    .orderBy(desc(sales.id))
    .limit(8);
  return {
    today,
    month,
    todaySales: { count: todaySales.count, total: dec(todaySales.total).toFixed(2) },
    monthPnl,
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
