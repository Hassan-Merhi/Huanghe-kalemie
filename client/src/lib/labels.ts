type T = (en: string, fr: string) => string;

/** Role names as people say them. */
export function roleLabel(role: string, t: T) {
  const map: Record<string, [string, string]> = {
    owner: ["Owner", "Propriétaire"],
    // Both forms: the app does not know whether a woman or a man holds the role.
    manager: ["Manager", "Gérant(e)"],
    cashier: ["Cashier", "Caissier(ère)"],
    partner: ["Partner (read only)", "Associé(e) (lecture seule)"],
  };
  const m = map[role];
  return m ? t(m[0], m[1]) : role;
}

/** "Garage Mwamba", "garage mwamba" and "Garage  Mwambá" read as one name: case, accents, spaces and dots ignored. */
export function nameKey(name: string) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The last nine digits of a phone, so "+243 97 123 4567" and "0971234567" match; short numbers are not compared. */
export function phoneKey(phone: string | null | undefined) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(-9) : null;
}

/** A contact already saved under the same name (ignoring case, accents and spaces) or the same phone, other than `selfId`. */
export function duplicateParty<P extends { id: number; name: string; phone: string | null }>(parties: P[], input: { name: string; phone?: string | null; selfId?: number | null }) {
  const key = nameKey(input.name);
  const phone = phoneKey(input.phone);
  const others = parties.filter((p) => p.id !== input.selfId);
  const byName = key ? others.find((p) => nameKey(p.name) === key) : undefined;
  if (byName) return { party: byName, by: "name" as const };
  const byPhone = phone ? others.find((p) => phoneKey(p.phone) === phone) : undefined;
  return byPhone ? { party: byPhone, by: "phone" as const } : null;
}

/**
 * Accounts a manual entry (Écriture) cannot use: stock and goods in transit are kept by stock and the containers,
 * and the server refuses them (operations.ts manualJournal). Kept out of the Écriture account picker.
 */
export const JOURNAL_BLOCKED_KEYS: readonly string[] = ["inventory", "goods_in_transit"];

export function journalAccountAllowed(a: { systemKey?: string | null }): boolean {
  return !(a.systemKey && JOURNAL_BLOCKED_KEYS.includes(a.systemKey));
}

/** Why a manual entry line cannot use this account, as the server says it, or null when it can. */
export function journalAccountBlocked(a: { name: string; systemKey?: string | null } | undefined, t: T): string | null {
  if (!a || journalAccountAllowed(a)) return null;
  return t(`${a.name} is kept by stock and containers. Use a stock adjustment or the container screen.`, `${a.name} est tenu par le stock et les conteneurs. Utilisez un ajustement de stock ou l'écran des conteneurs.`);
}
