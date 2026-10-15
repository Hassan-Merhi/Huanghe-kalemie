import Decimal from "decimal.js";

/**
 * A number typed by a person, French or English style: "4,50", "4.50", "1 234,5", "1.234,5", "1,234.5", "0,1389".
 * Spaces group thousands. With both "," and "." the last one is the decimal mark. With only one kind:
 * one mark is the decimal mark ("2,5" = 2.5, "1.234" = 1.234 as the server writes quantities), several
 * group thousands ("1.234.567"); in English a single "," before exactly three digits groups thousands.
 * A leading "+", "-" or "−" (U+2212) gives the sign.
 * With `thousands` (franc amounts and franc rates, which have no decimals worth typing), a single "." or ","
 * before exactly three digits groups thousands: "50.000" FC is 50 000 FC and a rate of "2.850" is 2 850.
 * Returns the plain number text ("4.5"), "" for an empty field, or null when it is not a number.
 */
export function parseNumberInput(value: unknown, opts: { thousands?: boolean } = {}): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  let s = String(value).replace(/[\s\u00a0\u202f]/g, "").replace(/\$|FC|CDF|USD|%/gi, "");
  if (s === "") return "";
  // A sign typed with the phone keyboard: "+12", "-12" or the true minus "−12" (U+2212).
  let neg = false;
  if (/^[-+\u2212]/.test(s)) {
    neg = s[0] !== "+";
    s = s.slice(1);
  }
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let out: string;
  if (commas && dots) {
    const mark = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const i = s.lastIndexOf(mark);
    out = `${s.slice(0, i).replace(/[.,]/g, "")}.${s.slice(i + 1)}`;
  } else if (commas + dots === 0) {
    out = s;
  } else {
    const mark = commas ? "," : ".";
    const count = commas || dots;
    const i = s.indexOf(mark);
    if (count > 1) out = s.split(mark).join("");
    else if ((opts.thousands || (mark === "," && lang === "en")) && /^\d{1,3}[.,]\d{3}$/.test(s)) out = s.replace(mark, "");
    else out = `${s.slice(0, i) || "0"}.${s.slice(i + 1)}`;
  }
  if (out.endsWith(".")) out = out.slice(0, -1);
  if (!/^\d+(\.\d+)?$/.test(out)) return null;
  return `${neg ? "-" : ""}${out}`;
}

export function num(value: unknown): number {
  if (typeof value === "string" && /[,\s\u00a0\u202f]/.test(value)) value = parseNumberInput(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A plain number ("1234.5") as it reads inside a form field: "1 234,5" in French, "1234.5" in English.
 * Whole numbers lose their ",00". Anything that is not a plain number is shown as it is.
 */
export function inputText(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) return value ?? "";
  const [, sign, int, frac] = m;
  const fraction = frac && /[1-9]/.test(frac) ? frac : "";
  if (lang === "en") return `${sign}${int}${fraction ? `.${fraction}` : ""}`;
  const grouped = int.length > 3 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0") : int;
  return `${sign}${grouped}${fraction ? `,${fraction}` : ""}`;
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
    const intl = new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
    // fr-FR groups thousands with U+202F; use the ordinary no-break space everywhere. Negatives take the
    // true minus sign (U+2212), with no space, like every amount the formatters below write.
    f = { format: (n: number) => intl.format(n).replace(/\u202f/g, NB).replace(/^-/, MINUS) } as Intl.NumberFormat;
    cache.set(key, f);
  }
  return f;
}
/**
 * No-break space: keeps "1 415,51 $" on one line. The ordinary one (U+00A0), not the narrow U+202F,
 * which some phone fonts draw with no width at all ("1761,00 $").
 */
const NB = "\u00a0";
/** The minus sign of every negative amount on screen: "−7,80 $", never "-7,80 $" or "− 7,80 $". */
export const MINUS = "\u2212";

/** A plain number in the interface language, e.g. 1 415,5 or 1,415.5. */
export function number(value: unknown, maxDecimals = 2, minDecimals = 0): string {
  return nf(minDecimals, maxDecimals).format(num(value));
}

function withDollar(n: number, body: string): string {
  const sign = n < 0 ? MINUS : "";
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

/** How a currency is written in the shop: FC and $, never CDF / USD. */
export function curLabel(currency: string | null | undefined): string {
  return currency === "CDF" ? "FC" : currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency ?? "";
}

/** An account name with its currency, unless the name already says it: "M-Pesa ($)", "Caisse FC". */
export function accountLabel(name: string, currency: string | null | undefined): string {
  if (/\b(FC|CDF|USD|\$|CNY|RMB)\b|\$/i.test(name)) return name;
  return `${name} (${curLabel(currency)})`;
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
  const sign = v < 0 ? MINUS : "";
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

/** Date and time in the shop's time zone: 15/10/2026 14:05. */
export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(formatLang() === "fr" ? "fr-FR" : "en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Lubumbashi" }).format(new Date(value));
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

/** "2026-08" → "2026-09". */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Exact decimal arithmetic for money typed in forms. */
export function d(value: unknown): Decimal {
  try {
    let text = String(value ?? 0).trim();
    if (/[,\s\u00a0\u202f]/.test(text)) text = parseNumberInput(text) ?? "NaN";
    const x = new Decimal(text || 0);
    return x.isFinite() ? x : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** French spacing before ! ? ; : in text people typed ("Merci pour votre achat!" → "Merci pour votre achat !"). */
export function frenchPunctuation(text: string): string {
  if (lang !== "fr") return text;
  return text.replace(/([^\s\d/])[ \u202f]?([!?;:])(?=\s|$)/g, "$1\u00a0$2");
}

export function variantText(attributes: Record<string, string> | null | undefined): string {
  const values = Object.values(attributes ?? {});
  return values.length ? values.join(" / ") : "";
}
