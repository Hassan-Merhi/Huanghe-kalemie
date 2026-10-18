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

/** Currency marks a spreadsheet cell may carry around its number ("12,5 $", "28 000 FC", "7 ¥"). */
const CURRENCY_MARKS = /US\$|USD|\$|FC|CDF|CNY|RMB|¥|￥|元/gi;

/**
 * The currency a typed amount names, if any: "USD" for "$", "US$" or "USD", "CDF" for "FC" or "CDF",
 * "CNY" for "¥", "CNY", "RMB" or "元", "mixed" when a cell names two. A number cell names none.
 */
export function typedCurrencyMark(value: unknown): "USD" | "CDF" | "CNY" | "mixed" | null {
  if (typeof value !== "string") return null;
  const found = new Set(
    (value.match(CURRENCY_MARKS) ?? []).map((m) => (/^(US\$|USD|\$)$/i.test(m) ? "USD" : /^(FC|CDF)$/i.test(m) ? "CDF" : "CNY")),
  );
  if (found.size > 1) return "mixed";
  return (found.values().next().value as "USD" | "CDF" | "CNY" | undefined) ?? null;
}

/**
 * A number typed in a spreadsheet, in French or English style: "1 415,51", "1,415.51", "12,5 $", "2.800 FC".
 * The last "," or "." followed by one or two digits is the decimal mark; any other "," "." or space groups thousands.
 * A mark that cannot group thousands is a decimal mark whatever follows it: the last of two kinds ("1.250,125"),
 * or a single one after "0" ("0,125"), after more than three digits ("1250,125") or before other than three
 * digits ("0.0049", "1,2500"). Only a single mark between one to three digits and three digits ("4.125", "1,200")
 * is still read as thousands; a price or cost refuses it (see ambiguousTypedAmount).
 * With `measured` (litres, metres, kilos, and always weights and volumes), a single "," or "." before three
 * digits is the decimal mark too, as a form field reads it: "2,250" L is 2,25 L and "12,375" kg is 12,375 kg.
 * Only "1.000" stays in doubt there (see ambiguousTypedMeasure); this reads it as 1.
 * Returns the plain number text ("1415.51"), or null for an empty cell.
 */
export function parseTypedNumber(value: unknown, opts: { measured?: boolean } = {}): string | null {
  if (value === null || value === undefined) return null;
  // Plain digits, never "1e-7": the server reads the text as written.
  if (typeof value === "number") return Number.isFinite(value) ? new Decimal(value).toFixed() : null;
  let s = String(value).replace(/[\s\u00a0\u202f]/g, "").replace(CURRENCY_MARKS, "");
  if (s === "") return null;
  const neg = /^[-\u2212]/.test(s);
  if (/^[-+\u2212]/.test(s)) s = s.slice(1);
  // Measured: one mark only, or both kinds (the last is the decimal mark), takes any number of decimals;
  // the same mark repeated ("1.234.567") still groups thousands.
  const single = (s.match(/[.,]/g) ?? []).length === 1;
  const mixed = /,/.test(s) && /\./.test(s);
  const lone = /^(\d*)[.,](\d+)$/.exec(s);
  // Never a thousands group: a single mark after 0 or after more than three digits, or before other than three digits.
  const notGrouped = single && !!lone && (lone[2].length !== 3 || /^0*$/.test(lone[1]) || lone[1].length > 3);
  const m = s.match(opts.measured && single ? /^(.*?)[.,](\d+)$/ : mixed || notGrouped ? /^(.*?)[.,](\d+)$/ : /^(.*?)[.,](\d{1,2})$/);
  const whole = (m ? m[1] : s).replace(/[.,]/g, "");
  // Trailing zeros go, so the plain text never looks like "1.000" again when the server reads it.
  const fraction = m ? (opts.measured ? m[2].replace(/0+$/, "") : m[2]) : "";
  const out = m && fraction ? `${whole || "0"}.${fraction}` : whole || (m ? "0" : "");
  return `${neg ? "-" : ""}${out}`;
}

/**
 * In a measured quantity, weight or volume, "1.000" may be 1 000 (a French thousands dot) or 1 written
 * with three decimals. Returns both readings (["1000", "1"]) when a cell is that ambiguous, else null.
 */
export function ambiguousTypedMeasure(value: unknown): [string, string] | null {
  if (typeof value !== "string") return null;
  const m = /^([-+\u2212]?)([1-9]\d{0,2})\.000$/.exec(value.replace(/[\s\u00a0\u202f]/g, ""));
  if (!m) return null;
  const sign = m[1] && m[1] !== "+" ? "-" : "";
  return [`${sign}${m[2]}000`, `${sign}${m[2]}`];
}

/**
 * In a price or cost typed as text, "4.125" or "1,200" may be a thousands group (4 125) or three decimals
 * (4,125). Returns both readings (["4125", "4.125"]) when a cell is that ambiguous, else null. A number cell
 * (a JSON number) is never in doubt, and "0,125" or "1 250,125" cannot be a thousands group.
 */
export function ambiguousTypedAmount(value: unknown): [string, string] | null {
  if (typeof value !== "string") return null;
  const s = value.replace(/[\s\u00a0\u202f]/g, "").replace(CURRENCY_MARKS, "");
  const m = /^([-+\u2212]?)([1-9]\d{0,2})[.,](\d{3})$/.exec(s);
  if (!m) return null;
  const sign = m[1] && m[1] !== "+" ? "-" : "";
  const fraction = m[3].replace(/0+$/, "");
  return [`${sign}${m[2]}${m[3]}`, `${sign}${m[2]}${fraction ? `.${fraction}` : ""}`];
}

/**
 * A spreadsheet quantity, weight or volume in doubt: "1.000" (see ambiguousTypedMeasure) and also "1,000",
 * which a French sheet would write as 1 but an English one means as 1 000.
 */
export function ambiguousImportMeasure(value: unknown): [string, string] | null {
  const dot = ambiguousTypedMeasure(value);
  if (dot || typeof value !== "string") return dot;
  const m = /^([-+\u2212]?)([1-9]\d{0,2}),000$/.exec(value.replace(/[\s\u00a0\u202f]/g, ""));
  if (!m) return null;
  const sign = m[1] && m[1] !== "+" ? "-" : "";
  return [`${sign}${m[2]}000`, `${sign}${m[2]}`];
}

/**
 * The per-unit cost a stock value kept to the cent stands for, for display: 2,25 L at 0,125 $ are kept as
 * 0,28 $, which divided back reads 0,1244 $. The roundest cost (to the cent, then 0,005, 0,001, 0,0005 and
 * 0,0001 $) that still gives that value to the cent is shown: 0,125 $. Read only: the value, the ledger and
 * every cost a sale takes stay value ÷ qty; when no rounder figure gives the value, value ÷ qty is shown.
 */
export function shownUnitCost(value: DecimalInput, qty: DecimalInput): Decimal {
  const q = dec(qty);
  const v = cents(value);
  if (!q.gt(0)) return dec(0);
  const exact = v.dividedBy(q);
  for (const step of ["0.01", "0.005", "0.001", "0.0005", "0.0001"]) {
    const near = exact.dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(step);
    if (near.gt(0) && cents(near.times(q)).equals(v)) return near;
  }
  return exact;
}
