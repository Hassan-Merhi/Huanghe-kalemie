import Decimal from "decimal.js";

/**
 * A number typed by a person, French or English style: "4,50", "4.50", "1 234,5", "1.234,5", "1,234.5", "0,1389".
 * Spaces group thousands. With both "," and "." the last one is the decimal mark. With only one kind:
 * one mark is the decimal mark ("2,5" = 2.5, "1.234" = 1.234 as the server writes quantities), several
 * group thousands ("1.234.567"); in English a single "," before exactly three digits groups thousands.
 * A leading "+", "-" or "−" (U+2212) gives the sign.
 * With `thousands` (franc amounts and franc rates, which have no decimals worth typing), a single "." or ","
 * before exactly three digits groups thousands: "50.000" FC is 50 000 FC and a rate of "2.850" is 2 850.
 * With `usd` (dollar or yuan amounts), "1.200" or "1,200" is refused (null): see ambiguousDollars.
 * With `measured` (litres, metres, kilos), only "1.000" (digits, a dot, three zeros) is refused: see ambiguousMeasure.
 * Returns the plain number text ("4.5"), "" for an empty field, or null when it is not a number.
 */
export function parseNumberInput(value: unknown, opts: { thousands?: boolean; usd?: boolean; measured?: boolean } = {}): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  let s = String(value).replace(/[\s\u00a0\u202f]/g, "").replace(/\$|FC|CDF|USD|CNY|RMB|¥|%/gi, "");
  if (s === "") return "";
  if (opts.usd && ambiguousDollars(s) !== null) return null;
  if (opts.measured && ambiguousMeasure(s) !== null) return null;
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

/**
 * In a dollar field "1.200" or "1,200" may be 1 200 $ or 1,20 $ (a price of 1,40 $ typed "1.400" is a
 * thousand times too small or too big); the same holds for yuan. Returns the thousands reading ("1200",
 * "-1200") when the text is that ambiguous, else null. "0.500" and "12.50" are not ambiguous, nor is "1,200"
 * in English (thousands).
 */
export function ambiguousDollars(value: string): string | null {
  const s = value.replace(/[\s\u00a0\u202f]/g, "").replace(/\$|USD|CNY|RMB|¥/gi, "");
  const m = /^([-+\u2212]?)([1-9]\d{0,2})([.,])(\d{3})$/.exec(s);
  if (!m || (m[3] === "," && lang === "en")) return null;
  return `${m[1] && m[1] !== "+" ? "-" : ""}${m[2]}${m[4]}`;
}

/**
 * In a quantity of litres, metres or kilos, "1.000" may be 1 000 L (thousands, French-style) or 1 L written
 * with three decimals; read as 1, a supplier's debt and the stock come out a thousand times too small. Only
 * that exact shape is in doubt (one to three digits, a dot, "000"): "1,5", "2.5", "12.75" and "1.250" (1,25)
 * stay decimals. Returns the thousands reading ("1000") when in doubt, else null.
 */
export function ambiguousMeasure(value: string): string | null {
  const s = value.replace(/[\s\u00a0\u202f]/g, "");
  return /^[-+\u2212]?[1-9]\d{0,2}\.000$/.test(s) ? ambiguousDollars(s) : null;
}

/**
 * What a form field passes up when its text cannot be used as typed: the text itself, which is not a plain
 * number, so the page's checks refuse it. An ambiguous dollar amount ("1.200") gets a "?" so that it is not
 * one either ("1.200?"); d() and num() read both as 0.
 */
export function unusableText(typed: string): string {
  // "1,200" too: d() would otherwise read it as 1,2.
  return /^-?\d+(\.\d+)?$/.test(typed.trim()) || ambiguousDollars(typed) !== null ? `${typed.trim()}?` : typed;
}

/**
 * The two readings of an amount a field refused as ambiguous ("1.200?" → ["1200", "1.2"]), so a page can ask
 * "1 200,00 $ ou 1,20 $ ?" instead of saying the amount is missing; null for anything else.
 */
export function ambiguousReadings(value: string | null | undefined): [string, string] | null {
  const m = /^(.*)\?$/.exec((value ?? "").trim());
  const big = m ? ambiguousDollars(m[1]) : null;
  return big === null ? null : [big, new Decimal(big).dividedBy(1000).toString()];
}

