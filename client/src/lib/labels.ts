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
