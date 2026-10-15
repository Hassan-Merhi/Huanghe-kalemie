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

const FIELD_FR: Record<string, string> = {
  value: "valeur",
  quantity: "quantité",
  "exchange rate": "taux de change",
  rate: "taux",
  share: "part",
  "unit price": "prix unitaire",
  "unit cost": "coût unitaire",
};

function fieldFr(field: string): string {
  const w = /^weight (\d+)$/.exec(field);
  if (w) return `poids ${w[1]}`;
  return FIELD_FR[field] ?? field;
}

export function dec(value: DecimalInput | null | undefined, field = "value"): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new MoneyError(`${field} must be a number`, `Le champ « ${fieldFr(field)} » doit être un nombre`);
  }
  if (!d.isFinite()) throw new MoneyError(`${field} must be a finite number`, `Le champ « ${fieldFr(field)} » doit être un nombre fini`);
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
  if (!totalCents.isInteger()) throw new MoneyError("total must be in cents", "Le total doit être en centimes");
  if (weights.length === 0) {
    if (totalCents.isZero()) return [];
    throw new MoneyError("Cannot allocate an amount across zero lines", "Impossible de répartir un montant sur zéro ligne");
  }
  const w = weights.map((x, i) => {
    const d = dec(x, `weight ${i + 1}`);
    if (d.isNegative()) throw new MoneyError("Allocation weights cannot be negative", "Les poids de répartition ne peuvent pas être négatifs");
    return d;
  });
  const weightSum = sum(w);
  if (weightSum.isZero()) {
    if (totalCents.isZero()) return w.map(() => new Decimal(0));
    throw new MoneyError("Allocation weights add up to zero", "La somme des poids de répartition est nulle");
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

/**
 * A number typed in a spreadsheet, in French or English style: "1 415,51", "1,415.51", "12,5 $", "2.800 FC".
 * The last "," or "." followed by one or two digits is the decimal mark; any other "," "." or space groups thousands.
 * Returns the plain number text ("1415.51"), or null for an empty cell.
 */
export function parseTypedNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  let s = String(value).replace(/[\s  ]/g, "").replace(/\$|FC|CDF|USD/gi, "");
  if (s === "") return null;
  const neg = /^[-\u2212]/.test(s);
  if (/^[-+\u2212]/.test(s)) s = s.slice(1);
  const m = s.match(/^(.*?)[.,](\d{1,2})$/);
  const whole = (m ? m[1] : s).replace(/[.,]/g, "");
  const out = m ? `${whole || "0"}.${m[2]}` : whole;
  return `${neg ? "-" : ""}${out}`;
}