/** False for what a number field passed up because it could not be used (see unusableText); "" is fine. */
export function typedNumberOk(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v === "" || /^-?\d+(\.\d+)?$/.test(v);
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

/** A percentage: 42,8 % in French, 42.8% in English. Margins pass `minDecimals` so 43,0 % sits beside 38,6 %. */
export function pct(value: unknown, decimals = 1, minDecimals = 0): string {
  const body = nf(Math.min(minDecimals, decimals), decimals).format(num(value));
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

/**
 * Unit costs keep more precision, by one rule whatever their size: cents always, and up to four decimals
 * when the cost is not whole cents, trailing zeros trimmed (4,125 $ and 0,125 $; 12,00 $ and 0,50 $).
 */
export function unitCost(value: unknown): string {
  const n = num(value);
  return withDollar(n, nf(2, 4).format(Math.abs(n)));
}

export function date(value: string | null | undefined): string {
  if (!value) return "";
  const [y, m, d] = shopDay(value).split("-");
  return `${d}/${m}/${y}`;
}

/**
 * The shop's day (Kalemie, UTC+2) of a date or a timestamp: "2026-10-14T22:29:00Z" is the 15th there, though
 * its first ten characters say the 14th. A plain date ("2026-10-14") is that day.
 */
export function shopDay(value: string): string {
  if (!/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value.slice(0, 10);
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t + 2 * 60 * 60 * 1000).toISOString().slice(0, 10) : value.slice(0, 10);
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

/** "7,1" for a stored USD-per-unit rate of 0.140845070423: how many of the currency one dollar buys, as it was typed. */
export function perUsdText(rateToUsd: string | null | undefined): string {
  const r = d(rateToUsd);
  if (r.lte(0)) return "";
  return d(1).dividedBy(r).toSignificantDigits(8).toDecimalPlaces(4).toString();
}

/** USD per 1 unit for "how many one dollar buys", kept to the twelve decimals the server stores: 2 808 FC stays 2 808 FC. */
export function usdPerUnit(perUsd: string | null | undefined): string {
  const x = d(perUsd);
  return x.gt(0) ? d(1).dividedBy(x).toDecimalPlaces(12).toString() : "";
}

/**
 * What to say when a quantity counted in whole units was refused by its field as ambiguous ("1.000" pieces):
 * "Précisez la quantité : 1 000 ou 1".
 */
export function unclearQty(t: (en: string, fr: string) => string, value: string | null | undefined): string | null {
  const r = ambiguousReadings(value);
  if (!r) return null;
  const [big, small] = r.map((x) => qty(x));
  return t(`Say which quantity: ${big} or ${small}`, `Précisez la quantité\u00a0: ${big} ou ${small}`);
}

/** A chart label on up to two lines of 18 characters, split between words; only a longer name is cut with "…". */
export function axisLines(s: string, max = 18): string[] {
  const words = s.trim().split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${w}`.length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  if (lines.length <= 2 && lines.every((l) => l.length <= max)) return lines;
  const second = lines.slice(1).join(" ");
  const first = lines[0].length > max ? `${lines[0].slice(0, max - 1)}…` : lines[0];
  return lines[0].length > max ? [first] : [first, second.length > max ? `${second.slice(0, max - 1)}…` : second];
}

/**
 * A sale's franc rounding, signed as the books keep it (the "Arrondi FC" lines on exchange differences): +
 * when the shop kept a few francs (the customer handed over a little more, or a refund paid a little less),
 * − when it got a few francs less. The words say which, so the sign is never guessed: "−16 FC (−0,01 $)",
 * "en moins pour la boutique". `keptFc`, when the francs are known (at the till), comes first.
 */
export function fcRounding(t: (en: string, fr: string) => string, keptUsd: unknown, keptFc?: unknown): { figure: string; words: string; short: string } | null {
  const u = d(keptUsd);
  const f = keptFc === undefined || keptFc === null ? null : d(keptFc).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const francs = f && !f.isZero() ? f : null;
  if (u.isZero() && !francs) return null;
  const signed = (x: Decimal, text: string) => `${x.isNegative() ? MINUS : "+"}${text}`;
  const dollars = u.isZero() ? null : signed(u, usd(u.abs().toFixed(2)));
  const figure = francs ? `${signed(francs, cdf(francs.abs().toString()))}${dollars ? ` (${dollars})` : ""}` : dollars!;
  const kept = !(francs ?? u).isNegative();
  return {
    figure,
    words: kept ? t("kept by the shop", "en plus pour la boutique") : t("short for the shop", "en moins pour la boutique"),
    short: kept ? t("kept", "gardé") : t("short", "manquant"),
  };
}
