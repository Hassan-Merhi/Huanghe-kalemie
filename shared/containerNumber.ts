/**
 * The part of a container number that identifies it: capitals, without the spaces, dashes, dots or
 * slashes people type in between, so "HHU 2026 010" and "hhu-2026-010" are one container.
 */
export function containerNumberKey(number: string): string {
  return number.toUpperCase().replace(/[\s\-_./]/g, "");
}
