type T = (en: string, fr: string) => string;

/** Role names as people say them. */
export function roleLabel(role: string, t: T) {
  const map: Record<string, [string, string]> = {
    owner: ["Owner", "Propriétaire"],
    manager: ["Manager", "Gérant"],
    cashier: ["Cashier", "Caissier"],
    partner: ["Partner (read only)", "Associé (lecture seule)"],
  };
  const m = map[role];
  return m ? t(m[0], m[1]) : role;
}
