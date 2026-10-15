import { num, qty } from "./format";

type T = (en: string, fr: string) => string;

/** The units the shop uses, stored by key; [singular, plural] in each language. */
export const UNITS = ["pcs", "set", "pair", "litre", "metre", "kg", "box", "roll"] as const;

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

/** Names typed in imports or older data, in either language, mapped to one key. */
const ALIASES: Record<string, string> = {
  pc: "pcs", piece: "pcs", pieces: "pcs", "pièce": "pcs", "pièces": "pcs", u: "pcs", unit: "pcs", "unité": "pcs",
  jeu: "set", jeux: "set", sets: "set", kit: "set",
  paire: "pair", paires: "pair", pairs: "pair",
  l: "litre", litres: "litre", liter: "litre", liters: "litre",
  m: "metre", "mètre": "metre", "mètres": "metre", metres: "metre", meter: "metre",
  carton: "box", cartons: "box", boxes: "box", boite: "box", "boîte": "box",
  rouleau: "roll", rouleaux: "roll", rolls: "roll",
};

export function unitKey(u: string | null | undefined): string {
  const k = (u ?? "").trim().toLowerCase();
  return NAMES[k] ? k : ALIASES[k] ?? k;
}

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
