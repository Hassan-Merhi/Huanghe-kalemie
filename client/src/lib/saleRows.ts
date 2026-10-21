import Decimal from "decimal.js";
import { frPlural } from "@shared/french";
import { cdf, d, usd } from "./format";

/** A sale as GET /api/sales lists it. */
export interface SaleListRow {
  id: number;
  number: string;
  date: string;
  status: "completed" | "voided";
  total: string;
  paidUsd: string;
  creditUsd: string;
  cogs?: string;
  customerName: string | null;
  cashier: string | null;
  createdAt?: string;
  zeroPrice?: boolean;
  qty?: string;
  returnedQty?: string;
  /** Amount and cost of the goods brought back (all returns on the sale). */
  returnedTotal?: string;
  returnedCogs?: string;
  /** Cash handed back on those returns (part of a return may instead come off what the customer owes). */
  refundedUsd?: string;
  /** Credit still owed on the sale once returns came off the customer's balance. */
  creditLeftUsd?: string;
  /** Franc rounding of the till and the refunds, + when the shop kept a few cents. */
  fcRoundingUsd?: string;
  /** A sale paid in francs alone: the francs kept net of its refunds, below zero when a refund at a higher rate gave back more. */
  fcNetNative?: string | null;
  /** "Payé": the cash really kept, payments and refunds at their own rates (Payé − Total = fcRoundingUsd). */
  paidKeptUsd?: string;
  /** The part of the credit the customer's avoir covered when the sale was made: nothing new is owed for it. */
  avoirUsedUsd?: string;
  /** The same at the sale, before returns: the sale page's "Réglé sur l'avoir". */
  avoirAtSaleUsd?: string;
  /** A cancelled sale: the part of its credit the customer's avoir had covered, given back to it. */
  avoirGivenBackUsd?: string | null;
  lineCount?: number;
  firstItem?: string | null;
}

/** GET /api/reports/daily: the "Aujourd'hui" card's figures. */
export interface Daily {
  date: string;
  count: number;
  total: string;
  netCount?: number;
  netTotal?: string;
  credit: string;
  /** The part of that credit a customer's avoir covered: nothing new is owed for it. */
  creditOnAvoirUsd?: string;
  voidsCount: number;
  voidsTotal: string;
  returnsCount?: number;
  returnsTotal?: string;
  byAccount: { account_id: number; name: string; currency: string; usd: string; native: string; refund_usd?: string; refund_native?: string }[];
}

/**
 * The till's franc rounding for the receipt, in dollars: the sale's own, before any return. On a cancelled
 * sale the reversal takes it back, so `saleFcRoundingUsd` nets to zero there; the receipt shows the sale as
 * it was made, so it is read back from "Payé" (paidKeptUsd = paidUsd + the till's rounding on a cancelled
 * sale), and a reprint reads "−40 FC (−0,01 $)" like the receipt handed over. Null when the server gave neither.
 */
export function receiptFcRoundingUsd(sale: { status: string; paidUsd: string; saleFcRoundingUsd?: string; paidKeptUsd?: string }): Decimal | null {
  if (sale.status === "voided" && sale.paidKeptUsd !== undefined) return d(sale.paidKeptUsd).minus(sale.paidUsd);
  return sale.saleFcRoundingUsd !== undefined ? d(sale.saleFcRoundingUsd) : null;
}

/**
 * A sale as the list shows it: net of the goods brought back, and paid net of the cash refunded, as the cash
 * really kept (as on the sale page), so Payé − Total is the "Arrondi FC" under it.
 */
export function netOf(r: SaleListRow) {
  const total = d(r.total).minus(d(r.returnedTotal));
  const cogs = r.cogs !== undefined ? d(r.cogs).minus(d(r.returnedCogs)) : undefined;
  const refunded = d(r.refundedUsd);
  const paid = r.paidKeptUsd !== undefined ? d(r.paidKeptUsd) : d(r.paidUsd).minus(refunded);
  return { total, cogs, profit: cogs !== undefined ? total.minus(cogs) : undefined, returned: d(r.returnedTotal), paid, refunded };
}

/** What is still on credit after returns took it off the customer's balance (the sale page's "Reste à crédit"). */
export function creditOf(r: SaleListRow): string {
  return r.creditLeftUsd ?? r.creditUsd;
}

/** Of that credit, what the customer's avoir covered (at most the credit left, from the server) and what is still owed, as the sale page splits it. */
export function creditSplit(r: SaleListRow) {
  const left = d(creditOf(r));
  const onAvoir = d(r.avoirUsedUsd ?? 0);
  // Returns took the avoir's part down (23 $ at the sale, 6 $ after a 22 $ tyre came back): said, so the
  // list's net figure is not read against the sale page's 23 $.
  const atSale = d(r.avoirAtSaleUsd ?? 0);
  return { onAvoir, owed: left.minus(onAvoir), avoirBefore: onAvoir.gt(0) && atSale.gt(onAvoir) ? atSale : null };
}

