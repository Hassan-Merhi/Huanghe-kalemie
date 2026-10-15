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
