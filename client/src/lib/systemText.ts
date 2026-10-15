import { useI18n } from "./i18n";

/**
 * English for the French texts the server writes itself: the default account names and the journal
 * memos it generates ("Vente S-000026", "Arrondi FC"). Anything typed by a person (a reason, a
 * description, a renamed account) is kept as it is; only the generated words around it change.
 */
const ACCOUNTS: Record<string, string> = {
  "Caisse USD": "Cash USD",
  "Caisse FC": "Cash FC",
  Banque: "Bank",
  "Clients (créances)": "Customers (receivables)",
  "Stock de marchandises": "Stock of goods",
  "Marchandises en transit (frais de conteneur)": "Goods in transit (container costs)",
  "Fournisseurs, agents et employés (dettes)": "Suppliers, agents and employees (payables)",
  "Retenues sur salaires à reverser": "Salary withholdings to pay over",
  "Soldes d'ouverture": "Opening balances",
  Ventes: "Sales",
  "Autres produits": "Other income",
  "Écarts de change": "Exchange differences",
  "Coût des articles vendus": "Cost of goods sold",
  "Pertes et ajustements de stock": "Stock losses and adjustments",
  Loyer: "Rent",
  Salaires: "Salaries",
  "Électricité et eau": "Electricity and water",
  "Transport local": "Local transport",
  "Téléphone et internet": "Phone and internet",
  "Taxes et licences": "Taxes and licences",
  "Réparations et entretien": "Repairs and maintenance",
  "Carburant du groupe électrogène": "Generator fuel",
  "Autres frais de la boutique": "Other shop costs",
  "Autres associés": "Other partners",
};

const MEMOS: Record<string, string> = {
  "Avance imputée": "Advance applied",
  "Monnaie rendue": "Change given back",
  "Arrondi FC": "FC rounding",
  "Écart de change (coût moyen des devises)": "Exchange difference (average cost of the currency)",
  "Écart de change": "Exchange difference",
  "Écart de change de réévaluation": "Revaluation exchange difference",
  "Stock ajouté": "Stock added",
  "Stock retiré": "Stock removed",
  Transfert: "Transfer",
  "Mouvement d'un autre associé": "Another partner's movement",
  "Avance rendue : la facture est annulée": "Advance returned: the bill is cancelled",
  "Avance rendue\u00a0: la facture est annulée": "Advance returned: the bill is cancelled",
  "Frais de conteneur supprimé": "Container cost deleted",
  "Change USD en FC": "USD changed into FC",
  "Écart de coût à l'annulation (le stock de ces articles a changé depuis le déchargement)": "Cost difference on undoing (the stock of these items changed since the offload)",
};

const MONTHS: Record<string, string> = {
  janvier: "January", février: "February", mars: "March", avril: "April", mai: "May", juin: "June",
  juillet: "July", août: "August", septembre: "September", octobre: "October", novembre: "November", décembre: "December",
};
const month = (s: string) => s.replace(/\b(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b/g, (m) => MONTHS[m] ?? m);
/** "de X", "d'X", "du X", "des X" → "X". */
const of = (s: string) => s.replace(/^(?:de |d'|d’|du |des )/, "");
const C = "\\s?:\\s"; // " : ", with a plain or a no-break space before the colon

const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [new RegExp(`^Vente (\\S+) annulée${C}(.*)$`, "s"), (n, r) => `Sale ${n} cancelled: ${r}`],
  [/^Vente (\S+)$/, (n) => `Sale ${n}`],
  [new RegExp(`^Retour (\\S+) sur la vente (\\S+)${C}(.*)$`, "s"), (n, s, r) => `Return ${n} on sale ${s}: ${r}`],
  [/^Retour (\S+) sur la vente (\S+)$/, (n, s) => `Return ${n} on sale ${s}`],
  [/^Paiement à (.+)$/s, (p) => `Payment to ${p}`],
  [/^Paiement de (.+)$/s, (p) => `Payment from ${p}`],
  [/^Contre-passation de (\S+)$/, (n) => `Reversal of ${n}`],
  [/^Annulation du déchargement du conteneur (\S+)$/, (n) => `Offload of container ${n} undone`],
  [/^Déchargement du conteneur (\S+)$/, (n) => `Offload of container ${n}`],
  [/^Facture fournisseur (\S+)$/, (n) => `Supplier invoice ${n}`],
  [new RegExp(`^Dépense annulée${C}(.*)$`, "s"), (d) => `Expense cancelled: ${d}`],
  [/^Apport en capital ((?:de |d'|d’|du |des ).+)$/s, (p) => `Capital put in by ${of(p)}`],
  [/^Retrait ((?:de |d'|d’|du |des ).+)$/s, (p) => `Withdrawal by ${of(p)}`],
  [/^Annulation des salaires (.+)$/, (m) => `Salaries of ${month(m)} cancelled`],
  [/^Retenues sur salaires (\S+ \d{4}|\d{4}-\d{2})$/, (m) => `Salary withholdings ${month(m)}`],
  [/^Salaires? (\S+ \d{4}|\d{4}-\d{2})$/, (m) => `Salaries ${month(m)}`],
  [new RegExp(`^Clôture (.+?)${C}partage du bénéfice entre associés$`), (m) => `Close of ${month(of(m))}: profit split between partners`],
  [new RegExp(`^Réouverture (.+?)${C}annulation de la réévaluation$`), (m) => `Reopening of ${month(of(m))}: revaluation undone`],
  [/^Réouverture (.+)$/, (m) => `Reopening of ${month(of(m))}`],
  [/^Réévaluation au taux de fin de mois (.*)$/, (r) => `Month-end revaluation ${r}`],
  [/^Réévaluation des devises au (.*)$/, (r) => `Currency revaluation on ${r}`],
];

export function memoText(text: string | null | undefined, lang: string): string {
  if (!text || lang !== "en") return text ?? "";
  if (MEMOS[text]) return MEMOS[text];
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(text);
    if (m) return fn(...m.slice(1));
  }
  // "ADJ-000001 : Inventaire", "CDF-A6 : Fret": a generated number before the no-break colon.
  const numbered = /^(\S+)\u00a0: (.*)$/s.exec(text);
  if (numbered) return `${numbered[1]}: ${numbered[2]}`;
  return text;
}

export function accountText(name: string | null | undefined, lang: string): string {
  if (!name || lang !== "en") return name ?? "";
  if (ACCOUNTS[name]) return ACCOUNTS[name];
  // A partner's accounts: "Associé A : capital", "Associé A : compte de bénéfices".
  const m = new RegExp(`^(.*?)${C}(capital|compte de bénéfices)$`).exec(name);
  if (m) return `${m[1]}: ${m[2] === "capital" ? "capital" : "profit account"}`;
  return name;
}

/** The two helpers bound to the current language. */
export function useSystemText() {
  const { lang } = useI18n();
  return { memo: (s: string | null | undefined) => memoText(s, lang), account: (s: string | null | undefined) => accountText(s, lang) };
}
