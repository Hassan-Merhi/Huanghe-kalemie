import Decimal from "decimal.js";

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const usdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cdfFmt = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

export function usd(value: unknown): string {
  const n = num(value);
  return `${n < 0 ? "-" : ""}$${usdFmt.format(Math.abs(n))}`;
}

export function cdf(value: unknown): string {
  return `${cdfFmt.format(num(value))} FC`;
}

export function money(value: unknown, currency: string = "USD"): string {
  return currency === "CDF" ? cdf(value) : usd(value);
}

export function qty(value: unknown): string {
  return qtyFmt.format(num(value));
}

/**
 * Total quantity of rows, formatted with its unit, or "" when the rows use different units
 * (adding sets, litres and pieces gives a meaningless number).
 */
export function qtyTotal(rows: { qty: unknown; unit?: string | null }[]): string {
  if (rows.length === 0) return "";
  const units = new Set(rows.map((r) => (r.unit ?? "").trim().toLowerCase()));
  if (units.size > 1) return "";
  const total = rows.reduce((s, r) => s.plus(new Decimal(num(r.qty))), new Decimal(0));
  const unit = (rows[0].unit ?? "").trim();
  return `${qtyFmt.format(total.toNumber())}${unit ? ` ${unit}` : ""}`;
}

/** Unit costs keep more precision. */
export function unitCost(value: unknown): string {
  const n = num(value);
  const decimals = Math.abs(n) < 1 && n !== 0 ? 4 : 2;
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

export function date(value: string | null | undefined): string {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function todayLocal(): string {
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

export function monthStart(day: string = todayLocal()): string {
  return `${day.slice(0, 7)}-01`;
}

export function previousMonth(day: string = todayLocal()): string {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Exact decimal arithmetic for money typed in forms. */
export function d(value: unknown): Decimal {
  try {
    const x = new Decimal(String(value ?? 0).trim() || 0);
    return x.isFinite() ? x : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

export function variantText(attributes: Record<string, string> | null | undefined): string {
  const values = Object.values(attributes ?? {});
  return values.length ? values.join(" / ") : "";
}
