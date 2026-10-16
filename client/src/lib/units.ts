import { unitKey } from "@shared/units";
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
