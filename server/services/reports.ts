import { and, asc, desc, eq, gte, lt, lte, ne, or, sql } from "drizzle-orm";
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
import { dec, sum } from "@shared/money";
import type { Tx } from "../db";
import { notFound } from "../errors";
import { monthRange, pnlByAccount, summarizePnl } from "./periods";
import { contactForeignBalances, SYSTEM_ACCOUNTS, systemAccountId } from "./ledger";

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

export async function trialBalance(tx: Tx, asOf?: string) {
  const rows = (await accountBalances(tx, asOf)).filter((r) => !dec(r.balance).isZero());
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
  let running = dec(0);
  return {
    party,
    rows: rows.map((r) => {
      running = running.plus(r.debit).minus(r.credit);
      return { ...r, balance: running.toFixed(2) };
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

export async function salesByProduct(tx: Tx, from: string, to: string) {
  const rows = await tx
    .select({
      variantId: variants.id,
      sku: variants.sku,
      attributes: variants.attributes,
      productName: products.name,
      categoryName: categories.name,
      qty: sql<string>`sum(${saleLines.qty} - ${saleLines.returnedQty})`,
      revenue: sql<string>`sum(${saleLines.lineTotal} - coalesce((select sum(r.amount) from sale_return_lines r where r.sale_line_id = "sale_lines"."id"), 0))`,
      cogs: sql<string>`sum(${saleLines.cogs} - coalesce((select sum(r.cogs) from sale_return_lines r where r.sale_line_id = "sale_lines"."id"), 0))`,
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .innerJoin(variants, eq(variants.id, saleLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(gte(sales.date, from), lte(sales.date, to), eq(sales.status, "completed")))
    .groupBy(variants.id, products.name, categories.name)
    .orderBy(desc(sql`3`));
  return rows
    .map((r) => ({
      ...r,
      qty: dec(r.qty).toFixed(3),
      revenue: dec(r.revenue).toFixed(2),
      cogs: dec(r.cogs).toFixed(2),
      profit: dec(r.revenue).minus(r.cogs).toFixed(2),
    }))
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
    .select({ id: containers.id, number: containers.number, status: containers.status, arrivalDate: containers.arrivalDate })
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
  return {
    money: money.toFixed(2),
    stock: stock.toFixed(2),
    transit: transit.toFixed(2),
    receivables: receivables.toFixed(2),
    payables: payables.toFixed(2),
    net: money.plus(stock).plus(transit).plus(receivables).minus(payables).toFixed(2),
  };
}
