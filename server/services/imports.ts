import { eq } from "drizzle-orm";
import { categories, containerLines, containers, locations, products, variants } from "@shared/schema";
import { cents, dec } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { addVariant, createProduct } from "./catalog";
import { replaceLines } from "./containers";
import { adjustStock } from "./operations";

/*
 * Spreadsheet imports. The browser reads the file and sends plain rows; every row is
 * checked here and the whole import runs in one transaction, so a bad row changes nothing.
 * - An item is matched by SKU or barcode first, then by item name plus size and colour.
 * - Items that do not exist yet are created (with their category) unless the caller says not to.
 */

export interface ImportItemRow {
  name: string;
  category?: string | null;
  brand?: string | null;
  unit?: string | null;
  size?: string | null;
  colour?: string | null;
  sku?: string | null;
  barcode?: string | null;
  sellPrice?: string | null;
  reorderLevel?: string | null;
  motorcycle?: boolean | null;
}

export interface RowResult {
  row: number;
  variantId: number | null;
  sku: string | null;
  status: "existing" | "new_variant" | "new_item" | "error";
  /** The unit of the item matched (preview only), so the browser knows a "2,250" there is litres or pieces. */
  unit?: string | null;
  error?: string;
  errorFr?: string;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function wantedValues(r: ImportItemRow) {
  return [r.size, r.colour].map(norm).filter(Boolean).sort();
}

function attributeKeys(existing: Record<string, string>[]) {
  const keys = existing.flatMap((a) => Object.keys(a));
  return {
    size: keys.find((k) => /^(size|taille|dimension)$/i.test(k)) ?? "Taille",
    colour: keys.find((k) => /^(colou?r|couleur)$/i.test(k)) ?? "Couleur",
  };
}

interface Caches {
  products: Map<string, { id: number; tracksSerials: boolean; unit?: string | null }>;
  categories: Map<string, number>;
}

async function loadCaches(tx: Tx): Promise<Caches> {
  const ps = await tx.select({ id: products.id, name: products.name, tracksSerials: products.tracksSerials, unit: products.unit }).from(products);
  const cs = await tx.select({ id: categories.id, name: categories.name }).from(categories);
  return {
    products: new Map(ps.map((p) => [norm(p.name), { id: p.id, tracksSerials: p.tracksSerials, unit: p.unit }])),
    categories: new Map(cs.map((c) => [norm(c.name), c.id])),
  };
}

async function categoryId(tx: Tx, caches: Caches, name: string | null | undefined) {
  const key = norm(name);
  if (!key) return null;
  const found = caches.categories.get(key);
  if (found) return found;
  const [row] = await tx.insert(categories).values({ name: name!.trim() }).returning({ id: categories.id });
  caches.categories.set(key, row.id);
  return row.id;
}

/** Find or create the variant a row describes. Throws a bad request naming the row on any problem. */
async function resolveRow(tx: Tx, caches: Caches, r: ImportItemRow, n: number, create: boolean): Promise<RowResult> {
  const sku = r.sku?.trim().toUpperCase() || null;
  const barcode = r.barcode?.trim() || null;
  if (sku || barcode) {
    const [v] = await tx
      .select({ id: variants.id, sku: variants.sku })
      .from(variants)
      .where(sku ? eq(variants.sku, sku) : eq(variants.barcode, barcode!));
    if (v) return { row: n, variantId: v.id, sku: v.sku, status: "existing" };
    if (sku && barcode) {
      const [b] = await tx.select({ id: variants.id, sku: variants.sku }).from(variants).where(eq(variants.barcode, barcode));
      if (b) return { row: n, variantId: b.id, sku: b.sku, status: "existing" };
    }
  }
  const name = r.name?.trim();
  if (!name) throw badRequest(`Row ${n}: the item name is missing`, `Ligne ${n} : le nom de l'article manque`);
  const price = r.sellPrice != null && r.sellPrice !== "" ? dec(r.sellPrice, `row ${n} price`) : null;
  if (price?.isNegative()) throw badRequest(`Row ${n}: the price cannot be negative`, `Ligne ${n} : le prix ne peut pas être négatif`);

  const product = caches.products.get(norm(name));
  if (product) {
    const vs = await tx.select({ id: variants.id, sku: variants.sku, attributes: variants.attributes }).from(variants).where(eq(variants.productId, product.id));
    const want = wantedValues(r).join("|");
    const match = vs.find((v) => Object.values(v.attributes ?? {}).map(norm).filter(Boolean).sort().join("|") === want);
    if (match) return { row: n, variantId: match.id, sku: match.sku, status: "existing" };
    if (!create) throw badRequest(`Row ${n}: ${name} has no variant ${[r.size, r.colour].filter(Boolean).join(" / ") || "without size"}`, `Ligne ${n} : ${name} n'a pas de variante ${[r.size, r.colour].filter(Boolean).join(" / ") || "sans taille"}`);
    const keys = attributeKeys(vs.map((v) => v.attributes ?? {}));
    const attributes: Record<string, string> = {};
    if (r.size?.trim()) attributes[keys.size] = r.size.trim();
    if (r.colour?.trim()) attributes[keys.colour] = r.colour.trim();
    const full = await addVariant(tx, product.id, { sku, barcode, attributes, sellPrice: price?.toFixed(2) ?? null, reorderLevel: r.reorderLevel || null });
    const v = full.variants.reduce((a, b) => (b.id > a.id ? b : a));
    return { row: n, variantId: v.id, sku: v.sku, status: "new_variant" };
  }
  if (!create) throw badRequest(`Row ${n}: no item called ${name}`, `Ligne ${n} : aucun article nommé ${name}`);
  const attributes: Record<string, string> = {};
  if (r.size?.trim()) attributes.Taille = r.size.trim();
  if (r.colour?.trim()) attributes.Couleur = r.colour.trim();
  const created = await createProduct(tx, {
    name,
    categoryId: await categoryId(tx, caches, r.category),
    brand: r.brand?.trim() || null,
    unit: r.unit?.trim() || null,
    tracksSerials: !!r.motorcycle,
    variants: [{ sku, barcode, attributes, sellPrice: price?.toFixed(2) ?? null, reorderLevel: r.reorderLevel || null }],
  }, { defaultBrand: "" });
  caches.products.set(norm(name), { id: created.id, tracksSerials: !!r.motorcycle });
  const [v] = await tx.select({ id: variants.id, sku: variants.sku }).from(variants).where(eq(variants.productId, created.id));
  return { row: n, variantId: v.id, sku: v.sku, status: "new_item" };
}

function withRow(n: number, e: unknown): never {
  if (e instanceof Error && "status" in e) {
    const err = e as Error & { messageFr?: string };
    if (!/^Row \d+/.test(err.message)) {
      err.message = `Row ${n}: ${err.message}`;
      if (err.messageFr) err.messageFr = `Ligne ${n} : ${err.messageFr}`;
    }
  }
  throw e;
}

// ---------------------------------------------------------------- Items and opening stock

export interface ImportStockRow extends ImportItemRow {
  qty?: string | null;
  unitCost?: string | null;
}

/**
 * Create the items in the file and, for rows with a quantity, book them as opening stock
 * (Dr inventory, Cr opening balances) in one stock adjustment.
 * A quantity on an item that existed before this import is refused unless the caller says
 * `addToExisting`: importing the same file twice must not count its opening stock twice.
 */
export async function importItems(
  tx: Tx,
  input: { date: string; locationId: number; updatePrices?: boolean; addToExisting?: boolean; rows: ImportStockRow[] },
  userId: number,
) {
  if (!input.rows.length) throw badRequest("The file has no rows", "Le fichier ne contient aucune ligne");
  const [loc] = await tx.select().from(locations).where(eq(locations.id, input.locationId));
  if (!loc) throw notFound("Location", "Emplacement introuvable");
  const caches = await loadCaches(tx);
  const results: RowResult[] = [];
  const stockLines: { variantId: number; qtyChange: string; unitCost: string | null }[] = [];
  const createdHere = new Set<number>();
  for (const [i, r] of input.rows.entries()) {
    const n = i + 2; // header is row 1
    try {
      const res = await resolveRow(tx, caches, r, n, true);
      results.push(res);
      if (res.status !== "existing") createdHere.add(res.variantId!);
      if (res.status === "existing" && input.updatePrices && r.sellPrice != null && r.sellPrice !== "") {
        await tx.update(variants).set({ sellPrice: cents(r.sellPrice).toFixed(2) }).where(eq(variants.id, res.variantId!));
      }
      const q = r.qty != null && r.qty !== "" ? dec(r.qty, `row ${n} quantity`) : null;
      if (q && !q.isZero()) {
        if (q.isNegative()) throw badRequest(`Row ${n}: the quantity cannot be negative`, `Ligne ${n} : la quantité ne peut pas être négative`);
        if (!input.addToExisting && !createdHere.has(res.variantId!)) {
          throw conflict(
            `Row ${n}: ${res.sku} already exists. Its quantity would be added to the stock already there; confirm adding it, or remove the quantity.`,
            `Ligne ${n} : ${res.sku} existe déjà. Sa quantité s'ajouterait au stock existant ; confirmez l'ajout, ou retirez la quantité.`,
          );
        }
        const cost = r.unitCost != null && r.unitCost !== "" ? dec(r.unitCost, `row ${n} cost`) : null;
        if (!cost) throw badRequest(`Row ${n}: give the cost per unit for the opening quantity`, `Ligne ${n} : indiquez le coût unitaire de la quantité d'ouverture`);
        stockLines.push({ variantId: res.variantId!, qtyChange: q.toString(), unitCost: cost.toString() });
      }
    } catch (e) {
      withRow(n, e);
    }
  }
  let adjustment = null;
  if (stockLines.length) {
    adjustment = await adjustStock(tx, { date: input.date, locationId: input.locationId, kind: "opening", reason: "Stock d'ouverture importé", lines: stockLines }, userId);
  }
  return {
    created: results.filter((r) => r.status === "new_item").length,
    newVariants: results.filter((r) => r.status === "new_variant").length,
    existing: results.filter((r) => r.status === "existing").length,
    stockLines: stockLines.length,
    adjustment,
    rows: results,
  };
}

/** Check a file without saving anything: what each row would match or create. */
export async function previewItems(tx: Tx, rows: ImportItemRow[]) {
  const caches = await loadCaches(tx);
  const out: RowResult[] = [];
  const newItems = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const n = i + 2;
    const sku = r.sku?.trim().toUpperCase() || null;
    const barcode = r.barcode?.trim() || null;
    let found: { id: number; sku: string; unit: string | null } | undefined;
    const pick = { id: variants.id, sku: variants.sku, unit: products.unit };
    if (sku) [found] = await tx.select(pick).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.sku, sku));
    if (!found && barcode) [found] = await tx.select(pick).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.barcode, barcode));
    if (found) {
      out.push({ row: n, variantId: found.id, sku: found.sku, status: "existing", unit: found.unit });
      continue;
    }
    if (!r.name?.trim()) {
      out.push({ row: n, variantId: null, sku, status: "error", error: "Item name is missing", errorFr: "Le nom de l'article manque" });
      continue;
    }
    const product = caches.products.get(norm(r.name));
    if (!product) {
      // A later row of an item that an earlier row creates is a new variant of it, as the import counts it.
      out.push({ row: n, variantId: null, sku, status: newItems.has(norm(r.name)) ? "new_variant" : "new_item" });
      newItems.add(norm(r.name));
      continue;
    }
    const vs = await tx.select({ id: variants.id, sku: variants.sku, attributes: variants.attributes }).from(variants).where(eq(variants.productId, product.id));
    const want = wantedValues(r).join("|");
    const match = vs.find((v) => Object.values(v.attributes ?? {}).map(norm).filter(Boolean).sort().join("|") === want);
    out.push(match ? { row: n, variantId: match.id, sku: match.sku, status: "existing", unit: product.unit } : { row: n, variantId: null, sku, status: "new_variant", unit: product.unit });
  }
  return out;
}

