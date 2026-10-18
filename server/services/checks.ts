import { eq, ne, sql } from "drizzle-orm";
import { containerExpenses, containers, parties, variants } from "@shared/schema";
import { cents, dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { SYSTEM_ACCOUNTS, cnyRateFor, rateFor, shopToday, systemAccountId } from "./ledger";
import { accountBalances } from "./reports";

/*
 * Self-check: the figures that must always agree, recomputed from scratch.
 * A difference means something was entered outside the app or a bug slipped through,
 * so each check says what was compared and by how much they differ.
 */

export interface Check {
  key: string;
  ok: boolean;
  /** What the books say and what the detail adds up to. */
  expected: string;
  actual: string;
  difference: string;
  /** Rows to look at when the check fails. */
  details?: { label: string; value: string }[];
}

function compare(key: string, expected: Decimal, actual: Decimal, details?: Check["details"]): Check {
  const diff = cents(actual.minus(expected));
  return { key, ok: diff.isZero(), expected: expected.toFixed(2), actual: actual.toFixed(2), difference: diff.toFixed(2), details: diff.isZero() ? undefined : details };
}

export async function selfCheck(tx: Tx) {
  const balances = await accountBalances(tx);
  const balanceOf = (id: number) => dec(balances.find((b) => b.id === id)?.balance ?? 0);
  const checks: Check[] = [];

  // 1. Debits equal credits.
  const debit = sum(balances.map((b) => (dec(b.balance).isPositive() ? b.balance : 0)));
  const credit = sum(balances.map((b) => (dec(b.balance).isNegative() ? dec(b.balance).abs() : 0)));
  checks.push(compare("books_balance", debit, credit));

  // 2. Stock on the items equals the Stock account.
  const inventoryId = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const [stock] = await tx.select({ value: sql<string>`coalesce(sum(${variants.stockValue}), 0)` }).from(variants);
  checks.push(compare("stock_value", balanceOf(inventoryId), dec(stock.value)));

  // 3. Quantities per location add up to each item's quantity.
  const qtyRows = await tx.execute<{ id: number; sku: string; name: string; qty: string; by_location: string }>(sql`
    select v.id, v.sku, p.name, v.stock_qty as qty, coalesce((select sum(l.qty) from stock_levels l where l.variant_id = v.id), 0) as by_location
    from variants v join products p on p.id = v.product_id
    where v.stock_qty <> coalesce((select sum(l.qty) from stock_levels l where l.variant_id = v.id), 0)
  `);
  checks.push({
    key: "stock_locations",
    ok: qtyRows.rows.length === 0,
    expected: "0",
    actual: String(qtyRows.rows.length),
    difference: String(qtyRows.rows.length),
    details: qtyRows.rows.slice(0, 20).map((r) => ({ label: `${r.name} (${r.sku})`, value: `${dec(r.qty).toString()} ≠ ${dec(r.by_location).toString()}` })),
  });

  // 4. Motorcycles in stock equal the motorcycle records in stock.
  const motoRows = await tx.execute<{ name: string; sku: string; qty: string; units: number }>(sql`
    select p.name, v.sku, v.stock_qty as qty, (select count(*)::int from motorcycle_units u where u.variant_id = v.id and u.status = 'in_stock') as units
    from variants v join products p on p.id = v.product_id
    where p.tracks_serials and v.stock_qty <> (select count(*) from motorcycle_units u where u.variant_id = v.id and u.status = 'in_stock')
  `);
  checks.push({
    key: "motorcycles",
    ok: motoRows.rows.length === 0,
    expected: "0",
    actual: String(motoRows.rows.length),
    difference: String(motoRows.rows.length),
    details: motoRows.rows.map((r) => ({ label: `${r.name} (${r.sku})`, value: `${dec(r.qty).toString()} ≠ ${r.units}` })),
  });

  // 5 and 6. Contacts add up to receivables and payables, and no line there is missing its contact.
  for (const [key, sysKey] of [["receivables", SYSTEM_ACCOUNTS.receivables], ["payables", SYSTEM_ACCOUNTS.payables]] as const) {
    const accountId = await systemAccountId(tx, sysKey);
    const rows = await tx.execute<{ party_id: number | null; name: string | null; balance: string }>(sql`
      select l.party_id, p.name, sum(l.debit - l.credit) as balance
      from journal_lines l left join parties p on p.id = l.party_id
      where l.account_id = ${accountId}
      group by l.party_id, p.name
    `);
    const byContact = sum(rows.rows.filter((r) => r.party_id).map((r) => r.balance));
    const orphan = rows.rows.find((r) => !r.party_id);
    // Payables are shown as what we owe (a positive amount).
    const sign = key === "payables" ? -1 : 1;
    checks.push(
      compare(key, balanceOf(accountId).times(sign), byContact.times(sign), orphan ? [{ label: "Sans contact", value: dec(orphan.balance).times(sign).toFixed(2) }] : undefined),
    );
  }

  // 7. Costs on containers not yet offloaded equal Goods in transit.
  const gitId = await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit);
  const [git] = await tx
    .select({ value: sql<string>`coalesce(sum(${containerExpenses.amountUsd}), 0)` })
    .from(containerExpenses)
    .innerJoin(containers, eq(containers.id, containerExpenses.containerId))
    .where(ne(containers.status, "finalized"));
  checks.push(compare("goods_in_transit", balanceOf(gitId), dec(git.value)));

  // 8. No cash box, bank or mobile money below zero (in its own currency).
  const negative = balances.filter((b) => b.isMoney && dec(b.nativeBalance).isNegative());
  checks.push({
    key: "money_not_negative",
    ok: negative.length === 0,
    expected: "0",
    actual: String(negative.length),
    difference: String(negative.length),
    details: negative.map((b) => ({ label: b.name, value: `${dec(b.nativeBalance).toFixed(2)} ${b.currency === "CDF" ? "FC" : "$"}` })),
  });

  // 9. Every franc line on a franc account carries its francs (so counted francs can be compared).
  const [missing] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_lines l join accounts a on a.id = l.account_id
    where a.is_money and a.currency = 'CDF' and (l.native_amount is null or l.rate is null)
  `).then((r) => r.rows);
  checks.push({ key: "franc_lines", ok: missing.n === 0, expected: "0", actual: String(missing.n), difference: String(missing.n) });

  // 10. No franc or yuan balance of a contact (or another account that is not money) holds dollars for
  // francs or yuan worth under half a cent: no posting leaves one, and such a residue is only cleared
  // when its dollars are nil too, so a journal posted by hand that leaves one waits here for a correction.
  const foreign = await tx.execute<{ account: string; party: string | null; currency: "CDF" | "CNY"; native: string; usd: string }>(sql`
    select a.name as account, p.name as party, l.currency, sum(coalesce(l.native_amount, 0)) as native, sum(l.debit - l.credit) as usd
    from journal_lines l join accounts a on a.id = l.account_id left join parties p on p.id = l.party_id
    where not a.is_money and l.currency in ('CDF', 'CNY')
    group by l.account_id, a.name, l.party_id, p.name, l.currency
    having abs(sum(l.debit - l.credit)) >= 0.005
  `);
  const today = shopToday();
  const rates = { CDF: (await rateFor(tx, today)).rate, CNY: await cnyRateFor(tx, today) };
  const mismatched = foreign.rows.filter((r) => {
    const rate = rates[r.currency];
    return dec(r.native).isZero() || (!!rate && rate.gt(0) && dec(r.native).abs().dividedBy(rate).lt("0.005"));
  });
  checks.push({
    key: "foreign_balances",
    ok: mismatched.length === 0,
    expected: "0",
    actual: String(mismatched.length),
    difference: String(mismatched.length),
    details: mismatched.slice(0, 20).map((r) => ({
      label: `${r.party ?? r.account} · ${r.currency === "CDF" ? "FC" : "¥"}`,
      value: `${dec(r.native).toFixed(2)} ${r.currency === "CDF" ? "FC" : "¥"} ≠ ${dec(r.usd).toFixed(2)} $`,
    })),
  });

  // Points to look at, which do not make the books wrong: sales at 0 $ or for less than their cost.
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const zero = await tx.execute<{ number: string; date: string; total: string }>(sql`
    select s.number, s.date, s.total from sales s
    where s.status = 'completed' and s.date >= ${since}
      and exists (select 1 from sale_lines l where l.sale_id = s.id and l.unit_price <= 0)
    order by s.date desc, s.id desc
  `);
  const loss = await tx.execute<{ number: string; date: string; total: string; cogs: string }>(sql`
    select s.number, s.date, s.total, s.cogs from sales s
    where s.status = 'completed' and s.date >= ${since} and s.total < s.cogs
    order by s.date desc, s.id desc
  `);
  const warnings: Check[] = [
    {
      key: "sales_zero_price",
      ok: zero.rows.length === 0,
      expected: "0",
      actual: String(zero.rows.length),
      difference: String(zero.rows.length),
      details: zero.rows.slice(0, 20).map((r) => ({ label: `${r.number} · ${r.date}`, value: dec(r.total).toFixed(2) })),
    },
    {
      key: "sales_below_cost",
      ok: loss.rows.length === 0,
      expected: "0",
      actual: String(loss.rows.length),
      difference: String(loss.rows.length),
      details: loss.rows.slice(0, 20).map((r) => ({ label: `${r.number} · ${r.date}`, value: `${dec(r.total).toFixed(2)} < ${dec(r.cogs).toFixed(2)}` })),
    },
  ];

  return { ok: checks.every((c) => c.ok), checks, warnings };
}

// ---------------------------------------------------------------- Customer ageing

export interface AgeingRow {
  partyId: number;
  name: string;
  phone: string | null;
  balance: string;
  current: string;
  d31_60: string;
  d61_90: string;
  over90: string;
  oldestDate: string | null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Who owes what and for how long. Payments clear the oldest amounts first, so what is left open
 * is the most recent part of each customer's debt; it is bucketed by its age on `asOf`.
 */
export async function customerAgeing(tx: Tx, asOf: string) {
  const receivables = await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables);
  const lines = await tx.execute<{ party_id: number; date: string; debit: string; credit: string }>(sql`
    select l.party_id, j.date, l.debit, l.credit
    from journal_lines l join journals j on j.id = l.journal_id
    where l.account_id = ${receivables} and l.party_id is not null and j.date <= ${asOf}
    order by l.party_id, j.date, l.id
  `);
  const customers = await tx.select({ id: parties.id, name: parties.name, phone: parties.phone }).from(parties).where(eq(parties.type, "customer"));
  const byParty = new Map<number, { date: string; debit: string; credit: string }[]>();
  for (const l of lines.rows) byParty.set(l.party_id, [...(byParty.get(l.party_id) ?? []), l]);

  const rows: AgeingRow[] = [];
  for (const [partyId, ls] of byParty) {
    const open: { date: string; amount: Decimal }[] = [];
    let credits = new Decimal(0);
    for (const l of ls) {
      if (dec(l.debit).gt(0)) open.push({ date: l.date, amount: dec(l.debit) });
      credits = credits.plus(l.credit);
    }
    // Credits (payments, returns) clear the oldest amounts first.
    for (const o of open) {
      const used = Decimal.min(o.amount, credits);
      o.amount = o.amount.minus(used);
      credits = credits.minus(used);
    }
    const left = open.filter((o) => o.amount.gt(0));
    const balance = sum(left.map((o) => o.amount)).minus(credits);
    if (!balance.gt(0)) continue;
    const bucket = (lo: number, hi: number) => sum(left.filter((o) => {
      const age = daysBetween(o.date, asOf);
      return age >= lo && age <= hi;
    }).map((o) => o.amount));
    const c = customers.find((x) => x.id === partyId);
    rows.push({
      partyId,
      name: c?.name ?? `#${partyId}`,
      phone: c?.phone ?? null,
      balance: balance.toFixed(2),
      current: bucket(-100000, 30).toFixed(2),
      d31_60: bucket(31, 60).toFixed(2),
      d61_90: bucket(61, 90).toFixed(2),
      over90: bucket(91, 1000000).toFixed(2),
      oldestDate: left[0]?.date ?? null,
    });
  }
  rows.sort((a, b) => dec(b.over90).comparedTo(a.over90) || dec(b.balance).comparedTo(a.balance));
  const total = (k: keyof AgeingRow) => sum(rows.map((r) => r[k] as string)).toFixed(2);
  return {
    asOf,
    rows,
    totals: { balance: total("balance"), current: total("current"), d31_60: total("d31_60"), d61_90: total("d61_90"), over90: total("over90") },
  };
}
