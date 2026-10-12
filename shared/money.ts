import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export type DecimalInput = string | number | Decimal;

export class MoneyError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly messageFr?: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

export function dec(value: DecimalInput | null | undefined, field = "value"): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new MoneyError(`${field} must be a number`);
  }
  if (!d.isFinite()) throw new MoneyError(`${field} must be a finite number`);
  return d;
}

/** Round to cents. */
export function cents(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Format to a 2-decimal string for numeric(…,2) columns. */
export function money(value: DecimalInput): string {
  return cents(value).toFixed(2);
}

/** Format to a 6-decimal string for unit costs and rates. */
export function rate6(value: DecimalInput): string {
  return dec(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

/** Format to a 3-decimal string for quantities. */
export function qty3(value: DecimalInput): string {
  return dec(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
}

export function sum(values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

/**
 * Split `total` (in cents) across `weights` so the parts add up to `total` exactly.
 * Uses the largest-remainder method; ties go to the earlier index.
 * Weights must be non-negative and not all zero (unless total is zero).
 */
export function allocateCents(total: DecimalInput, weights: DecimalInput[]): Decimal[] {
  const totalCents = cents(total).times(100);
  if (!totalCents.isInteger()) throw new MoneyError("total must be in cents");
  if (weights.length === 0) {
    if (totalCents.isZero()) return [];
    throw new MoneyError("Cannot allocate an amount across zero lines");
  }
  const w = weights.map((x, i) => {
    const d = dec(x, `weight ${i + 1}`);
    if (d.isNegative()) throw new MoneyError("Allocation weights cannot be negative");
    return d;
  });
  const weightSum = sum(w);
  if (weightSum.isZero()) {
    if (totalCents.isZero()) return w.map(() => new Decimal(0));
    throw new MoneyError("Allocation weights add up to zero");
  }
  const sign = totalCents.isNegative() ? -1 : 1;
  const absTotal = totalCents.abs();
  const raw = w.map((x) => absTotal.times(x).dividedBy(weightSum));
  const floors = raw.map((r) => r.floor());
  let remaining = absTotal.minus(sum(floors)).toNumber();
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(r.floor()) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  const result = floors.slice();
  for (let k = 0; remaining > 0; k = (k + 1) % order.length) {
    result[order[k].i] = result[order[k].i].plus(1);
    remaining -= 1;
  }
  return result.map((c) => c.times(sign).dividedBy(100));
}