/** Bulk price update by SKU or barcode. */
export async function updatePrices(tx: Tx, rows: { sku?: string | null; barcode?: string | null; sellPrice: string }[]) {
  let updated = 0;
  for (const [i, r] of rows.entries()) {
    const n = i + 2;
    const price = dec(r.sellPrice, `row ${n} price`);
    if (price.isNegative()) throw badRequest(`Row ${n}: the price cannot be negative`, `Ligne ${n} : le prix ne peut pas être négatif`);
    const sku = r.sku?.trim().toUpperCase();
    const where = sku ? eq(variants.sku, sku) : r.barcode?.trim() ? eq(variants.barcode, r.barcode.trim()) : null;
    if (!where) throw badRequest(`Row ${n}: give a SKU or barcode`, `Ligne ${n} : indiquez un SKU ou un code-barres`);
    const res = await tx.update(variants).set({ sellPrice: cents(price).toFixed(2) }).where(where).returning({ id: variants.id });
    if (!res.length) throw badRequest(`Row ${n}: no item with ${sku ? "SKU " + sku : "barcode " + r.barcode}`, `Ligne ${n} : aucun article avec ${sku ? "le SKU " + sku : "le code-barres " + r.barcode}`);
    updated += 1;
  }
  return { updated };
}

// ---------------------------------------------------------------- Container packing list

