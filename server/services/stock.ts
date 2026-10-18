import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { de, frNumber } from "@shared/french";
import { locations, motorcycleUnits, products, stockLevels, stockMovements, variants, type MovementType } from "@shared/schema";
import { Decimal, cents, dec, type DecimalInput } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, wholeUnitError } from "../errors";
import { wholeUnit } from "@shared/units";
import { lockPeriodsShared, noteVariantLocks } from "./ledger";

/*
 * Stock is valued at weighted average cost per variant. Each variant keeps its total quantity
 * and total value; issuing stock removes value in proportion (and the last unit takes whatever
 * value is left), so the Inventory account always equals the sum of variant values.
 */

/** Quantities are stored with 3 decimals; refuse more so totals and locations never drift apart. */
export function stockQty(input: DecimalInput): Decimal {
  const q = dec(input, "quantity");
  if (q.decimalPlaces() > 3) throw badRequest("Quantities can have at most 3 decimals", "Les quantités ont au maximum 3 décimales");
  return q;
}

interface MovementRef {
  date: string;
  type: MovementType;
  sourceType?: string | null;
  sourceId?: number | null;
  journalId?: number | null;
  note?: string | null;
  userId?: number | null;
}

/**
 * Every posting that touches stock takes its locks in one order: the periods lock (shared), then the
 * items' rows in id order, then the contacts' balances (lockBalances), then the franc and money locks (in
 * postJournal; journal numbers take none). See the lock order in ledger.ts.
 * A service calls this before its first journal, so an offload or a cancelled sale (which post first)
 * and a sale, return or adjustment of the same item (which move stock first) cannot wait on each other.
 */
export async function lockVariants(tx: Tx, variantIds: number[]): Promise<void> {
  const ids = Array.from(new Set(variantIds)).sort((a, b) => a - b);
  if (!ids.length) return;
  noteVariantLocks(tx, ids);
  await lockPeriodsShared(tx);
  await tx.select({ id: variants.id }).from(variants).where(inArray(variants.id, ids)).orderBy(asc(variants.id)).for("update");
}

async function lockVariant(tx: Tx, variantId: number) {
  const [variant] = await tx.select().from(variants).where(eq(variants.id, variantId)).for("update");
  if (!variant) throw badRequest(`Variant ${variantId} not found`, `Variante ${variantId} introuvable`);
  return variant;
}

/** New activity at a switched-off location is refused; undoing earlier sales there still works. */
const NEW_ACTIVITY: MovementType[] = ["opening", "container_in", "sale", "adjustment", "transfer_in", "transfer_out"];

async function assertLocationOpen(tx: Tx, locationId: number, type: MovementType) {
  if (!NEW_ACTIVITY.includes(type)) return;
  const [loc] = await tx.select({ name: locations.name, active: locations.active }).from(locations).where(eq(locations.id, locationId));
  if (!loc) throw badRequest("That location does not exist", "Cet emplacement n'existe pas");
  if (!loc.active) throw badRequest(`${loc.name} is switched off: switch it back on first`, `${loc.name} est désactivé : réactivez-le d'abord`);
}

/**
 * What can leave a location on `date` without any later day going below zero: an entry typed for
 * an earlier day cannot take stock that only arrived after it.
 */
async function availableOn(tx: Tx, variantId: number, locationId: number, date: string, current: Decimal): Promise<Decimal> {
  const result = await tx.execute<{ as_of: string | null; later_min: string | null }>(sql`
    with d as (
      select ${stockMovements.date} as day, sum(${stockMovements.qty}) as q from ${stockMovements}
      where ${stockMovements.variantId} = ${variantId} and ${stockMovements.locationId} = ${locationId}
      group by ${stockMovements.date}
    ), r as (select day, sum(q) over (order by day) as bal from d)
    select (select coalesce(sum(q), 0) from d where day <= ${date}) as as_of,
           (select min(bal) from r where day > ${date}) as later_min`);
  const row = result.rows[0];
  let available = Decimal.min(current, dec(row?.as_of ?? 0));
  if (row?.later_min != null) available = Decimal.min(available, dec(row.later_min));
  return Decimal.max(available, 0);
}

