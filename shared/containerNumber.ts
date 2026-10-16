/**
 * Everything people put between the parts of a container number: any Unicode space (the
 * non-breaking space a French sheet pastes, the ideographic space…), zero-width and other invisible
 * format characters, every dash (en dash, minus sign…), dots, middle dots, slashes and underscores.
 */
const SEPARATORS = /[\p{White_Space}\p{Cf}\p{Pd}\p{Pc}−.·•․‧∙・。｡/\\⁄∕]/gu;

/**
 * The part of a container number that identifies it: capitals, without the spaces, dashes, dots or
 * slashes people type in between, so "HHU 2026 010", "hhu-2026-010" and "HHU 2026–010" are one
 * container. Full-width letters and digits count as the plain ones. This is the only place the key
 * is computed: the server compares it in JS, never with a database pattern that could disagree.
 */
export function containerNumberKey(number: string): string {
  return number.normalize("NFKC").toUpperCase().replace(SEPARATORS, "");
}
