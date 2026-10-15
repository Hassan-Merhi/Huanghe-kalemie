import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { accounts, categories, locations, partners, settings, users, type AccountType } from "@shared/schema";
import type { Tx } from "./db";
import { log } from "./log";

interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  systemKey?: string;
  isMoney?: boolean;
  currency?: "USD" | "CDF";
}

const CHART: SeedAccount[] = [
  { code: "1000", name: "Caisse USD", type: "asset", systemKey: "cash_usd", isMoney: true, currency: "USD" },
  { code: "1010", name: "Caisse FC", type: "asset", systemKey: "cash_cdf", isMoney: true, currency: "CDF" },
  { code: "1020", name: "M-Pesa", type: "asset", isMoney: true, currency: "USD" },
  { code: "1021", name: "Orange Money", type: "asset", isMoney: true, currency: "USD" },
  { code: "1022", name: "Airtel Money", type: "asset", isMoney: true, currency: "USD" },
  { code: "1030", name: "Banque", type: "asset", isMoney: true, currency: "USD" },
  { code: "1100", name: "Clients (créances)", type: "asset", systemKey: "receivables" },
  { code: "1200", name: "Stock de marchandises", type: "asset", systemKey: "inventory" },
  { code: "1300", name: "Marchandises en transit (frais de conteneur)", type: "asset", systemKey: "goods_in_transit" },
  { code: "2000", name: "Fournisseurs, agents et employés (dettes)", type: "liability", systemKey: "payables" },
  { code: "2100", name: "Retenues sur salaires à reverser", type: "liability", systemKey: "payroll_withheld" },
  { code: "3000", name: "Soldes d'ouverture", type: "equity", systemKey: "opening_equity" },
  { code: "4000", name: "Ventes", type: "income", systemKey: "sales" },
  { code: "4100", name: "Autres produits", type: "income", systemKey: "other_income" },
  { code: "4200", name: "Écarts de change", type: "income", systemKey: "fx" },
  { code: "5000", name: "Coût des articles vendus", type: "cost_of_sales", systemKey: "cogs" },
  { code: "5100", name: "Pertes et ajustements de stock", type: "cost_of_sales", systemKey: "stock_adjustments" },
  { code: "6000", name: "Loyer", type: "expense" },
  { code: "6010", name: "Salaires", type: "expense" },
  { code: "6020", name: "Électricité et eau", type: "expense" },
  { code: "6030", name: "Transport local", type: "expense" },
  { code: "6040", name: "Téléphone et internet", type: "expense" },
  { code: "6050", name: "Taxes et licences", type: "expense" },
  { code: "6060", name: "Réparations et entretien", type: "expense" },
  { code: "6070", name: "Carburant du groupe électrogène", type: "expense" },
  { code: "6090", name: "Autres frais de la boutique", type: "expense" },
];

const DEFAULT_CATEGORIES = ["Motos", "Pièces moteur", "Freins", "Pneus et chambres à air", "Électricité", "Carrosserie", "Huiles et lubrifiants", "Accessoires"];

export interface SetupOptions {
  ownerUsername?: string;
  ownerPassword?: string;
  partnerAName?: string;
  partnerBName?: string;
  locationName?: string;
}

/** Create what the app needs to run. Safe to run on every start. */
export async function ensureSetup(tx: Tx, opts: SetupOptions = {}) {
  for (const a of CHART) {
    const values = { code: a.code, name: a.name, type: a.type, systemKey: a.systemKey ?? null, isMoney: a.isMoney ?? false, currency: a.currency ?? "USD" };
    if (a.systemKey) {
      const [has] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, a.systemKey));
      if (has) continue;
      // A system account added in a later version: if the shop already uses its code, take the next free one.
      let code = Number(a.code);
      for (;;) {
        const [taken] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, String(code)));
        if (!taken) break;
        code += 1;
      }
      await tx.insert(accounts).values({ ...values, code: String(code) });
      continue;
    }
    await tx.insert(accounts).values(values).onConflictDoNothing();
  }

  const [{ count: locationCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(locations);
  if (locationCount === 0) {
    await tx.insert(locations).values({ name: opts.locationName ?? "Boutique Kalemie" });
  }

  const [{ count: categoryCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(categories);
  if (categoryCount === 0) {
    await tx.insert(categories).values(DEFAULT_CATEGORIES.map((name) => ({ name })));
  }

  const existingPartners = await tx.select().from(partners);
  if (existingPartners.length === 0) {
    const defs = [
      { name: opts.partnerAName ?? "Associé A", sharePct: "75.00", bears: true, code: "31" },
      { name: opts.partnerBName ?? "Associé B", sharePct: "25.00", bears: false, code: "32" },
    ];
    for (const d of defs) {
      const [capital] = await tx
        .insert(accounts)
        .values({ code: `${d.code}00`, name: `${d.name}\u00a0: capital`, type: "equity" })
        .returning();
      const [current] = await tx
        .insert(accounts)
        .values({ code: `${d.code}10`, name: `${d.name}\u00a0: compte de bénéfices`, type: "equity" })
        .returning();
      const [p] = await tx
        .insert(partners)
        .values({ name: d.name, sharePct: d.sharePct, bearsOperatingExpenses: d.bears, capitalAccountId: capital.id, currentAccountId: current.id })
        .returning();
      await tx.update(accounts).set({ partnerId: p.id }).where(sql`${accounts.id} in (${capital.id}, ${current.id})`);
    }
  }

  await tx.insert(settings).values({ key: "shopName", value: "Huanghe Motors Kalemie" }).onConflictDoNothing();
  await tx.insert(settings).values({ key: "defaultCdfRate", value: "2800" }).onConflictDoNothing();
  await tx.insert(settings).values({ key: "receiptFooter", value: "Merci pour votre achat\u00a0!" }).onConflictDoNothing();

  const [{ count: userCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
  if (userCount === 0) {
    const username = opts.ownerUsername ?? "admin";
    const password = opts.ownerPassword;
    if (!password) throw new Error("Set OWNER_PASSWORD to create the first owner account");
    await tx.insert(users).values({
      username,
      passwordHash: await bcrypt.hash(password, 12),
      fullName: "Propriétaire",
      role: "owner",
      language: "fr",
    });
    log(`Created owner account "${username}"`);
  }
}

export async function getSetting<T>(tx: Tx, key: string, fallback: T): Promise<T> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, key));
  return (row?.value as T) ?? fallback;
}
