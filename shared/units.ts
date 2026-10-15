/**
 * The units the shop uses, stored by key. Counted units (pieces, sets, pairs, boxes, rolls) only come
 * in whole numbers; litres, metres and kilos can be split. A unit typed that is none of these is
 * accepted with decimals, since there is no telling what it measures.
 */
export const UNITS = ["pcs", "set", "pair", "litre", "metre", "kg", "box", "roll"] as const;
export const COUNTED_UNITS = new Set(["pcs", "set", "pair", "box", "roll"]);

/** Names typed in imports or older data, in either language, mapped to one key. */
const ALIASES: Record<string, string> = {
  pc: "pcs", piece: "pcs", pieces: "pcs", "pièce": "pcs", "pièces": "pcs", u: "pcs", unit: "pcs", "unité": "pcs", "unités": "pcs",
  jeu: "set", jeux: "set", sets: "set", kit: "set",
  paire: "pair", paires: "pair", pairs: "pair",
  l: "litre", litres: "litre", liter: "litre", liters: "litre",
  m: "metre", "mètre": "metre", "mètres": "metre", metres: "metre", meter: "metre", meters: "metre",
  kilo: "kg", kilos: "kg", kgs: "kg",
  carton: "box", cartons: "box", boxes: "box", boite: "box", "boîte": "box", "boîtes": "box",
  rouleau: "roll", rouleaux: "roll", rolls: "roll",
};

export function unitKey(u: string | null | undefined): string {
  const k = (u ?? "").trim().toLowerCase();
  if ((UNITS as readonly string[]).includes(k)) return k;
  return ALIASES[k] ?? k;
}

/** True when the unit is counted in whole numbers (pieces, sets…). An empty unit means pieces. */
export function wholeUnit(u: string | null | undefined): boolean {
  return COUNTED_UNITS.has(unitKey(u || "pcs"));
}
