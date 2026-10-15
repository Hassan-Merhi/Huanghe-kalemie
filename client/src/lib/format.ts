import Decimal from "decimal.js";

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/*
 * Numbers follow the interface language: French shows 1 415,51 $, 2 808 FC and 42,8 %;
 * English shows $1,415.51, 2,808 FC and 42.8%. The I18n provider sets the language before
 * anything renders.
 */
let lang: "fr" | "en" = "fr";
export function setFormatLang(l: "fr" | "en") {
  lang = l;
}
export function formatLang() {
  return lang;
}

const cache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${lang}:${min}:${max}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
    cache.set(key, f);
  }
  return f;
}
/** Narrow no-break space: keeps "1 415,51 $" on one line. */
const NB = "\u202f";

/** A plain number in the interface language, e.g. 1 415,5 or 1,415.5. */
export function number(value: unknown, maxDecimals = 2, minDecimals = 0): string {
  return nf(minDecimals, maxDecimals).format(num(value));
}

function withDollar(n: number, body: string): string {
  const sign = n < 0 ? "-" : "";
  return lang === "fr" ? `${sign}${body}${NB}$` : `${sign}$${body}`;
}

export function usd(value: unknown): string {
  const n = num(value);
  return withDollar(n, nf(2, 2).format(Math.abs(n)));
}

export function cdf(value: unknown): string {
  return `${nf(0, 0).format(num(value))}${NB}FC`;
}

export function money(value: unknown, currency: string = "USD"): string {
  if (currency === "CDF") return cdf(value);
  if (currency === "USD") return usd(value);
  return `${nf(2, 2).format(num(value))}${NB}${currency === "CNY" ? "¥" : currency}`;
}

export function qty(value: unknown): string {
  return nf(0, 3).format(num(value));
}

/** A percentage: 42,8 % in French, 42.8% in English. */
export function pct(value: unknown, decimals = 1): string {
  const body = nf(0, decimals).format(num(value));
  return lang === "fr" ? `${body}${NB}%` : `${body}%`;
}

/** Short dollar amounts for chart axes: 950 $, 1,2 k$, 15 k$ (or $950, $1.2k, $15k). */
export function compactUsd(v: number): string {
  const a = Math.abs(v);
  const [n, suffix] = a >= 1_000_000 ? [a / 1_000_000, "M"] : a >= 1000 ? [a / 1000, "k"] : [a, ""];
  const body = nf(0, a >= 10_000 && a < 1_000_000 ? 0 : suffix ? 1 : 0).format(n);
  const sign = v < 0 ? "-" : "";
  return lang === "fr" ? `${sign}${body}${NB}${suffix}$` : `${sign}$${body}${suffix}`;
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
  return `${qty(total.toNumber())}${unit ? ` ${unit}` : ""}`;
}

/** Unit costs keep more precision. */
export function unitCost(value: unknown): string {
  const n = num(value);
  const decimals = Math.abs(n) < 1 && n !== 0 ? 4 : 2;
  return withDollar(n, nf(decimals, decimals).format(Math.abs(n)));
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
