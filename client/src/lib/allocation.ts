import Decimal from "decimal.js";

const cents = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** One debt a payment reduces, in the order the server applies it. */
export type PaymentPart =
  | { kind: "usd"; usd: string }
  | { kind: "cdf"; usd: string; native: string }
  | { kind: "cny"; usd: string; native: string }
  | { kind: "advance"; usd: string; native: string | null };

/**
 * Where a payment to a supplier (or from a customer) goes, mirroring the server's payablesLines and
 * contactLines: yuan typed in settle the yuan with all the dollars; otherwise francs paid settle the
 * francs owed, then the dollars; dollars paid settle the dollars owed, then (with no francs owed)
 * the yuan at the day's yuan rate, else the francs at the day's rate; what is left is an advance.
 * All amounts are positive; `owed*` are what is owed in the payment's direction.
 */
export function paymentSplit(input: {
  usd: Decimal;
  /** The francs handed over, when paid from a franc box. */
  francs: Decimal | null;
  /** FC per 1 $ of the day (the payment's rate when paid in francs). */
  rate: Decimal | null;
  owedUsd: Decimal;
  owedFc: Decimal;
  /** Yuan owed (suppliers only), with the yuan rate of the day when there is one. */
  owedCny?: Decimal;
  cnyRate?: Decimal | null;
  /** Yuan the person typed in "Yuans réglés". */
  settleCny?: Decimal | null;
}): PaymentPart[] {
  const usd = cents(input.usd);
  if (!usd.gt(0)) return [];
  const parts: PaymentPart[] = [];
  // payParty with yuan typed: every dollar goes to the yuan.
  if (input.settleCny && input.settleCny.gt(0)) return [{ kind: "cny", usd: usd.toFixed(2), native: cents(input.settleCny).toFixed(2) }];
  // payablesLines: with yuan owed and no francs, what is left after the dollars owed buys yuan at the day's rate.
  let cny: PaymentPart | null = null;
  const owedCny = input.owedCny ?? new Decimal(0);
  if (owedCny.gt(0) && !input.owedFc.gt(0) && input.cnyRate && input.cnyRate.gt(0)) {
    const available = Decimal.max(usd.minus(input.owedUsd), 0);
    if (available.gt(0)) {
      let native = cents(available.times(input.cnyRate));
      let cnyUsd = available;
      if (native.gte(owedCny)) {
        native = owedCny;
        cnyUsd = Decimal.min(cents(owedCny.dividedBy(input.cnyRate)), available);
      }
      if (cnyUsd.gt(0) && native.gt(0)) cny = { kind: "cny", usd: cnyUsd.toFixed(2), native: native.toFixed(2) };
    }
  }
  let left = cny ? usd.minus(cny.usd) : usd;
  // contactLines on the rest.
  if (input.francs && input.francs.gt(0)) {
    let nativeLeft = cny ? cents(input.francs.times(left).dividedBy(usd)) : cents(input.francs);
    const first = Decimal.min(nativeLeft, input.owedFc);
    const firstUsd = first.equals(nativeLeft) ? left : cents(left.times(first).dividedBy(nativeLeft));
    if (first.gt(0) && firstUsd.gt(0)) {
      parts.push({ kind: "cdf", usd: firstUsd.toFixed(2), native: first.toFixed(2) });
      nativeLeft = nativeLeft.minus(first);
      left = left.minus(firstUsd);
    }
    const toDollars = Decimal.min(left, input.owedUsd);
    if (toDollars.gt(0)) {
      parts.push({ kind: "usd", usd: toDollars.toFixed(2) });
      nativeLeft = toDollars.equals(left) ? new Decimal(0) : nativeLeft.minus(cents(nativeLeft.times(toDollars).dividedBy(left)));
      left = left.minus(toDollars);
    }
    if (cny) parts.push(cny);
    if (left.gt(0)) parts.push({ kind: "advance", usd: left.toFixed(2), native: nativeLeft.gt(0) ? nativeLeft.toFixed(2) : null });
    return parts;
  }
  const toDollars = Decimal.min(left, input.owedUsd);
  if (toDollars.gt(0)) {
    parts.push({ kind: "usd", usd: toDollars.toFixed(2) });
    left = left.minus(toDollars);
  }
  if (cny) parts.push(cny);
  else if (left.gt(0) && input.owedFc.gt(0) && input.rate && input.rate.gt(0)) {
    const native = cents(left.times(input.rate));
    const portion = Decimal.min(native, input.owedFc);
    const portionUsd = portion.equals(native) ? left : cents(left.times(portion).dividedBy(native));
    if (portionUsd.gt(0)) {
      parts.push({ kind: "cdf", usd: portionUsd.toFixed(2), native: portion.toFixed(2) });
      left = left.minus(portionUsd);
    }
  }
  if (left.gt(0)) parts.push({ kind: "advance", usd: left.toFixed(2), native: null });
  return parts;
}

/** What is owed on a contact in the direction of a voucher line: by them on a receipt, by us on a payment. */
export function owedOn(party: { balance: string; foreign?: { currency: string; native: string; usd: string }[] }, kind: "payment" | "receipt") {
  const foreign = party.foreign ?? [];
  const dollars = new Decimal(party.balance).minus(foreign.reduce((s, f) => s.plus(f.usd), new Decimal(0)));
  const toward = (x: Decimal) => Decimal.max(kind === "receipt" ? x : x.negated(), 0);
  const native = (cur: "CDF" | "CNY") => toward(new Decimal(foreign.find((f) => f.currency === cur)?.native ?? 0));
  return { usd: toward(dollars), fc: native("CDF"), cny: native("CNY") };
}
