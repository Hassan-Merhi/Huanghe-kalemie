import { and, asc, eq, gte, lte, ne, sql } from "drizzle-orm";
import {
  accounts,
  categories,
  containerLines,
  containers,
  journalLines,
  journals,
  locations,
  parties,
  products,
  salePayments,
  sales,
  stockLevels,
  stockMovements,
  variants,
} from "@shared/schema";
import { dec, shownUnitCost, sum } from "@shared/money";
import type { Tx } from "../db";
import { notFound } from "../errors";
import { monthRange, pnlByAccount, summarizePnl } from "./periods";
import { accountBalances, contactSides, containersOnTheWay, goodsOnTheWayUsd, netPosition, salesByProduct } from "./reports";
import { avoirUsedSql, creditLeftSql } from "./sales";
import { keptUnitCosts } from "./stock";

// ---------------------------------------------------------------- Accounts

/** Month-by-month debits, credits and closing balance of one account for a year. */
export async function accountMonthly(tx: Tx, accountId: number, year: number) {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw notFound("Account", "Compte introuvable");
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [opening] = await tx
    .select({ bal: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journalLines.accountId, accountId), sql`${journals.date} < ${from}`));
  const rows = await tx
    .select({
      month: sql<string>`to_char(${journals.date}, 'YYYY-MM')`,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journalLines.accountId, accountId), gte(journals.date, from), lte(journals.date, to)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  let running = dec(opening.bal);
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = `${year}-${String(i + 1).padStart(2, "0")}`;
    const r = rows.find((x) => x.month === m);
    const debit = dec(r?.debit ?? 0);
    const credit = dec(r?.credit ?? 0);
    running = running.plus(debit).minus(credit);
    return { month: m, debit: debit.toFixed(2), credit: credit.toFixed(2), count: r?.count ?? 0, closing: running.toFixed(2) };
  });
  return {
    account,
    year,
    opening: dec(opening.bal).toFixed(2),
    months,
    totalDebit: sum(months.map((m) => m.debit)).toFixed(2),
    totalCredit: sum(months.map((m) => m.credit)).toFixed(2),
    closing: running.toFixed(2),
  };
}

// ---------------------------------------------------------------- Inventory