export interface ImportContainerRow extends ImportItemRow {
  quantity: string;
  unitPrice: string;
  weightKg?: string | null;
  volumeCbm?: string | null;
}

/** Load a packing list into a container that is not offloaded yet, creating missing items. */
export async function importContainerLines(tx: Tx, containerId: number, input: { mode: "append" | "replace"; rows: ImportContainerRow[] }) {
  const [c] = await tx.select().from(containers).where(eq(containers.id, containerId)).for("update");
  if (!c) throw notFound("Container", "Conteneur introuvable");
  if (c.status === "finalized") throw conflict("This container is already offloaded", "Ce conteneur est déjà déchargé");
  if (!input.rows.length) throw badRequest("The file has no rows", "Le fichier ne contient aucune ligne");
  const caches = await loadCaches(tx);
  const lines: { variantId: number; quantity: string; unitPrice: string; weightKg: string | null; volumeCbm: string | null }[] = [];
  const results: RowResult[] = [];
  for (const [i, r] of input.rows.entries()) {
    const n = i + 2;
    try {
      const q = dec(r.quantity, `row ${n} quantity`);
      if (q.lte(0)) throw badRequest(`Row ${n}: the quantity must be greater than zero`, `Ligne ${n} : la quantité doit être supérieure à zéro`);
      const price = dec(r.unitPrice, `row ${n} unit price`);
      if (price.isNegative()) throw badRequest(`Row ${n}: the price cannot be negative`, `Ligne ${n} : le prix ne peut pas être négatif`);
      const res = await resolveRow(tx, caches, r, n, true);
      results.push(res);
      const tracks = await tx.select({ t: products.tracksSerials }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, res.variantId!));
      if (tracks[0]?.t && !q.isInteger()) throw badRequest(`Row ${n}: motorcycles must be whole units`, `Ligne ${n} : les motos se comptent en unités entières`);
      lines.push({
        variantId: res.variantId!,
        quantity: q.toString(),
        unitPrice: price.toString(),
        weightKg: r.weightKg != null && r.weightKg !== "" ? dec(r.weightKg, `row ${n} weight`).toString() : null,
        volumeCbm: r.volumeCbm != null && r.volumeCbm !== "" ? dec(r.volumeCbm, `row ${n} volume`).toString() : null,
      });
    } catch (e) {
      withRow(n, e);
    }
  }
  let all = lines;
  if (input.mode === "append") {
    const current = await tx.select().from(containerLines).where(eq(containerLines.containerId, containerId));
    all = [
      ...current.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, weightKg: l.weightKg, volumeCbm: l.volumeCbm })),
      ...lines,
    ];
  }
  await replaceLines(tx, containerId, all);
  return {
    imported: lines.length,
    created: results.filter((r) => r.status === "new_item").length,
    newVariants: results.filter((r) => r.status === "new_variant").length,
  };
}
