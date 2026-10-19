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
    // As contactLines: the dollars all the francs owed are worth at the day's rate (3 289,91 $ for 3 260 $ and
    // 84 000 FC) settle all of them, with no cent left as an advance; less buys whole francs, rounded down.
    const allUsd = cents(input.owedFc.dividedBy(input.rate));
    let portion = input.owedFc;
    let portionUsd = allUsd;
    if (left.lt(allUsd)) {
      portion = Decimal.min(left.times(input.rate).toDecimalPlaces(0, Decimal.ROUND_FLOOR), input.owedFc);
      portionUsd = Decimal.min(cents(portion.dividedBy(input.rate)), left);
    }
    if (portionUsd.gt(0) && portion.gt(0)) {
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

/**
 * A supplier's yuan as the server measures them for a payment dated `day` (payParty reads them as of its date),
 * from the statement's lines: what was owed in yuan that day, the latest day their yuan moved (no yuan can move
 * dated before it, the A36 rule), and the first day after `day` a yuan debt to them was booked. A payment
 * back-dated to the 15th, for a debt that starts with an offload on the 18th, settles no yuan.
 */
export function yuanOnDate(
  rows: { date: string; currency: string; nativeAmount: string | null; debit: string; credit: string }[],
  day: string,
): { native: string; usd: string; latest: string | null; startsAfter: string | null } {
  let native = new Decimal(0);
  let usd = new Decimal(0);
  let latest: string | null = null;
  let startsAfter: string | null = null;
  for (const r of rows) {
    if (r.currency !== "CNY" || !r.nativeAmount || new Decimal(r.nativeAmount).isZero()) continue;
    const date = r.date.slice(0, 10);
    if (!latest || date > latest) latest = date;
    if (date <= day) {
      native = native.plus(r.nativeAmount);
      usd = usd.plus(r.debit).minus(r.credit);
    } else if (new Decimal(r.nativeAmount).isNegative() && (!startsAfter || date < startsAfter)) startsAfter = date;
  }
  return { native: native.toFixed(2), usd: usd.toFixed(2), latest, startsAfter };
}

/**
 * The yuan an advance the supplier already holds will settle when a payment to them is saved, mirroring the
 * server's advanceToYuanLines: once the payment's own yuan are settled (`settledNative`), dollars paid ahead
 * go to the yuan still owed, then francs paid ahead (at the day's franc rate). The yuan are valued at the yuan
 * rate of the day, else at what they cost (`owedUsd`, their book value). Nothing when no yuan are left or no
 * advance is held. All amounts are positive.
 */
export function advanceToYuan(input: {
  owedCny: Decimal;
  /** The yuan owed's book value in dollars. */
  owedUsd: Decimal;
  settledNative: Decimal;
  /** Dollars paid ahead to them. */
  advanceUsd: Decimal;
  /** Francs paid ahead to them, and the day's franc rate. */
  advanceFc?: Decimal;
  fcRate?: Decimal | null;
  cnyRate?: Decimal | null;
}): { native: string; usd: string } | null {
  const owed = input.owedCny;
  let left = owed.minus(input.settledNative);
  if (!owed.gt(0) || !left.gt(0)) return null;
  const day = input.cnyRate && input.cnyRate.gt(0) ? input.cnyRate : null;
  if (!day && !input.owedUsd.gt(0)) return null;
  const usdOf = (n: Decimal) => cents(day ? n.dividedBy(day) : input.owedUsd.times(n).dividedBy(owed));
  const nativeOf = (u: Decimal) => cents(day ? u.times(day) : owed.times(u).dividedBy(input.owedUsd));
  let native = new Decimal(0);
  let usd = new Decimal(0);
  const take = (held: Decimal) => {
    const leftUsd = usdOf(left);
    const applyUsd = Decimal.min(held, leftUsd);
    const applyNative = applyUsd.equals(leftUsd) ? left : nativeOf(applyUsd);
    if (!applyUsd.gt(0) || !applyNative.gt(0)) return;
    native = native.plus(applyNative);
    usd = usd.plus(applyUsd);
    left = left.minus(applyNative);
  };
  if (input.advanceUsd.gt(0)) take(input.advanceUsd);
  if (left.gt(0) && input.advanceFc && input.advanceFc.gt(0) && input.fcRate && input.fcRate.gt(0)) take(cents(input.advanceFc.dividedBy(input.fcRate)));
  return native.gt(0) ? { native: native.toFixed(2), usd: usd.toFixed(2) } : null;
}
