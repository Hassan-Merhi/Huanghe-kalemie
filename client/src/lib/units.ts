import { unitKey, wholeUnit } from "@shared/units";
import { num, qty } from "./format";

type T = (en: string, fr: string) => string;

export { UNITS, knownUnit, unitKey, wholeUnit } from "@shared/units";

const NAMES: Record<string, { en: [string, string]; fr: [string, string] }> = {
  pcs: { en: ["piece", "pieces"], fr: ["pièce", "pièces"] },
  set: { en: ["set", "sets"], fr: ["jeu", "jeux"] },
  pair: { en: ["pair", "pairs"], fr: ["paire", "paires"] },
  litre: { en: ["litre", "litres"], fr: ["litre", "litres"] },
  metre: { en: ["metre", "metres"], fr: ["mètre", "mètres"] },
  kg: { en: ["kg", "kg"], fr: ["kg", "kg"] },
  box: { en: ["box", "boxes"], fr: ["carton", "cartons"] },
  roll: { en: ["roll", "rolls"], fr: ["rouleau", "rouleaux"] },
};

/** The unit's name in the interface language ("pièces", "jeu"); unknown units are shown as typed. */
export function unitLabel(t: T, u: string | null | undefined, n = 2): string {
  const names = NAMES[unitKey(u)];
  if (!names) return u ?? "";
  const plural = Math.abs(n) >= 2;
  return t(names.en[plural ? 1 : 0], names.fr[plural ? 1 : 0]);
}

/** "3 pièces", "1 jeu", "2,5 litres". */
export function qtyWithUnit(t: T, value: unknown, u: string | null | undefined): string {
  const label = unitLabel(t, u, num(value));
  return label ? `${qty(value)} ${label}` : qty(value);
}

/**
 * What a cart holds, as the till's footer says it: its lines, and the pieces of counted units when they are more
 * than the lines (5 × Pneu: "1 ligne · 5 pièces", as the sales list says Qté 5). Litres, metres and kilos stay
 * lines; counted units of several kinds are "unités".
 */
export function cartCount(t: T, lines: { qty: unknown; unit: string | null | undefined }[]): string {
  const n = lines.length;
  const text = t(`${n} ${n === 1 ? "line" : "lines"}`, `${n} ${n < 2 ? "ligne" : "lignes"}`);
  const counted = lines.filter((l) => wholeUnit(l.unit) && Number.isInteger(num(l.qty)) && num(l.qty) > 0);
  const pieces = counted.reduce((s, l) => s + num(l.qty), 0);
  if (pieces <= counted.length) return text;
  const kinds = new Set(counted.map((l) => unitKey(l.unit || "pcs")));
  const label = kinds.size === 1 ? unitLabel(t, Array.from(kinds)[0], pieces) : t("units", "unités");
  return `${text} · ${qty(pieces)} ${label}`;
}
