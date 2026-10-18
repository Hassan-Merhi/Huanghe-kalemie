import Decimal from "decimal.js";
import { d } from "./format";

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
