import Decimal from "decimal.js";
import { shownUnitCost } from "@shared/money";

/**
 * A number typed by a person, French or English style: "4,50", "4.50", "1 234,5", "1.234,5", "1,234.5", "0,1389".
 * Spaces group thousands. With both "," and "." the last one is the decimal mark. With only one kind:
 * one mark is the decimal mark ("2,5" = 2.5, "1.234" = 1.234 as the server writes quantities), several
 * group thousands ("1.234.567"); in English a single "," before exactly three digits groups thousands.
 * A leading "+", "-" or "−" (U+2212) gives the sign. Text with no digit at all ("," or ".") is not a number.
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
  // A lone "," or "." (or "-,") has no digit: not a number, never 0.
  if (!/\d/.test(s)) return null;
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
 * What a number field holds: an amount in dollars, yuan or francs, a percentage, an exchange rate (any
 * currency sign is fine there: "2 850 FC/$") or a plain count (quantities, weights).
 */
export type FieldUnit = "USD" | "CNY" | "CDF" | "pct" | "rate" | "qty";
type TypedUnit = "USD" | "CNY" | "CDF" | "pct";

/** The units typed with a number ("500 FC", "10 %", "22 $", "¥ 40"), in the order they are written. */
function typedUnits(value: string): TypedUnit[] {
  return (String(value).match(/FC|CDF|USD|CNY|RMB|\$|¥|%/gi) ?? []).map((u) => {
    const k = u.toUpperCase();
    return k === "FC" || k === "CDF" ? "CDF" : k === "$" || k === "USD" ? "USD" : k === "%" ? "pct" : "CNY";
  });
}

/**
 * A unit typed that is not the field's own: "500 FC" in a dollar field, "20 $" in a franc one, "10 %" in an
 * amount or a quantity, "5 $" in a percentage. parseNumberInput drops units, so without this "61800 FC" in
 * "Montant en $" was read as 61 800 $ and "10%" in "Remise $" as 10 $. Returns the unit to refuse, else null.
 */
export function unitMismatch(value: string, field: FieldUnit): TypedUnit | null {
  for (const u of typedUnits(value)) {
    if (field === "rate") {
      if (u === "pct") return u;
    } else if (field === "pct") {
      if (u !== "pct") return u;
    } else if (u !== field) return u;
  }
  return null;
}

/**
 * "10 %" typed in a discount: that share of `base` (the line or the sale), to the cent half up, as plain text
 * ("2.20" for 10 % of 22 $). Null when the text is not a percentage of a readable number.
 */