/** Quantity and value of every item in every location. Value uses the item's average cost. */
export async function inventoryByLocation(tx: Tx) {
  const rows = await tx
    .select({
      locationId: stockLevels.locationId,
      locationName: locations.name,
      variantId: variants.id,
      sku: variants.sku,
      attributes: variants.attributes,
      productId: products.id,
      productName: products.name,
      categoryName: categories.name,
      tracksSerials: products.tracksSerials,
      unit: products.unit,
      qty: stockLevels.qty,
      totalQty: variants.stockQty,
      totalValue: variants.stockValue,
      sellPrice: variants.sellPrice,
    })
    .from(stockLevels)
    .innerJoin(variants, eq(variants.id, stockLevels.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(locations, eq(locations.id, stockLevels.locationId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(sql`${stockLevels.qty} <> 0`)
    .orderBy(asc(locations.name), asc(products.name), asc(variants.sku));
  const kept = await keptUnitCosts(tx);
  // Round cumulative allocations, not each location separately: pennies must add up
  // to the variant's exact ledger value even when stock is split across warehouses.
  const allocatedQty = new Map<number, ReturnType<typeof dec>>();
  return rows.map((r) => {
    const tq = dec(r.totalQty);
    const avg = tq.isZero() ? dec(0) : dec(r.totalValue).dividedBy(tq);
    const beforeQty = allocatedQty.get(r.variantId) ?? dec(0);
    const afterQty = beforeQty.plus(r.qty);
    allocatedQty.set(r.variantId, afterQty);
    const value = tq.isZero()
      ? dec(0)
      : dec(r.totalValue).times(afterQty).dividedBy(tq).toDecimalPlaces(2)
        .minus(dec(r.totalValue).times(beforeQty).dividedBy(tq).toDecimalPlaces(2));
    return {
      locationId: r.locationId,
      locationName: r.locationName,
      variantId: r.variantId,
      sku: r.sku,
      attributes: r.attributes,
      productId: r.productId,
      productName: r.productName,
      categoryName: r.categoryName,
      unit: r.unit,
      qty: dec(r.qty).toFixed(3),
      // Shown by the same rule as Stock › Valorisation (0,125 $, not 0,1244 $); the value stays exact.
      avgCost: tq.isZero() ? "0.000000" : shownUnitCost(r.totalValue, tq, kept.get(r.variantId)).toFixed(6),
      value: value.toFixed(2),
      retailValue: dec(r.qty).times(r.sellPrice).toFixed(2),
    };
  });
}

/** Goods bought but not offloaded yet: lines of every container that is not finalized. */
export async function onTheWay(tx: Tx) {
  const rows = await tx
    .select({
      containerId: containers.id,
      containerNumber: containers.number,
      status: containers.status,
      supplierName: parties.name,
      shipDate: containers.shipDate,
      arrivalDate: containers.arrivalDate,
      currency: containers.currency,
      rateToUsd: containers.rateToUsd,
      variantId: variants.id,
      sku: variants.sku,
      attributes: variants.attributes,
      productName: products.name,
      categoryName: categories.name,
      unit: products.unit,
      quantity: containerLines.quantity,
      unitPrice: containerLines.unitPrice,
    })
    .from(containerLines)
    .innerJoin(containers, eq(containers.id, containerLines.containerId))
    .innerJoin(parties, eq(parties.id, containers.supplierId))
    .innerJoin(variants, eq(variants.id, containerLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(ne(containers.status, "finalized"))
    .orderBy(asc(containers.arrivalDate), asc(containers.number), asc(products.name));
  return rows.map((r) => ({
    ...r,
    quantity: dec(r.quantity).toFixed(3),
    fobUsd: dec(r.quantity).times(r.unitPrice).times(r.rateToUsd).toFixed(2),
  }));
}

/** Stock quantity and value per item at the end of a date, rebuilt from stock movements. */
export async function stockAsOf(tx: Tx, asOf: string) {
  const rows = await tx
    .select({
      variantId: variants.id,
      sku: variants.sku,
      attributes: variants.attributes,
      productId: products.id,
      productName: products.name,
      categoryName: categories.name,
      unit: products.unit,
      qty: sql<string>`coalesce(sum(${stockMovements.qty}), 0)`,
      value: sql<string>`coalesce(sum(${stockMovements.value}), 0)`,
    })
    .from(stockMovements)
    .innerJoin(variants, eq(variants.id, stockMovements.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(lte(stockMovements.date, asOf))
    .groupBy(variants.id, products.id, categories.name)
    .orderBy(asc(products.name), asc(variants.sku));
  const items = rows
    .map((r) => ({ ...r, qty: dec(r.qty).toFixed(3), value: dec(r.value).toFixed(2) }))
    .filter((r) => !dec(r.qty).isZero() || !dec(r.value).isZero());
  return { asOf, items, totalValue: sum(items.map((i) => i.value)).toFixed(2) };
}

/** In, out and closing per month for one item (quantity and value). */
export async function itemMonthly(tx: Tx, variantId: number, year: number) {
  const [v] = await tx
    .select({ variant: variants, productName: products.name, unit: products.unit })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.id, variantId));
  if (!v) throw notFound("Item", "Article introuvable");
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [opening] = await tx
    .select({ qty: sql<string>`coalesce(sum(${stockMovements.qty}), 0)`, value: sql<string>`coalesce(sum(${stockMovements.value}), 0)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.variantId, variantId), sql`${stockMovements.date} < ${from}`));
  const rows = await tx
    .select({
      month: sql<string>`to_char(${stockMovements.date}, 'YYYY-MM')`,
      inQty: sql<string>`coalesce(sum(case when ${stockMovements.qty} > 0 then ${stockMovements.qty} else 0 end), 0)`,
      inValue: sql<string>`coalesce(sum(case when ${stockMovements.qty} > 0 then ${stockMovements.value} else 0 end), 0)`,
      outQty: sql<string>`coalesce(sum(case when ${stockMovements.qty} < 0 then -${stockMovements.qty} else 0 end), 0)`,
      outValue: sql<string>`coalesce(sum(case when ${stockMovements.qty} < 0 then -${stockMovements.value} else 0 end), 0)`,
      // Transfers move stock between locations; they are not an in or out for the shop as a whole.
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.variantId, variantId),
        gte(stockMovements.date, from),
        lte(stockMovements.date, to),
        sql`${stockMovements.type} not in ('transfer_in', 'transfer_out')`,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  let q = dec(opening.qty);
  let val = dec(opening.value);
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = `${year}-${String(i + 1).padStart(2, "0")}`;
    const r = rows.find((x) => x.month === m);
    q = q.plus(r?.inQty ?? 0).minus(r?.outQty ?? 0);
    val = val.plus(r?.inValue ?? 0).minus(r?.outValue ?? 0);
    return {
      month: m,
      inQty: dec(r?.inQty ?? 0).toFixed(3),
      inValue: dec(r?.inValue ?? 0).toFixed(2),
      outQty: dec(r?.outQty ?? 0).toFixed(3),
      outValue: dec(r?.outValue ?? 0).toFixed(2),
      closingQty: q.toFixed(3),
      closingValue: val.toFixed(2),
    };
  });
  return {
    variant: { ...v.variant, productName: v.productName, unit: v.unit },
    year,
    openingQty: dec(opening.qty).toFixed(3),
    openingValue: dec(opening.value).toFixed(2),
    months,
  };
}

// ---------------------------------------------------------------- Analytics

export async function analytics(tx: Tx, from: string, to: string) {
  const daily = await tx
    .select({
      date: journals.date,
      revenue: sql<string>`coalesce(sum(case when ${accounts.type} = 'income' then ${journalLines.credit} - ${journalLines.debit} else 0 end), 0)`,
      cogs: sql<string>`coalesce(sum(case when ${accounts.type} = 'cost_of_sales' then ${journalLines.debit} - ${journalLines.credit} else 0 end), 0)`,
      expenses: sql<string>`coalesce(sum(case when ${accounts.type} = 'expense' then ${journalLines.debit} - ${journalLines.credit} else 0 end), 0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(gte(journals.date, from), lte(journals.date, to), ne(journals.type, "period_close"), sql`${accounts.type} in ('income', 'cost_of_sales', 'expense')`))
    .groupBy(journals.date)
    .orderBy(asc(journals.date));

  const [salesCount] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${sales.total}), 0)`,
      credit: sql<string>`coalesce(sum(${sales.creditUsd}), 0)`,
      // As the Sales list reads it: the credit left after returns, less what customers' avoirs covered (owed),
      // and that avoir part apart, so "Ventes à crédit" matches "Accordé à crédit" and "Sur l'avoir" there.
      creditLeft: sql<string>`coalesce(sum(${creditLeftSql()}), 0)`,
      onAvoir: sql<string>`coalesce(sum(${avoirUsedSql()}), 0)`,
    })
    .from(sales)
    .where(and(gte(sales.date, from), lte(sales.date, to), eq(sales.status, "completed")));

  const payments = await tx
    .select({ accountId: accounts.id, name: accounts.name, currency: accounts.currency, usd: sql<string>`coalesce(sum(${salePayments.amountUsd}), 0)` })
    .from(salePayments)
    .innerJoin(sales, eq(sales.id, salePayments.saleId))
    .innerJoin(accounts, eq(accounts.id, salePayments.accountId))
    .where(and(gte(sales.date, from), lte(sales.date, to), eq(sales.status, "completed")))
    .groupBy(accounts.id)
    .orderBy(asc(accounts.code));

  const items = await salesByProduct(tx, from, to);
  const byCategory = new Map<string, { revenue: string; profit: string; qty: string }>();
  for (const it of items) {
    const key = it.categoryName ?? "—";
    const cur = byCategory.get(key) ?? { revenue: "0", profit: "0", qty: "0" };
    byCategory.set(key, {
      revenue: dec(cur.revenue).plus(it.revenue).toFixed(2),
      profit: dec(cur.profit).plus(it.profit).toFixed(2),
      qty: dec(cur.qty).plus(it.qty).toFixed(3),
    });
  }

  const pnl = await pnlByAccount(tx, from, to);
  const totals = summarizePnl(pnl);

  // Last 12 months ending with the month of `to`.
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  const trend = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const r = monthRange(m);
    const s = summarizePnl(await pnlByAccount(tx, r.from, r.to));
    trend.push({ month: m, ...s });
  }

  const balances = await accountBalances(tx);
  const stockByCategory = await tx
    .select({ name: categories.name, value: sql<string>`coalesce(sum(${variants.stockValue}), 0)` })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .groupBy(categories.name)
    .orderBy(asc(categories.name));

  return {
    from,
    to,
    totals,
    sales: {
      count: salesCount.count,
      total: dec(salesCount.total).toFixed(2),
      credit: dec(salesCount.credit).toFixed(2),
      creditOwed: dec(salesCount.creditLeft).minus(dec(salesCount.onAvoir)).toFixed(2),
      creditOnAvoir: dec(salesCount.onAvoir).toFixed(2),
    },
    daily: daily.map((d) => ({
      date: d.date,
      revenue: dec(d.revenue).toFixed(2),
      cogs: dec(d.cogs).toFixed(2),
      grossProfit: dec(d.revenue).minus(d.cogs).toFixed(2),
      expenses: dec(d.expenses).toFixed(2),
    })),
    trend,
    payments: payments.map((p) => ({ ...p, usd: dec(p.usd).toFixed(2) })),
    byCategory: Array.from(byCategory.entries()).map(([name, v]) => ({ name, ...v })).sort((a, b) => dec(b.revenue).comparedTo(a.revenue)),
    topItems: items.slice(0, 10),
    expenses: pnl.filter((r) => r.type === "expense").sort((a, b) => dec(b.amount).comparedTo(a.amount)),
    stockByCategory: stockByCategory.map((s) => ({ name: s.name ?? "—", value: dec(s.value).toFixed(2) })).filter((s) => !dec(s.value).isZero()),
    position: netPosition(balances),
    // The contacts' side of it, each said apart as on the dashboard (supplier advances, salary advances…).
    contactBalances: await contactSides(tx),
    // Goods bought in containers not offloaded yet, not in the position until then (as the dashboard says).
    goodsOnTheWayUsd: goodsOnTheWayUsd(await containersOnTheWay(tx)).toFixed(2),
  };
}
