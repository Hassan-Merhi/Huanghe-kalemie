import { and, asc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { categories, locations, motorcycleUnits, products, stockLevels, variants } from "@shared/schema";
import { dec } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { nextNumber } from "./ledger";
import { keptUnitCosts } from "./stock";
import { wholeUnit } from "@shared/units";

export interface VariantInput {
  sku?: string | null;
  barcode?: string | null;
  attributes?: Record<string, string>;
  sellPrice?: string | null;
  reorderLevel?: string | null;
  active?: boolean;
}

export interface ProductInput {
  name: string;
  categoryId?: number | null;
  brand?: string | null;
  unit?: string | null;
  description?: string | null;
  tracksSerials?: boolean;
  active?: boolean;
}

function cleanAttributes(attrs: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const key = k.trim();
    const value = String(v ?? "").trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function variantLabel(attributes: Record<string, string> | null | undefined): string {
  const values = Object.values(attributes ?? {});
  return values.length ? values.join(" / ") : "Standard";
}

async function uniqueSku(tx: Tx, requested: string | null | undefined): Promise<string> {
  const sku = requested?.trim().toUpperCase();
  if (sku) return sku;
  return nextNumber(tx, "sku", "HK-", 5);
}

async function insertVariant(tx: Tx, productId: number, v: VariantInput) {
  const sku = await uniqueSku(tx, v.sku);
  const barcode = v.barcode?.trim() || null;
  const dup = await tx
    .select({ id: variants.id, sku: variants.sku, barcode: variants.barcode })
    .from(variants)
    .where(barcode ? or(eq(variants.sku, sku), eq(variants.barcode, barcode)) : eq(variants.sku, sku));
  if (dup.length) {
    const skuTaken = dup[0].sku === sku;
    throw conflict(
      skuTaken ? `SKU ${sku} is already used` : `Barcode ${barcode} is already used`,
      skuTaken ? `Le SKU ${sku} est déjà utilisé` : `Le code-barres ${barcode} est déjà utilisé`,
    );
  }
  if (dec(v.sellPrice ?? 0).isNegative()) throw badRequest("Price cannot be negative", "Le prix ne peut pas être négatif");
  const [row] = await tx
    .insert(variants)
    .values({
      productId,
      sku,
      barcode,
      attributes: cleanAttributes(v.attributes),
      sellPrice: dec(v.sellPrice ?? 0).toFixed(2),
      reorderLevel: dec(v.reorderLevel ?? 0).toFixed(3),
      active: v.active ?? true,
    })
    .returning();
  return row;
}

/**
 * A blank brand is "Huanghe" when a new item is typed on the item form (it says so); editing keeps a blank one
 * blank (updateProduct). The stock import passes
 * `defaultBrand: ""` so a sheet's empty "Marque" stays empty rather than reading "Huanghe · litres".
 */
export async function createProduct(tx: Tx, input: ProductInput & { variants: VariantInput[] }, opts: { defaultBrand?: string } = {}) {
  if (!input.name.trim()) throw badRequest("Name is required", "Le nom est obligatoire");
  if (input.variants.length === 0) throw badRequest("Add at least one variant (use one with no size if the item has none)", "Ajoutez au moins une variante (une sans taille si l'article n'en a pas)");
  if (input.categoryId) {
    const [c] = await tx.select().from(categories).where(eq(categories.id, input.categoryId));
    if (!c) throw badRequest("Category not found", "Catégorie introuvable");
  }
  const [product] = await tx
    .insert(products)
    .values({
      name: input.name.trim(),
      categoryId: input.categoryId ?? null,
      brand: input.brand?.trim() || (opts.defaultBrand ?? "Huanghe"),
      unit: input.unit?.trim() || "pcs",
      description: input.description ?? null,
      tracksSerials: input.tracksSerials ?? false,
    })
    .returning();
  for (const v of input.variants) await insertVariant(tx, product.id, v);
  return getProduct(tx, product.id);
}

function conflictStock() {
  return conflict(
    "This item still has stock. Sell it or write it off with a stock adjustment before deactivating it.",
    "Cet article a encore du stock. Vendez-le ou sortez-le par un ajustement de stock avant de le désactiver.",
  );
}

export async function updateProduct(tx: Tx, id: number, input: Partial<ProductInput>) {
  const [existing] = await tx.select().from(products).where(eq(products.id, id));
  if (!existing) throw notFound("Product", "Article introuvable");
  if (input.tracksSerials !== undefined && input.tracksSerials !== existing.tracksSerials) {
    const [stock] = await tx
      .select({ qty: sql<string>`coalesce(sum(${variants.stockQty}), 0)` })
      .from(variants)
      .where(eq(variants.productId, id));
    if (!dec(stock.qty).isZero()) throw conflict("Chassis tracking can only be changed while the item has no stock", "Le suivi par châssis ne peut être modifié que lorsque l'article n'a pas de stock");
  }
  if (input.unit !== undefined && wholeUnit(input.unit?.trim() || "pcs") && !wholeUnit(existing.unit)) {
    // Pieces are counted whole: a part of a litre on hand could then never be sold or counted.
    const [part] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockLevels)
      .innerJoin(variants, eq(variants.id, stockLevels.variantId))
      .where(and(eq(variants.productId, id), sql`${stockLevels.qty} <> trunc(${stockLevels.qty})`));
    if (part.n > 0) {
      throw conflict(
        "Some variants hold part of a unit. Adjust the stock to whole numbers before switching to a unit counted in whole pieces.",
        "Certaines variantes ont une fraction d'unité en stock. Ajustez le stock en nombres entiers avant de passer à une unité comptée à la pièce.",
      );
    }
  }
  if (input.active === false && existing.active) {
    const [stock] = await tx
      .select({ qty: sql<string>`coalesce(sum(abs(${variants.stockQty})), 0)`, value: sql<string>`coalesce(sum(abs(${variants.stockValue})), 0)` })
      .from(variants)
      .where(eq(variants.productId, id));
    if (!dec(stock.qty).isZero() || !dec(stock.value).isZero()) throw conflictStock();
  }
  if (input.categoryId) {
    const [c] = await tx.select().from(categories).where(eq(categories.id, input.categoryId));
    if (!c) throw badRequest("Category not found", "Catégorie introuvable");
  }
  await tx
    .update(products)
    .set({
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      // Emptied (or left blank) on the edit form, a brand stays empty: only a new item from the form is "Huanghe".
      ...(input.brand !== undefined && { brand: input.brand?.trim() ?? "" }),
      ...(input.unit !== undefined && { unit: input.unit?.trim() || "pcs" }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.tracksSerials !== undefined && { tracksSerials: input.tracksSerials }),
      ...(input.active !== undefined && { active: input.active }),
    })
    .where(eq(products.id, id));
  return getProduct(tx, id);
}

export async function addVariant(tx: Tx, productId: number, input: VariantInput) {
  const [p] = await tx.select().from(products).where(eq(products.id, productId));
  if (!p) throw notFound("Product", "Article introuvable");
  await insertVariant(tx, productId, input);
  return getProduct(tx, productId);
}

export async function updateVariant(tx: Tx, id: number, input: VariantInput) {
  const [existing] = await tx.select().from(variants).where(eq(variants.id, id));
  if (!existing) throw notFound("Variant", "Variante introuvable");
  const sku = input.sku?.trim().toUpperCase();
  const barcode = input.barcode === undefined ? undefined : input.barcode?.trim() || null;
  if (sku && sku !== existing.sku) {
    const [d] = await tx.select({ id: variants.id }).from(variants).where(eq(variants.sku, sku));
    if (d) throw conflict(`SKU ${sku} is already used`, `Le SKU ${sku} est déjà utilisé`);
  }
  if (barcode && barcode !== existing.barcode) {
    const [d] = await tx.select({ id: variants.id }).from(variants).where(eq(variants.barcode, barcode));
    if (d) throw conflict(`Barcode ${barcode} is already used`, `Le code-barres ${barcode} est déjà utilisé`);
  }
  if (input.active === false && existing.active && (!dec(existing.stockQty).isZero() || !dec(existing.stockValue).isZero())) throw conflictStock();
  if (input.sellPrice != null && dec(input.sellPrice).isNegative()) throw badRequest("Price cannot be negative", "Le prix ne peut pas être négatif");
  const changes = {
      ...(sku && { sku }),
      ...(barcode !== undefined && { barcode }),
      ...(input.attributes !== undefined && { attributes: cleanAttributes(input.attributes) }),
      ...(input.sellPrice != null && { sellPrice: dec(input.sellPrice).toFixed(2) }),
      ...(input.reorderLevel != null && { reorderLevel: dec(input.reorderLevel).toFixed(3) }),
      ...(input.active !== undefined && { active: input.active }),
  };
  if (Object.keys(changes).length === 0) throw badRequest("Nothing to change", "Rien à modifier");
  await tx.update(variants).set(changes).where(eq(variants.id, id));
  return getProduct(tx, existing.productId);
}

export async function getProduct(tx: Tx, id: number) {
  const [product] = await tx.select().from(products).where(eq(products.id, id));
  if (!product) throw notFound("Product", "Article introuvable");
  const vs = await tx.select().from(variants).where(eq(variants.productId, id)).orderBy(asc(variants.id));
  const levels = vs.length
    ? await tx.select().from(stockLevels).where(inArray(stockLevels.variantId, vs.map((v) => v.id)))
    : [];
  const kept = await keptUnitCosts(tx, vs.map((v) => v.id));
  return {
    ...product,
    variants: vs.map((v) => ({
      ...v,
      label: variantLabel(v.attributes),
      avgCost: dec(v.stockQty).isZero() ? "0.000000" : dec(v.stockValue).dividedBy(v.stockQty).toFixed(6),
      // The cost per unit shown for it (see shownUnitCost): a cost, so never to a cashier.
      keptUnitCost: kept.get(v.id) ?? null,
      levels: levels.filter((l) => l.variantId === v.id),
    })),
  };
}

export async function listProducts(tx: Tx, opts: { search?: string; categoryId?: number; includeInactive?: boolean }) {
  const term = opts.search?.trim();
  const conds = [];
  if (!opts.includeInactive) conds.push(eq(products.active, true));
  if (opts.categoryId) conds.push(eq(products.categoryId, opts.categoryId));
  if (term) {
    const haystack = fold(
      sql`${products.name} || ' ' || coalesce(${categories.name}, '') || ' ' || coalesce(${products.brand}, '') || ' ' || coalesce((select string_agg(v.sku || ' ' || coalesce(v.barcode, '') || ' ' || v.attributes::text, ' ') from ${variants} v where v.product_id = "products"."id"), '')`,
    );
    const words = term.split(/\s+/).filter(Boolean).slice(0, 6);
    conds.push(and(...words.map((w) => or(...searchAlternatives(w).map((alt) => sql`${haystack} like ${`%${alt}%`}`))!))!);
  }
  const rows = await tx
    .select({
      product: products,
      categoryName: categories.name,
      variantCount: sql<number>`(select count(*)::int from ${variants} v where v.product_id = "products"."id")`,
      stockQty: sql<string>`(select coalesce(sum(v.stock_qty), 0) from ${variants} v where v.product_id = "products"."id")`,
      stockValue: sql<string>`(select coalesce(sum(v.stock_value), 0) from ${variants} v where v.product_id = "products"."id")`,
      minPrice: sql<string>`(select min(v.sell_price) from ${variants} v where v.product_id = "products"."id")`,
      maxPrice: sql<string>`(select max(v.sell_price) from ${variants} v where v.product_id = "products"."id")`,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(products.name))
    .limit(500);
  return rows.map((r) => ({ ...r.product, categoryName: r.categoryName, variantCount: r.variantCount, stockQty: r.stockQty, stockValue: r.stockValue, minPrice: r.minPrice, maxPrice: r.maxPrice }));
}

const ACCENTS_FROM = "àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ";
const ACCENTS_TO = "aaaaaaceeeeiiiinooooouuuuyyoa";

/** Lower case without accents, in SQL. */
function fold(expr: SQL) {
  return sql`translate(lower(${expr}), ${ACCENTS_FROM}, ${ACCENTS_TO})`;
}

export function foldText(text: string) {
  let out = text.toLowerCase();
  for (let i = 0; i < ACCENTS_FROM.length; i++) out = out.split(ACCENTS_FROM[i]).join(ACCENTS_TO[i]);
  return out;
}

/** Shop words in French, English and Swahili that mean the same part. */
const SYNONYMS: string[][] = [
  ["frein", "brake", "plaquette", "pad", "machoire", "breki"],
  ["pneu", "tyre", "tire", "pneumatique", "tairi"],
  ["chambre", "tube", "chambre a air"],
  ["huile", "oil", "lubrifiant", "mafuta"],
  ["bougie", "spark", "plug"],
  ["chaine", "chain", "mnyororo"],
  ["moto", "motorcycle", "motorbike", "bike", "pikipiki"],
  ["batterie", "battery", "betri"],
  ["filtre", "filter"],
  ["casque", "helmet", "kofia"],
  ["retroviseur", "mirror", "kioo"],
  ["phare", "headlight", "lamp", "lampe", "ampoule", "bulb"],
  ["embrayage", "clutch"],
  ["cable", "wire"],
  ["jante", "rim", "roue", "wheel"],
  ["amortisseur", "shock", "suspension"],
  ["guidon", "handlebar"],
  ["siege", "selle", "seat"],
  ["piston", "segment", "ring"],
  ["carburateur", "carburetor", "carb"],
  ["pignon", "sprocket", "couronne"],
  ["roulement", "bearing"],
  ["avant", "front"],
  ["arriere", "rear", "back"],
  ["rouge", "red"],
  ["noir", "black"],
  ["bleu", "blue"],
  ["blanc", "white"],
];

export function searchAlternatives(word: string): string[] {
  const w = foldText(word).replace(/[%_\\]/g, "");
  if (!w) return [""];
  const out = new Set([w]);
  // Plurals: "freins", "pneus", "pads".
  const stem = w.length > 3 && /[sx]$/.test(w) ? w.slice(0, -1) : w;
  out.add(stem);
  for (const group of stem.length >= 3 ? SYNONYMS : []) {
    if (group.some((g) => g.startsWith(stem) || (stem.length >= 4 && stem.startsWith(g)))) group.forEach((g) => out.add(g));
  }
  return Array.from(out);
}

/** Search sellable variants for the POS and pickers: by name, SKU, barcode or size. */
export async function searchVariants(tx: Tx, opts: { search?: string; locationId?: number; limit?: number; ids?: number[] }) {
  const term = opts.search?.trim();
  const conds = [eq(variants.active, true), eq(products.active, true)];
  if (opts.ids?.length) conds.push(inArray(variants.id, opts.ids));
  if (term) {
    // Every word must match the name, category, brand, code, barcode or a size/colour, without
    // caring about accents, and French and English shop words find each other (frein = brake).
    const haystack = sql`${fold(sql`${products.name} || ' ' || coalesce(${categories.name}, '') || ' ' || coalesce(${products.brand}, '') || ' ' || ${variants.sku} || ' ' || coalesce(${variants.barcode}, '') || ' ' || ${variants.attributes}::text`)}`;
    const words = term.split(/\s+/).filter(Boolean).slice(0, 6);
    conds.push(
      or(
        eq(variants.barcode, term),
        and(...words.map((w) => or(...searchAlternatives(w).map((alt) => sql`${haystack} like ${`%${alt}%`}`))!))!,
      )!,
    );
  }
  const rows = await tx
    .select({
      id: variants.id,
      sku: variants.sku,
      barcode: variants.barcode,
      attributes: variants.attributes,
      sellPrice: variants.sellPrice,
      stockQty: variants.stockQty,
      stockValue: variants.stockValue,
      reorderLevel: variants.reorderLevel,
      productId: products.id,
      productName: products.name,
      unit: products.unit,
      tracksSerials: products.tracksSerials,
      categoryName: categories.name,
      locationQty: opts.locationId
        ? sql<string>`coalesce((select qty from ${stockLevels} s where s.variant_id = "variants"."id" and s.location_id = ${opts.locationId}), 0)`
        : sql<string>`${variants.stockQty}`,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(...conds))
    .orderBy(
      // Exact barcode or SKU first, so a scan lands on the right item.
      term ? sql`case when ${variants.barcode} = ${term} or ${variants.sku} = ${term.toUpperCase()} then 0 else 1 end` : sql`1`,
      asc(products.name),
      asc(variants.sku),
    )
    .limit(opts.limit ?? 50);
  const kept = await keptUnitCosts(tx, rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    label: variantLabel(r.attributes),
    avgCost: dec(r.stockQty).isZero() ? "0.000000" : dec(r.stockValue).dividedBy(r.stockQty).toFixed(6),
    keptUnitCost: kept.get(r.id) ?? null,
  }));
}

export async function listUnits(tx: Tx, opts: { variantId?: number; status?: string; locationId?: number; search?: string }) {
  const conds = [];
  if (opts.variantId) conds.push(eq(motorcycleUnits.variantId, opts.variantId));
  conds.push(opts.status ? eq(motorcycleUnits.status, opts.status) : ne(motorcycleUnits.status, "reversed"));
  if (opts.locationId) conds.push(eq(motorcycleUnits.locationId, opts.locationId));
  if (opts.search) {
    const like = `%${opts.search}%`;
    conds.push(or(ilike(motorcycleUnits.chassisNo, like), ilike(motorcycleUnits.engineNo, like))!);
  }
  return tx
    .select({
      unit: motorcycleUnits,
      sku: variants.sku,
      attributes: variants.attributes,
      productName: products.name,
      productId: products.id,
      locationName: locations.name,
    })
    .from(motorcycleUnits)
    .innerJoin(variants, eq(variants.id, motorcycleUnits.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(locations, eq(locations.id, motorcycleUnits.locationId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(motorcycleUnits.id))
    .limit(1000)
    .then((rows) => rows.map((r) => ({ ...r.unit, sku: r.sku, attributes: r.attributes, productName: r.productName, productId: r.productId, locationName: r.locationName, label: variantLabel(r.attributes) })));
}

export async function updateUnit(tx: Tx, id: number, input: { chassisNo?: string | null; engineNo?: string | null; color?: string | null }) {
  const [unit] = await tx.select().from(motorcycleUnits).where(eq(motorcycleUnits.id, id));
  if (!unit) throw notFound("Motorcycle", "Moto introuvable");
  const chassisNo = input.chassisNo === undefined ? undefined : input.chassisNo?.trim().toUpperCase() || null;
  if (chassisNo && chassisNo !== unit.chassisNo) {
    const [d] = await tx.select({ id: motorcycleUnits.id }).from(motorcycleUnits).where(eq(motorcycleUnits.chassisNo, chassisNo));
    if (d) throw conflict(`Chassis number ${chassisNo} is already registered`, `Le numéro de châssis ${chassisNo} est déjà enregistré`);
  }
  if (unit.status === "sold" && chassisNo !== undefined && chassisNo !== unit.chassisNo) {
    throw conflict("The chassis number of a sold motorcycle cannot be changed", "Le numéro de châssis d'une moto vendue ne peut pas être modifié");
  }
  const [row] = await tx
    .update(motorcycleUnits)
    .set({
      ...(chassisNo !== undefined && { chassisNo }),
      ...(input.engineNo !== undefined && { engineNo: input.engineNo?.trim().toUpperCase() || null }),
      ...(input.color !== undefined && { color: input.color?.trim() || null }),
    })
    .where(eq(motorcycleUnits.id, id))
    .returning();
  return row;
}

/** The colour attribute of a variant (Colour, Color, Couleur…), used as the default colour of each bike. */
export function variantColour(attributes: Record<string, string> | null | undefined): string | null {
  for (const [k, v] of Object.entries(attributes ?? {})) if (/^(colou?r|couleur)$/i.test(k.trim()) && v) return v;
  return null;
}