export function percentOf(value: string, base: unknown): string | null {
  const s = String(value).replace(/[\s  ]/g, "");
  if (!/^[^%]*\d[^%]*%$/.test(s) || typedUnits(s).length !== 1) return null;
  const p = parseNumberInput(s.slice(0, -1));
  if (!p || p.startsWith("-")) return null;
  return new Decimal(p).times(new Decimal(num(base))).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * What a field says when it refuses a unit (see unitMismatch). `switchTo` names where the other currency is
 * typed, when the page has one: "Ce champ est en dollars : pour des francs, choisissez Caisse FC".
 */
export function unitMismatchText(typed: TypedUnit, field: FieldUnit, switchTo?: string | null): string {
  const fr = lang === "fr";
  const names: Record<string, [string, string]> = { USD: ["dollars", "dollars"], CNY: ["yuan", "yuans"], CDF: ["francs", "francs"] };
  const signs: Record<string, string> = { USD: "$", CNY: "¥", CDF: "FC" };
  if (field === "pct") return fr ? "Ce champ est en % : écrivez un nombre, sans devise" : "This field is a percentage: type a number, with no currency";
  if (field === "rate") return fr ? "Pas de % dans un taux : écrivez le nombre de francs ou de yuans pour 1 $" : "No % in a rate: type the francs or yuan for $1";
  if (field === "qty") return typed === "pct"
    ? fr ? "Pas de % ici : écrivez un nombre" : "No % here: type a number"
    : fr ? "Pas de devise ici : écrivez un nombre" : "No currency here: type a number";
  const [en, fra] = names[field];
  if (typed === "pct") return fr ? `Pas de % ici : écrivez le montant en ${signs[field]}` : `No % here: type the amount in ${signs[field]}`;
  const [oen, ofr] = names[typed];
  return switchTo
    ? fr ? `Ce champ est en ${fra} : pour des ${ofr}, choisissez ${switchTo}` : `This field is in ${en}: for ${oen}, choose ${switchTo}`
    : fr ? `Ce champ est en ${fra} : écrivez le montant en ${signs[field]}` : `This field is in ${en}: type the amount in ${signs[field]}`;
}

/**
 * What a field passes up when it refuses a unit: the text with a "!" ("500FC!"), which is no plain number and
 * which d() reads as 0 (without it "500 FC" would read as 500); refusedUnit gives the unit back.
 */
export function unitRefusedText(typed: string): string {
  return `${typed.replace(/[\s  ]/g, "")}!`;
}

/** The unit a field refused, from what it passed up (see unitRefusedText), for the page's own message. */
export function refusedUnit(value: string | null | undefined, field: FieldUnit): TypedUnit | null {
  const v = (value ?? "").trim();
  return v.endsWith("!") ? unitMismatch(v.slice(0, -1), field) : null;
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
 * With `strict` (dollar and yuan fields, whole quantities) a stored 4.125 is shown "4,1250", not "4,125",
 * which the field would question as 4 125 or 4,125 (see ambiguousDollars).
 */
export function inputText(value: string | null | undefined, opts: { strict?: boolean } = {}): string {
  const v = (value ?? "").trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) return value ?? "";
  const [, sign, int, frac] = m;
  const kept = frac && /[1-9]/.test(frac) ? frac : "";
  const fraction = opts.strict && kept.length === 3 && /^[1-9]\d{0,2}$/.test(int) ? `${kept}0` : kept;
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

/** A rate as people say it: "1 $ = 2 820 FC" in French, "$1 = 2,820 FC" in English (sign: FC, ¥, CNY). */
export function dollarRate(value: unknown, sign = "FC"): string {
  return lang === "fr" ? `1${NB}$ = ${qty(value)}${NB}${sign}` : `$1 = ${qty(value)} ${sign}`;
}

/**
 * A dollar or yuan amount with every decimal it has, cents at least: 4,125 ¥ and 1,20 $, never 4,13 ¥.
 * For the small reading of an ambiguous amount, so the question offers the value typed.
 */
export function exactMoney(value: unknown, currency: string = "USD"): string {
  if (currency === "CDF") return cdf(value);
  const n = num(value);
  const body = nf(2, 4).format(Math.abs(n));
  return currency === "USD" ? withDollar(n, body) : `${n < 0 ? MINUS : ""}${body}${NB}${currency === "CNY" ? "¥" : currency}`;
}

/** How a currency is written in the shop: FC and $, never CDF / USD. */
export function curLabel(currency: string | null | undefined): string {
  return currency === "CDF" ? "FC" : currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency ?? "";
}

/**
 * An amount typed for one paying account, carried over when the account changes to one in another currency:
 * 6 000 $ from the dollar box are 16 848 000 FC from the franc box at 2 808, not 6 000 FC. Francs are whole,
 * dollars to the cent. "" stays "", the same currency keeps the amount as typed; null when it cannot be
 * converted (no rate, an amount that cannot be read, a currency other than $ and FC): the caller clears it.
 */
export function convertTypedAmount(amount: string, from: string | null | undefined, to: string | null | undefined, cdfPerUsd: unknown): string | null {
  const typed = amount.trim();
  if (!typed || !from || !to || from === to) return amount;
  if (!/^\d+(\.\d+)?$/.test(typed)) return null;
  const rate = d(cdfPerUsd);
  if (!rate.gt(0)) return null;
  const value = new Decimal(typed);
  if (from === "USD" && to === "CDF") return value.times(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString();
  if (from === "CDF" && to === "USD") return value.dividedBy(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return null;
}

/** What a form says under its account once amounts were converted (or cleared) on a change of currency. */
export function convertedNote(t: (en: string, fr: string) => string, to: string, cdfPerUsd: unknown, converted: boolean, many = false): string {
  const rate = `${qty(cdfPerUsd)}${NB}FC`;
  if (!converted) {
    return many
      ? t(`Amounts cleared: enter them in ${curLabel(to)}.`, `Montants effacés\u00a0: saisissez-les en ${curLabel(to)}.`)
      : t(`Amount cleared: enter it in ${curLabel(to)}.`, `Montant effacé\u00a0: saisissez-le en ${curLabel(to)}.`);
  }
  return many
    ? t(`Amounts converted at the day's rate (${rate} per $1): check them.`, `Montants convertis au taux du jour (${rate} pour 1\u00a0$)\u00a0: vérifiez-les.`)
    : t(`Amount converted at the day's rate (${rate} per $1): check it.`, `Montant converti au taux du jour (${rate} pour 1\u00a0$)\u00a0: vérifiez-le.`);
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

/**
 * A gap between two rates as a whole percent ("4 %"), with one decimal (two if need be) when the whole
 * figure would read as one of `limits` it is not: 5,06 % against a 5 % limit is "5,1 %" and 4,9 % is
 * "4,9 %", never both "5 %".
 */
export function gapPct(gap: Decimal, limits: Decimal[] = []): string {
  const looksLike = (places: number) => limits.some((l) => !gap.equals(l) && gap.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).equals(l));
  const places = !looksLike(0) ? 0 : !looksLike(1) ? 1 : 2;
  return pct(gap.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toString(), places, places);
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
 * Unit costs keep more precision where it means something: cents always, and up to four decimals when a
 * cost under 10 $ is not whole cents, trailing zeros trimmed (4,125 $ and 0,125 $; 12,00 $ and 0,50 $). From
 * 10 $ up the cent is enough: a motorcycle at 1 098,0495 $ reads 1 098,05 $. Display only: the value stays exact.
 */
export function unitCost(value: unknown): string {
  const n = num(value);
  return withDollar(n, (Math.abs(n) >= 10 ? nf(2, 2) : nf(2, 4)).format(Math.abs(n)));
}

/** A variant's average cost by the rule of Stock › Valorisation: its value to the cent over its quantity, 0,125 $ and not 0,1244 $ (nor 0,13 $ for 1 L entered at 0,125 $). */
export function variantUnitCost(v: { avgCost: unknown; stockValue?: string | null; stockQty?: string | null; keptUnitCost?: string | null }): string {
  if (v.stockValue != null && v.stockQty != null && new Decimal(num(v.stockQty)).gt(0)) return unitCost(shownUnitCost(v.stockValue, v.stockQty, v.keptUnitCost).toString());
  return unitCost(v.avgCost);
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
/** "4 134,83 $ (29 440,00 ¥)": the dollars of an advance applied, with the yuan or francs it settled. */
export function advanceText(a: { usd: string; cny?: string; cdf?: string }) {
  const native = [a.cny ? money(a.cny, "CNY") : null, a.cdf ? cdf(a.cdf) : null].filter(Boolean).join(", ");
  return `${usd(a.usd)}${native ? ` (${native})` : ""}`;
}

export function usdPerUnit(perUsd: string | null | undefined): string {
  const x = d(perUsd);
  return x.gt(0) ? d(1).dividedBy(x).toDecimalPlaces(12).toString() : "";
}

/**
 * Why the server would refuse a container's rate, said under the field before "Créer" (null when it takes it).
 * The same checks as assertContainerRate, on the USD-per-unit value sent: with no yuan rate on file, a rate
 * a yuan cannot have (outside 4 to 12,5 ¥ for 1 $: "0,138" typed upside down); with one on file, a gap above
 * the larger of the tolerance and 5 %. `rateToUsd` is the value sent (usdPerUnit of the typed rate).
 */
export function containerRateRefusal(
  t: (en: string, fr: string) => string,
  currency: string,
  rateToUsd: string | null | undefined,
  onFile: string | null | undefined,
  tolerancePct: unknown,
): string | null {
  const rate = d(rateToUsd);
  if (currency === "USD" || !rate.gt(0)) return null;
  const sign = currency === "CDF" ? "FC" : "¥";
  const shown = perUsdText(rate.toString());
  if (!onFile || !d(onFile).gt(0)) {
    if (currency !== "CNY" || (rate.gte("0.08") && rate.lte("0.25"))) return null;
    return t(
      `${shown} CNY for $1 looks wrong: one dollar buys about 7.1 CNY. Give how many yuan one dollar buys.`,
      `${qty(shown)}\u00a0¥ pour 1\u00a0$ semble faux\u00a0: un dollar vaut environ 7,1\u00a0¥. Indiquez combien de yuans vaut 1\u00a0$.`,
    );
  }
  const reference = d(1).dividedBy(d(onFile));
  const limit = Decimal.max(d(tolerancePct ?? 3), 5);
  if (!rate.minus(reference).abs().dividedBy(reference).times(100).gt(limit)) return null;
  return t(
    `More than ${limit.toString()}% away from the rate on file ($1 = ${qty(onFile)} ${sign}): check the invoice, or update the day's rate first`,
    `Plus de ${pct(limit.toString(), 2)} d'écart avec le taux enregistré (1\u00a0$ = ${qty(onFile)}\u00a0${sign})\u00a0: vérifiez la facture, ou mettez d'abord à jour le taux du jour`,
  );
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
 * The francs a sale kept, net of its refunds, when they are below zero: a refund at a higher rate than the
 * sale's gave back more francs than were paid (70 200 FC in, 71 200 FC out), though at the refund's rate the
 * shop kept a few cents. Said in francs, as the drawer counts it, so it never reads as money kept:
 * "Francs −1 000 FC (écart de taux)". Null when the francs net to zero or more.
 */
export function fcRateGap(t: (en: string, fr: string) => string, netFc: unknown): { figure: string; words: string } | null {
  const f = d(netFc).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (!f.isNegative()) return null;
  return {
    figure: t(`Francs ${MINUS}${cdf(f.abs().toString())} (rate difference)`, `Francs ${MINUS}${cdf(f.abs().toString())} (écart de taux)`),
    words: t("More francs handed back than the customer paid: the refund went at a higher rate than the sale", "Plus de francs rendus que le client n'en a payé\u00a0: le remboursement s'est fait à un taux plus haut que la vente"),
  };
}

/**
 * The highest whole rate at which a franc refund of `toCashUsd`, rounded down to 100 FC as the server pays it
 * out, is still at most `fcLeft` (the francs the customer paid and has not had back), with the francs it really
 * gives: 22 $ and 61 800 FC left → 2 813 (61 886 → 61 800 FC), not 2 809 (61 798 → 61 700 FC). Null when no
 * rate above zero gives anything back within it.
 */
export function fcRefundCap(toCashUsd: unknown, fcLeft: unknown): { rate: Decimal; francs: Decimal } | null {
  const usdBack = d(toCashUsd);
  const left = d(fcLeft);
  if (!usdBack.gt(0) || left.lt(100)) return null;
  // floor(usd × rate / 100) × 100 ≤ left exactly when usd × rate < (floor(left / 100) + 1) × 100.
  const ceiling = left.dividedBy(100).toDecimalPlaces(0, Decimal.ROUND_FLOOR).plus(1).times(100);
  const rate = ceiling.dividedBy(usdBack).toDecimalPlaces(0, Decimal.ROUND_CEIL).minus(1);
  if (!rate.gt(0)) return null;
  const francs = usdBack.times(rate).dividedBy(100).toDecimalPlaces(0, Decimal.ROUND_FLOOR).times(100);
  return francs.gt(0) ? { rate, francs } : null;
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