async function locationQty(tx: Tx, variantId: number, locationId: number): Promise<Decimal> {
  const [row] = await tx
    .select({ qty: stockLevels.qty })
    .from(stockLevels)
    .where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId)))
    .for("update");
  return dec(row?.qty ?? 0);
}

async function addLocationQty(tx: Tx, variantId: number, locationId: number, delta: Decimal) {
  if (delta.isNegative()) {
    // Callers check availability first; the row exists because stock is there.
    await tx
      .update(stockLevels)
      .set({ qty: sql`${stockLevels.qty} - ${delta.abs().toFixed(3)}` })
      .where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId)));
    return;
  }
  await tx
    .insert(stockLevels)
    .values({ variantId, locationId, qty: delta.toFixed(3) })
    .onConflictDoUpdate({
      target: [stockLevels.variantId, stockLevels.locationId],
      set: { qty: sql`${stockLevels.qty} + ${delta.toFixed(3)}` },
    });
}

/** Add stock at a known total value. */
export async function receiveStock(
  tx: Tx,
  input: MovementRef & { variantId: number; locationId: number; qty: DecimalInput; value: DecimalInput },
): Promise<void> {
  const q = stockQty(input.qty);
  const v = cents(input.value);
  if (q.lte(0)) throw badRequest("Quantity must be greater than zero", "La quantité doit être supérieure à zéro");
  if (v.isNegative()) throw badRequest("Stock value cannot be negative", "La valeur du stock ne peut pas être négative");
  await assertLocationOpen(tx, input.locationId, input.type);
  const variant = await lockVariant(tx, input.variantId);
  await tx
    .update(variants)
    .set({
      stockQty: dec(variant.stockQty).plus(q).toFixed(3),
      stockValue: dec(variant.stockValue).plus(v).toFixed(2),
    })
    .where(eq(variants.id, variant.id));
  await addLocationQty(tx, variant.id, input.locationId, q);
  await tx.insert(stockMovements).values({
    date: input.date,
    variantId: variant.id,
    locationId: input.locationId,
    type: input.type,
    qty: q.toFixed(3),
    value: v.toFixed(2),
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    journalId: input.journalId ?? null,
    note: input.note ?? null,
    createdBy: input.userId ?? null,
  });
}

/**
 * Remove stock at average cost, or at an exact value when `value` is given (used to undo a
 * receipt: the rest of the stock keeps its own cost). The exact value is capped so the variant
 * never keeps value without quantity or goes negative. Returns the value removed.
 */
export async function issueStock(
  tx: Tx,
  input: MovementRef & { variantId: number; locationId: number; qty: DecimalInput; label?: string; value?: DecimalInput },
): Promise<string> {
  const q = stockQty(input.qty);
  if (q.lte(0)) throw badRequest("Quantity must be greater than zero", "La quantité doit être supérieure à zéro");
  await assertLocationOpen(tx, input.locationId, input.type);
  const variant = await lockVariant(tx, input.variantId);
  const available = await availableOn(tx, variant.id, input.locationId, input.date, await locationQty(tx, variant.id, input.locationId));
  if (available.lt(q)) {
    throw conflict(
      `Not enough stock of ${input.label ?? variant.sku}: ${available.toString()} available, ${q.toString()} needed`,
      `Stock insuffisant ${de(input.label ?? variant.sku)}\u00a0: ${frNumber(available)} disponible(s), ${frNumber(q)} nécessaire(s)`,
    );
  }
  const totalQty = dec(variant.stockQty);
  const totalValue = dec(variant.stockValue);
  let value: Decimal;
  if (q.equals(totalQty)) value = totalValue;
  else if (input.value !== undefined) value = Decimal.min(cents(input.value), totalValue);
  else value = cents(totalValue.times(q).dividedBy(totalQty));

  await tx
    .update(variants)
    .set({
      stockQty: totalQty.minus(q).toFixed(3),
      stockValue: totalValue.minus(value).toFixed(2),
    })
    .where(eq(variants.id, variant.id));
  await addLocationQty(tx, variant.id, input.locationId, q.negated());
  await tx.insert(stockMovements).values({
    date: input.date,
    variantId: variant.id,
    locationId: input.locationId,
    type: input.type,
    qty: q.negated().toFixed(3),
    value: value.negated().toFixed(2),
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    journalId: input.journalId ?? null,
    note: input.note ?? null,
    createdBy: input.userId ?? null,
  });
  return value.toFixed(2);
}