/**
 * The day as the "Aujourd'hui" card reads it: the sales still standing less the day's returns, the cash kept
 * net of refunds, and the credit after returns split into what an avoir covered and what is still owed.
 */
export function dailyFigures(data: Daily) {
  const onAvoir = Decimal.max(Decimal.min(d(data.creditOnAvoirUsd ?? 0), d(data.credit)), 0);
  return {
    count: data.netCount ?? data.count,
    total: d(data.netTotal ?? d(data.total).minus(data.voidsTotal).minus(d(data.returnsTotal)).toFixed(2)),
    paid: data.byAccount.reduce((s, a) => s.plus(d(a.usd)), d(0)),
    refunded: data.byAccount.reduce((s, a) => s.plus(d(a.refund_usd)), d(0)),
    onAvoir,
    owedCredit: d(data.credit).minus(onAvoir),
  };
}

type Words = (en: string, fr: string) => string;

/**
 * What a cancelled sale gave back, as its page and the Sales list both say it: the money handed back, the
 * avoir's part returned to the avoir, and only the rest of the credit cancelled (130 $ with 20 $ paid and 110 $
 * on the avoir: "20,00 $ remboursés · 110,00 $ rendus à l'avoir", no credit cancelled).
 */
export function voidedSplit(r: { paidUsd: string; paidKeptUsd?: string; creditUsd: string; avoirGivenBackUsd?: string | null }) {
  const givenBack = d(r.avoirGivenBackUsd ?? 0);
  return {
    refunded: Decimal.max(d(r.paidKeptUsd ?? r.paidUsd), 0),
    givenBack,
    cancelledCredit: Decimal.max(d(r.creditUsd).minus(givenBack), 0),
  };
}

/** The same in words, one part each: "20,00 $ remboursés", "10,00 $ de crédit annulé", "100,00 $ rendus à l'avoir". */
export function voidedParts(t: Words, s: ReturnType<typeof voidedSplit>): string[] {
  const fr = (x: Decimal, word: string) => frPlural(x.toFixed(2), word);
  return [
    s.refunded.gt(0) ? t(`${usd(s.refunded.toFixed(2))} refunded`, `${usd(s.refunded.toFixed(2))} ${fr(s.refunded, "remboursé")}`) : null,
    s.cancelledCredit.gt(0) ? t(`${usd(s.cancelledCredit.toFixed(2))} credit cancelled`, `${usd(s.cancelledCredit.toFixed(2))} de crédit annulé`) : null,
    s.givenBack.gt(0) ? t(`${usd(s.givenBack.toFixed(2))} back to the customer's credit`, `${usd(s.givenBack.toFixed(2))} ${fr(s.givenBack, "rendu")} à l'avoir`) : null,
  ].filter((x): x is string => !!x);
}

/**
 * The money a cancelled sale handed back, drawer by drawer: its cancellation reversed the sale's journal, so
 * each drawer gave back what it took, change netted (francs in francs: "75 800 FC remboursés depuis Caisse FC").
 * A drawer that gave change and took nothing (paid in francs, change in dollars) took that change back.
 */
export function voidedRefunds(
  t: Words,
  payments: { accountId: number; currency: string; amountNative: string; amountUsd: string }[],
  accName: (id: number) => string,
): { accountId: number; name: string; text: string; amount: string }[] {
  const by = new Map<number, { currency: string; native: Decimal; usd: Decimal }>();
  for (const p of payments) {
    const cur = by.get(p.accountId) ?? { currency: p.currency, native: d(0), usd: d(0) };
    cur.native = cur.native.plus(d(p.currency === "CDF" ? p.amountNative : p.amountUsd));
    cur.usd = cur.usd.plus(d(p.amountUsd));
    by.set(p.accountId, cur);
  }
  return [...by.entries()]
    .filter(([, v]) => !v.native.isZero())
    .map(([accountId, v]) => {
      const amount = v.currency === "CDF" ? cdf(v.native.abs().toString()) : usd(v.native.abs().toFixed(2));
      const name = accName(accountId);
      const text = v.native.gt(0)
        ? t(`${amount} refunded from ${name}`, `${amount} ${frPlural(v.native.toString(), "remboursé")} depuis ${name}`)
        : t(`${amount} of change taken back into ${name}`, `${amount} de monnaie reprise dans ${name}`);
      // Francs carry their dollars, as each payment line does: "−47 700 FC (−16,98 $)", at the sale's own rates.
      const sign = v.native.gt(0) ? "−" : "+";
      const worth = v.currency === "CDF" ? ` (${sign}${usd(v.usd.abs().toFixed(2))})` : "";
      return { accountId, name, text, amount: `${sign}${amount}${worth}` };
    });
}
