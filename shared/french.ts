/** Small French grammar helpers for text built from names and months. */

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10" → "octobre 2026" (French months are lower case in running text), or "October 2026". */
export function monthText(month: string, lang: "fr" | "en" = "fr"): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return month;
  return `${(lang === "fr" ? MONTHS_FR : MONTHS_EN)[m - 1]} ${y}`;
}

/** Elision before a vowel: "de" + "Associé A" → "d'Associé A", "de" + "septembre" → "de septembre". */
export function de(word: string): string {
  return /^[aeiouyàâäéèêëîïôöùûüœæ]/i.test(word.trim()) ? `d'${word.trim()}` : `de ${word.trim()}`;
}

/** "d'octobre 2026", "de septembre 2026". */
export function deMonth(month: string): string {
  return de(monthText(month, "fr"));
}

/** First letter upper case, for a month or name that starts a title or a cell. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const NB = "\u00a0";

/**
 * A number written the French way: "1 800,00", "45 000,5", with a no-break space between thousands.
 * `decimals` fixes the decimals; left out, the number keeps its own (trailing zeros dropped).
 */
export function frNumber(value: { toString(): string } | number | string, decimals?: number): string {
  const n = Number(String(value));
  if (!Number.isFinite(n)) return String(value);
  let text = decimals === undefined ? String(value).trim() : n.toFixed(decimals);
  if (decimals === undefined && /^-?\d+\.\d*?0+$/.test(text)) text = text.replace(/\.?0+$/, "");
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return String(value);
  const [, sign, int, frac] = m;
  return `${sign ? "\u2212" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, NB)}${frac ? `,${frac}` : ""}`;
}

/** An amount with its currency, as the shop writes it: "1 800,00 $", "45 000 FC", "50 550,00 ¥". */
export function frMoney(value: { toString(): string } | number | string, currency: string = "USD"): string {
  if (currency === "CDF") return `${frNumber(value, 0)}${NB}FC`;
  return `${frNumber(value, 2)}${NB}${currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency}`;
}

/** "2026-10-15" → "15/10/2026". */
export function frDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * French spacing in a sentence: a no-break space before : ; ! ? and %, so "Solde insuffisant : il manque"
 * never breaks before the colon. Used on every French message the server sends.
 */
export function frenchSpacing(text: string): string {
  return text.replace(/(?<=[^\s\u00a0])[ \u202f]?([:;!?%])(?=\s|$|[.,)])/g, `${NB}$1`);
}