/** Move quantity between locations. Value does not change. */
export async function transferStock(
  tx: Tx,
  input: MovementRef & { variantId: number; fromLocationId: number; toLocationId: number; qty: DecimalInput; unitIds?: number[] },
): Promise<void> {
  const q = stockQty(input.qty);
  if (q.lte(0)) throw badRequest("Quantity must be greater than zero", "La quantité doit être supérieure à zéro");
  if (input.fromLocationId === input.toLocationId) throw badRequest("Pick two different locations", "Choisissez deux emplacements différents");
  await assertLocationOpen(tx, input.fromLocationId, "transfer_out");
  await assertLocationOpen(tx, input.toLocationId, "transfer_in");
  const variant = await lockVariant(tx, input.variantId);
  const available = await availableOn(tx, variant.id, input.fromLocationId, input.date, await locationQty(tx, variant.id, input.fromLocationId));
  if (available.lt(q)) throw conflict(`Not enough stock of ${variant.sku} to transfer`, `Stock insuffisant ${de(variant.sku)} pour le transfert`);
  const [product] = await tx.select({ tracksSerials: products.tracksSerials, unit: products.unit, name: products.name }).from(products).where(eq(products.id, variant.productId));
  if (!q.isInteger() && wholeUnit(product?.unit)) throw wholeUnitError(`${product?.name ?? ""} (${variant.sku})`.trim());
  if (product?.tracksSerials) {
    // Motorcycles move with their own records.
    const ids = input.unitIds ?? [];
    if (!q.isInteger() || ids.length !== q.toNumber()) throw badRequest(`Pick which ${q.toString()} motorcycle(s) of ${variant.sku} are moving`, `Choisissez quelle(s) ${q.toString()} moto(s) ${de(variant.sku)} sont transférées`);
    const units = await tx.select().from(motorcycleUnits).where(inArray(motorcycleUnits.id, ids)).for("update");
    if (units.length !== ids.length || units.some((u) => u.variantId !== variant.id || u.status !== "in_stock" || u.locationId !== input.fromLocationId)) {
      throw badRequest("One of the motorcycles picked is not in stock at that location", "Une des motos choisies n'est pas en stock à cet emplacement");
    }
    await tx.update(motorcycleUnits).set({ locationId: input.toLocationId }).where(inArray(motorcycleUnits.id, ids));
  }
  await addLocationQty(tx, variant.id, input.fromLocationId, q.negated());
  await addLocationQty(tx, variant.id, input.toLocationId, q);
  const base = {
    date: input.date,
    variantId: variant.id,
    value: "0.00",
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    note: input.note ?? null,
    createdBy: input.userId ?? null,
  };
  await tx.insert(stockMovements).values([
    { ...base, locationId: input.fromLocationId, type: "transfer_out", qty: q.negated().toFixed(3) },
    { ...base, locationId: input.toLocationId, type: "transfer_in", qty: q.toFixed(3) },
  ]);
}

/** Attach the journal id to movements created before the journal existed. */
export async function linkMovementsToJournal(tx: Tx, sourceType: string, sourceId: number, journalId: number | null) {
  if (!journalId) return;
  await tx
    .update(stockMovements)
    .set({ journalId })
    .where(
      and(
        eq(stockMovements.sourceType, sourceType),
        eq(stockMovements.sourceId, sourceId),
        sql`${stockMovements.journalId} IS NULL`,
      ),
    );
}
