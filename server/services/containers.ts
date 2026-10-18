import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import {
  containerExpenses,
  containerLines,
  containers,
  exchangeRates,
  motorcycleUnits,
  products,
  stockLevels,
  stockMovements,
  variants,
  parties,
} from "@shared/schema";
import { computeLandedCost, type AllocationMethod, type LandedCostResult } from "@shared/landedCost";
import { cents, dec, sum, Decimal, MoneyError } from "@shared/money";
import { de, frNumber } from "@shared/french";
import type { Tx } from "../db";
import { badRequest, conflict, notFound, wholeUnitError, francDecimalsError } from "../errors";
import { wholeUnit } from "@shared/units";
import { lockBalances, moneyLeg, postJournal, rateFor, rateTolerancePct, resolveRate, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId, toUsd, type ForeignCurrency } from "./ledger";
import { applyAdvances, assertSameCurrency, reverseAdvances, settledFxTakebackLines } from "./operations";
import { issueStock, linkMovementsToJournal, lockVariants, receiveStock, stockQty } from "./stock";
import { variantColour } from "./catalog";

export async function getContainer(tx: Tx, id: number) {
  const [container] = await tx.select().from(containers).where(eq(containers.id, id));
  if (!container) throw notFound("Container", "Conteneur introuvable");
  const lines = await tx
    .select({
      line: containerLines,
      sku: variants.sku,
      attributes: variants.attributes,
      productName: products.name,
      tracksSerials: products.tracksSerials,
      unit: products.unit,
    })
    .from(containerLines)
    .innerJoin(variants, eq(variants.id, containerLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(containerLines.containerId, id))
    .orderBy(asc(containerLines.id));
  const expenseRows = await tx
    .select()
    .from(containerExpenses)
    .where(eq(containerExpenses.containerId, id))
    .orderBy(asc(containerExpenses.id));
  return {
    ...container,
    lines: lines.map((l) => ({ ...l.line, sku: l.sku, attributes: l.attributes, productName: l.productName, tracksSerials: l.tracksSerials, unit: l.unit })),
    expenses: expenseRows,
  };
}

async function lockEditable(tx: Tx, id: number) {
  const [container] = await tx.select().from(containers).where(eq(containers.id, id)).for("update");
  if (!container) throw notFound("Container", "Conteneur introuvable");
  if (container.status === "finalized") {
    throw conflict("This container is finalized. Reverse the offload before changing it.", "Ce conteneur est finalisé. Annulez le déchargement avant de le modifier.");
  }
  return container;
}

export interface ContainerLineInput {
  variantId: number;
  quantity: string;
  unitPrice: string;
  weightKg?: string | null;
  volumeCbm?: string | null;
}

/** Replace all lines of a container that is not finalized. */
export async function replaceLines(tx: Tx, containerId: number, lines: ContainerLineInput[]) {
  const container = await lockEditable(tx, containerId);
  const variantIds = Array.from(new Set(lines.map((l) => l.variantId)));
  if (variantIds.length) {
    const found = await tx
      .select({ id: variants.id, tracksSerials: products.tracksSerials, unit: products.unit, name: products.name, sku: variants.sku })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(variants.id, variantIds));
    if (found.length !== variantIds.length) throw badRequest("One of the items does not exist", "Un des articles n'existe pas");
    const serial = new Set(found.filter((f) => f.tracksSerials).map((f) => f.id));
    for (const l of lines) {
      stockQty(l.quantity);
      if (serial.has(l.variantId) && !dec(l.quantity).isInteger()) {
        throw badRequest("Motorcycles must be whole units", "Les motos se comptent en unités entières");
      }
      const f = found.find((x) => x.id === l.variantId)!;
      if (!dec(l.quantity).isInteger() && wholeUnit(f.unit)) throw wholeUnitError(`${f.name} (${f.sku})`);
    }
  }
  for (const l of lines) {
    if (dec(l.quantity).lte(0)) throw badRequest("Every line needs a quantity greater than zero", "Chaque ligne doit avoir une quantité supérieure à zéro");
    if (dec(l.unitPrice).isNegative()) throw badRequest("Unit price cannot be negative", "Le prix unitaire ne peut pas être négatif");
    // A price is kept to six decimals: one smaller would be stored, and booked, as nothing.
    const price = dec(l.unitPrice);
    if (price.gt(0) && price.toDecimalPlaces(6).isZero()) {
      throw new MoneyError(
        `A unit price of ${price.toFixed()} rounds to zero at six decimals: enter 0 for a free item, or the real price`,
        `Un prix unitaire de ${frNumber(price.toFixed())} vaut zéro à six décimales : saisissez 0 pour un article gratuit, ou le vrai prix`,
      );
    }
    // And a priced line worth under half a cent at the container's rate would go into stock at nothing (see computeLandedCost).
    if (price.gt(0) && cents(dec(l.quantity).times(price).times(container.rateToUsd)).isZero()) {
      throw new MoneyError(
        `A line of ${dec(l.quantity).toFixed()} at ${price.toFixed()} is worth less than one cent: enter 0 for a free item, or the real price`,
        `Une ligne de ${frNumber(dec(l.quantity).toFixed())} à ${frNumber(price.toFixed())} vaut moins d'un centime : saisissez 0 pour un article gratuit, ou le vrai prix`,
      );
    }
  }
  // Expenses pinned to a line keep their target only if that line survives; lines are re-created,
  // so clear single-line targets and let the user re-pick them.
  const old = await tx.select({ id: containerLines.id, variantId: containerLines.variantId }).from(containerLines).where(eq(containerLines.containerId, containerId));
  await tx.delete(containerLines).where(eq(containerLines.containerId, containerId));
  const inserted = lines.length
    ? await tx
        .insert(containerLines)
        .values(
          lines.map((l) => ({
            containerId,
            variantId: l.variantId,
            quantity: dec(l.quantity).toFixed(3),
            unitPrice: dec(l.unitPrice).toFixed(6),
            weightKg: l.weightKg ? dec(l.weightKg).toFixed(3) : null,
            volumeCbm: l.volumeCbm ? dec(l.volumeCbm).toFixed(3) : null,
          })),
        )
        .returning({ id: containerLines.id, variantId: containerLines.variantId })
    : [];
  // Re-point single-line expenses to the new line for the same item when it is unambiguous.
  const pinned = await tx
    .select()
    .from(containerExpenses)
    .where(and(eq(containerExpenses.containerId, containerId), eq(containerExpenses.method, "line")));
  for (const e of pinned) {
    const oldLine = old.find((o) => o.id === e.targetLineId);
    const matches = oldLine ? inserted.filter((n) => n.variantId === oldLine.variantId) : [];
    await tx
      .update(containerExpenses)
      .set({ targetLineId: matches.length === 1 ? matches[0].id : null })
      .where(eq(containerExpenses.id, e.id));
  }
}

export interface ContainerExpenseInput {
  date: string;
  type: string;
  description?: string | null;
  amount: string;
  currency: "USD" | "CDF";
  rate?: string | null;
  method: AllocationMethod;
  targetLineId?: number | null;
  paidFromAccountId?: number | null;
  payablePartyId?: number | null;
}

/**
 * Record a container expense. It is posted straight away (Dr Goods in transit, Cr the money
 * account it was paid from, or Cr Payables to the agent who is owed), and becomes part of the
 * item cost when the container is finalized.
 */
export async function addExpense(tx: Tx, containerId: number, input: ContainerExpenseInput, userId: number) {
  const container = await lockEditable(tx, containerId);
  if (!!input.paidFromAccountId === !!input.payablePartyId) {
    throw badRequest("Say either which account paid this expense or who is owed for it", "Indiquez soit le compte qui a payé cette dépense, soit à qui elle est due");
  }
  if (input.payablePartyId) {
    const [party] = await tx.select({ type: parties.type }).from(parties).where(eq(parties.id, input.payablePartyId));
    if (!party || !["supplier", "agent", "employee"].includes(party.type)) {
      throw badRequest("A container cost is owed to a supplier or an agent", "Un frais de conteneur est dû à un fournisseur ou à un agent");
    }
  }
  if (input.method === "line") {
    if (!input.targetLineId) throw badRequest("Pick the line this expense belongs to", "Choisissez la ligne à laquelle appartient cette dépense");
    const [line] = await tx
      .select()
      .from(containerLines)
      .where(and(eq(containerLines.id, input.targetLineId), eq(containerLines.containerId, containerId)));
    if (!line) throw badRequest("That line is not in this container", "Cette ligne n'est pas dans ce conteneur");
  }
  const amount = cents(input.amount);
  if (amount.lte(0)) throw badRequest("Amount must be greater than zero", "Le montant doit être supérieur à zéro");

  let creditLine;
  let currency: "USD" | "CDF" = input.currency;
  let amountUsd: string;
  let rate: string | null = null;
  if (input.paidFromAccountId) {
    const leg = await moneyLeg(tx, { accountId: input.paidFromAccountId, amount, rate: input.rate, date: input.date });
    assertSameCurrency(input.currency, leg.currency);
    currency = leg.currency;
    amountUsd = leg.usd;
    rate = leg.rate;
    creditLine = { accountId: leg.accountId, credit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate };
  } else {
    if (currency === "CDF" && !amount.isInteger()) throw francDecimalsError(amount);
    rate = currency === "CDF" ? await resolveRate(tx, input.date, input.rate) : null;
    amountUsd = toUsd(currency, amount, rate);
    // A bill in francs stays owed in francs on the contact.
    creditLine = {
      accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables),
      credit: amountUsd,
      partyId: input.payablePartyId,
      ...(currency === "CDF" ? { currency: "CDF" as const, nativeAmount: amount, rate } : {}),
    };
  }

  const [expense] = await tx
    .insert(containerExpenses)
    .values({
      containerId,
      date: input.date,
      type: input.type,
      description: input.description ?? null,
      amountNative: amount.toFixed(2),
      currency,
      rate,
      amountUsd,
      method: input.method,
      targetLineId: input.method === "line" ? input.targetLineId : null,
      paidFromAccountId: input.paidFromAccountId ?? null,
      payablePartyId: input.payablePartyId ?? null,
      createdBy: userId,
    })
    .returning();

  const journalId = await postJournal(tx, {
    date: input.date,
    type: "container_expense",
    memo: `${container.number}\u00a0: ${EXPENSE_TYPE_FR[input.type] ?? input.type}${input.description ? ` (${input.description})` : ""}`,
    sourceType: "container_expense",
    sourceId: expense.id,
    userId,
    lines: [{ accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit), debit: amountUsd }, creditLine],
  });
  await tx.update(containerExpenses).set({ journalId }).where(eq(containerExpenses.id, expense.id));
  // Francs owed to an agent are settled by any dollar advance already paid to them.
  if (input.payablePartyId && currency === "CDF") await applyAdvances(tx, input.payablePartyId, input.date, `Avance imputée sur les frais du conteneur ${container.number}`, userId, { type: "container_expense", id: expense.id }, "CDF");
  return expense;
}

/** Remove an expense from a container that is not finalized; its journal is reversed. */
export async function removeExpense(tx: Tx, containerId: number, expenseId: number, date: string, userId: number) {
  await lockEditable(tx, containerId);
  const [expense] = await tx
    .select()
    .from(containerExpenses)
    .where(and(eq(containerExpenses.id, expenseId), eq(containerExpenses.containerId, containerId)));
  if (!expense) throw notFound("Expense", "Dépense introuvable");
  if (expense.journalId) await reverseJournal(tx, expense.journalId, { date, userId, memo: "Frais de conteneur supprimé" });
  await reverseAdvances(tx, { type: "container_expense", id: expense.id }, date, userId);
  await tx.delete(containerExpenses).where(eq(containerExpenses.id, expenseId));
}

/** Change how an existing expense is split, without touching the money side. */
export async function updateExpenseAllocation(
  tx: Tx,
  containerId: number,
  expenseId: number,
  method: AllocationMethod,
  targetLineId: number | null,
) {
  await lockEditable(tx, containerId);
  if (method === "line" && !targetLineId) throw badRequest("Pick the line this expense belongs to", "Choisissez la ligne à laquelle appartient cette dépense");
  if (method === "line") {
    const [line] = await tx
      .select()
      .from(containerLines)
      .where(and(eq(containerLines.id, targetLineId!), eq(containerLines.containerId, containerId)));
    if (!line) throw badRequest("That line is not in this container", "Cette ligne n'est pas dans ce conteneur");
  }
  await tx
    .update(containerExpenses)
    .set({ method, targetLineId: method === "line" ? targetLineId : null })
    .where(and(eq(containerExpenses.id, expenseId), eq(containerExpenses.containerId, containerId)));
}

export async function previewLandedCost(tx: Tx, containerId: number): Promise<LandedCostResult> {
  const c = await getContainer(tx, containerId);
  return computeLandedCost(
    c.lines.map((l) => ({
      key: l.id,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      weightKg: l.weightKg,
      volumeCbm: l.volumeCbm,
    })),
    c.expenses.map((e) => ({
      key: e.id,
      amountUsd: e.amountUsd,
      method: e.method as AllocationMethod,
      targetLineKey: e.targetLineId,
    })),
    c.rateToUsd,
  );
}

/**
 * Offload: put the container's stock in at landed cost.
 * Journal: Dr Inventory (landed total) / Cr Payables to the supplier (FOB) / Cr Goods in transit (expenses).
 */
/** A supplier invoice in yuan or francs stays owed in that currency on the supplier. */
function supplierInvoiceNative(currency: string, lines: { quantity: string; unitPrice: string }[], fobUsd: string) {
  if (currency !== "CNY" && currency !== "CDF") return {};
  const native = sum(lines.map((l) => cents(dec(l.quantity).times(l.unitPrice))));
  if (native.isZero() || dec(fobUsd).isZero()) return {};
  return { currency: currency as ForeignCurrency, nativeAmount: native, rate: native.dividedBy(fobUsd).toFixed(4) };
}

/**
 * Refuse a container rate that cannot be right: the purchase is booked at it, so 7.14 typed for
 * 0.14 would put fifty times the value in stock and in the supplier's balance.
 */
export async function assertContainerRate(tx: Tx, currency: string, rateToUsd: string | null | undefined, date: string) {
  const rate = dec(rateToUsd ?? "1");
  const cur = currency.toUpperCase();
  if (cur !== "USD" && cur !== "CDF" && cur !== "CNY") {
    throw badRequest("A container is invoiced in USD, CDF or CNY", "Un conteneur est facturé en USD, CDF ou CNY");
  }
  if (cur === "USD") {
    if (!rate.equals(1)) throw badRequest("A container invoiced in USD has a rate of 1", "Un conteneur facturé en USD a un taux de 1");
    return;
  }
  // Rates are typed and shown as "how many for 1 $" (2 808 FC, 7,1 ¥), so the messages say them that way too.
  const sign = cur === "CDF" ? "FC" : "¥";
  const perUsd = (r: Decimal) => (r.gt(0) ? new Decimal(1).dividedBy(r).toSignificantDigits(8).toDecimalPlaces(4) : r);
  let onFile: Decimal | null = null;
  if (cur === "CDF") {
    onFile = (await rateFor(tx, date)).rate;
  } else if (cur === "CNY") {
    const [row] = await tx
      .select({ rate: exchangeRates.cnyPerUsd })
      .from(exchangeRates)
      .where(and(lte(exchangeRates.date, date), sql`${exchangeRates.cnyPerUsd} is not null`))
      .orderBy(desc(exchangeRates.date))
      .limit(1);
    if (row?.rate) {
      onFile = dec(row.rate);
    } else if (rate.lt(0.08) || rate.gt(0.25)) {
      throw badRequest(
        `${perUsd(rate).toString()} CNY for $1 looks wrong: one dollar buys about 7.1 CNY. Give how many yuan one dollar buys.`,
        `${frNumber(perUsd(rate).toString())}\u00a0¥ pour 1\u00a0$ semble faux : un dollar vaut environ 7,1\u00a0¥. Indiquez combien de yuans vaut 1\u00a0$.`,
      );
    }
  }
  if (!onFile) return;
  const reference = new Decimal(1).dividedBy(onFile);
  const limit = Decimal.max(await rateTolerancePct(tx), 5);
  if (rate.minus(reference).abs().dividedBy(reference).times(100).gt(limit)) {
    throw badRequest(
      `The container rate (${perUsd(rate).toString()} ${sign} for $1) is more than ${limit.toString()}% away from the rate on file (${onFile.toString()} ${sign} for $1). Check it, or update the day's rate first.`,
      `Le taux du conteneur (${frNumber(perUsd(rate).toString())}\u00a0${sign} pour 1\u00a0$) s'écarte de plus de ${frNumber(limit.toString())} % du taux enregistré (${frNumber(onFile.toString())}\u00a0${sign} pour 1\u00a0$). Vérifiez-le, ou mettez d'abord à jour le taux du jour.`,
    );
  }
}

export async function finalizeContainer(tx: Tx, containerId: number, offloadDate: string, userId: number) {
  const container = await lockEditable(tx, containerId);
  await assertContainerRate(tx, container.currency, container.rateToUsd, offloadDate);
  const [supplier] = await tx.select({ type: parties.type }).from(parties).where(eq(parties.id, container.supplierId));
  if (supplier?.type !== "supplier") throw badRequest("The container's supplier is not a supplier", "Le fournisseur du conteneur n'est pas un fournisseur");
  const full = await getContainer(tx, containerId);
  if (full.lines.length === 0) throw badRequest("Add the container's items before offloading", "Ajoutez les articles du conteneur avant le déchargement");
  // An item's unit may have changed since its line was typed: pieces still arrive whole.
  const units = await tx
    .select({ id: variants.id, sku: variants.sku, name: products.name, unit: products.unit })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.id, full.lines.map((l) => l.variantId)));
  for (const l of full.lines) {
    const u = units.find((x) => x.id === l.variantId);
    if (u && !dec(l.quantity).isInteger() && wholeUnit(u.unit)) throw wholeUnitError(`${u.name} (${u.sku})`);
  }
  const unpinned = full.expenses.find((e) => e.method === "line" && !e.targetLineId);
  if (unpinned) throw badRequest("An expense charged to one line has no line. Pick its line first.", "Une dépense imputée à une seule ligne n'a pas de ligne. Choisissez d'abord sa ligne.");
  const result = await previewLandedCost(tx, containerId);
  // The items before the journal (see lockVariants): a sale of one of them locks it first too.
  await lockVariants(tx, full.lines.map((l) => l.variantId));

  const inventoryId = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const invoice = supplierInvoiceNative(container.currency, full.lines, result.fobTotalUsd);
  const journalId = await postJournal(tx, {
    date: offloadDate,
    type: "container_finalize",
    memo: `Déchargement du conteneur ${container.number}`,
    sourceType: "container",
    sourceId: containerId,
    userId,
    lines: [
      { accountId: inventoryId, debit: result.landedTotalUsd },
      {
        accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables),
        credit: result.fobTotalUsd,
        partyId: container.supplierId,
        memo: `Facture fournisseur ${container.number}`,
        ...invoice,
      },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit), credit: result.expensesTotalUsd },
    ],
  });

  for (const line of full.lines) {
    const r = result.lines.find((x) => x.key === line.id)!;
    await tx
      .update(containerLines)
      .set({
        fobUsd: r.fobUsd,
        allocatedUsd: r.allocatedUsd,
        landedTotalUsd: r.landedTotalUsd,
        landedUnitCost: r.landedUnitCost,
      })
      .where(eq(containerLines.id, line.id));
    await receiveStock(tx, {
      date: offloadDate,
      type: "container_in",
      variantId: line.variantId,
      locationId: container.locationId,
      qty: line.quantity,
      value: r.landedTotalUsd,
      sourceType: "container",
      sourceId: containerId,
      journalId,
      userId,
    });
    if (line.tracksSerials) {
      const n = dec(line.quantity).toNumber();
      // Reuse the records (and chassis numbers) kept from an earlier, reversed offload.
      const kept = await tx
        .select({ id: motorcycleUnits.id })
        .from(motorcycleUnits)
        .where(and(eq(motorcycleUnits.containerId, containerId), eq(motorcycleUnits.variantId, line.variantId), eq(motorcycleUnits.status, "reversed")))
        .orderBy(asc(motorcycleUnits.id))
        .limit(n);
      if (kept.length) {
        await tx
          .update(motorcycleUnits)
          .set({ status: "in_stock", locationId: container.locationId })
          .where(inArray(motorcycleUnits.id, kept.map((k) => k.id)));
      }
      if (n > kept.length) {
        await tx.insert(motorcycleUnits).values(
          Array.from({ length: n - kept.length }, () => ({
            variantId: line.variantId,
            locationId: container.locationId,
            containerId,
            color: variantColour(line.attributes),
            status: "in_stock",
          })),
        );
      }
    }
  }

  // Motorcycles no longer on the container: blank records go, records with a chassis number are kept.
  await tx.delete(motorcycleUnits).where(and(eq(motorcycleUnits.containerId, containerId), eq(motorcycleUnits.status, "reversed"), isNull(motorcycleUnits.chassisNo)));
  await tx.update(motorcycleUnits).set({ status: "removed" }).where(and(eq(motorcycleUnits.containerId, containerId), eq(motorcycleUnits.status, "reversed")));

  await tx
    .update(containers)
    .set({
      status: "finalized",
      offloadDate,
      fobTotalUsd: result.fobTotalUsd,
      expensesTotalUsd: result.expensesTotalUsd,
      landedTotalUsd: result.landedTotalUsd,
      finalizeJournalId: journalId,
      finalizedAt: new Date(),
      finalizedBy: userId,
    })
    .where(eq(containers.id, containerId));
  // A dollar deposit already paid to the supplier settles the yuan invoice now, so the yuan owed is
  // what is really left to pay.
  if (container.currency === "CNY" || container.currency === "CDF") {
    await applyAdvances(tx, container.supplierId, offloadDate, `Avance imputée sur le conteneur ${container.number}`, userId, { type: "container", id: containerId }, container.currency as "CNY" | "CDF");
  }
  return result;
}

/**
 * Undo an offload while all of its stock is still on hand. Stock is removed at today's average
 * cost; any difference from the landed value goes to stock adjustments.
 */
const EXPENSE_TYPE_FR: Record<string, string> = {
  freight: "Fret",
  duties: "Droits de douane",
  clearing: "Dédouanement",
  transport: "Transport",
  handling: "Manutention",
  offload_labour: "Main-d'œuvre de déchargement",
  insurance: "Assurance",
  other: "Autre",
};

export async function reverseContainer(tx: Tx, containerId: number, date: string, userId: number) {
  const [container] = await tx.select().from(containers).where(eq(containers.id, containerId)).for("update");
  if (!container) throw notFound("Container", "Conteneur introuvable");
  if (container.status !== "finalized") throw badRequest("Only an offloaded container can be reversed", "Seul un conteneur déchargé peut être annulé");
  if (container.offloadDate && date < container.offloadDate) {
    throw badRequest(`The reversal cannot be dated before the offload (${container.offloadDate})`, `L'annulation ne peut pas être datée avant le déchargement (${container.offloadDate})`);
  }
  const full = await getContainer(tx, containerId);

  const units = await tx.select().from(motorcycleUnits).where(eq(motorcycleUnits.containerId, containerId));
  if (units.some((u) => u.status !== "in_stock")) {
    throw conflict("Some motorcycles from this container are already sold, so it cannot be reversed", "Des motos de ce conteneur sont déjà vendues, il ne peut donc pas être annulé");
  }
  // Only while nothing of these items has left stock since the offload: then the container's own
  // goods are all still here and come out at exactly the cost they went in with.
  const variantIds = Array.from(new Set(full.lines.map((l) => l.variantId)));
  // The items before anything is read or posted (see lockVariants): the advances go back as journals first.
  await lockVariants(tx, variantIds);
  if (variantIds.length) {
    const [offload] = await tx
      .select({ id: sql<number>`max(${stockMovements.id})` })
      .from(stockMovements)
      .where(and(eq(stockMovements.sourceType, "container"), eq(stockMovements.sourceId, containerId), eq(stockMovements.type, "container_in")));
    const [out] = await tx
      .select({ id: stockMovements.id, variantId: stockMovements.variantId })
      .from(stockMovements)
      .where(and(inArray(stockMovements.variantId, variantIds), gt(stockMovements.id, offload?.id ?? 0), lt(stockMovements.qty, "0")))
      .limit(1);
    if (out) {
      const line = full.lines.find((l) => l.variantId === out.variantId)!;
      throw conflict(
        `${line.productName} (${line.sku}) has been sold, moved or adjusted since this offload, so the offload can no longer be undone. Correct the costs with a stock adjustment instead.`,
        `${line.productName} (${line.sku}) a été vendu, déplacé ou ajusté depuis ce déchargement : il ne peut plus être annulé. Corrigez plutôt avec un ajustement de stock.`,
      );
    }
  }
  for (const line of full.lines) {
    const [lvl] = await tx
      .select({ qty: stockLevels.qty })
      .from(stockLevels)
      .where(and(eq(stockLevels.variantId, line.variantId), eq(stockLevels.locationId, container.locationId)));
    const needed = sum(full.lines.filter((l) => l.variantId === line.variantId).map((l) => l.quantity));
    if (dec(lvl?.qty ?? 0).lt(needed)) {
      throw conflict(`Not enough ${line.productName} (${line.sku}) left in stock to reverse this container`, `Stock insuffisant ${de(line.productName)} (${line.sku}) pour annuler ce conteneur`);
    }
  }

  // The supplier's balances before the advances go back (see settledFxTakebackLines).
  await lockBalances(tx, { parties: [container.supplierId] });
  await reverseAdvances(tx, { type: "container", id: containerId }, date, userId);
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const invoice = supplierInvoiceNative(container.currency, full.lines, container.fobTotalUsd!);
  // Yuan paid for at a discount (or at another rate) come back owed at what was paid for them.
  const takeback =
    invoice.currency === "CNY" && container.finalizeJournalId
      ? await settledFxTakebackLines(tx, { payables, partyId: container.supplierId, billJournalId: container.finalizeJournalId, native: invoice.nativeAmount, usd: container.fobTotalUsd!, rate: invoice.rate })
      : [];
  let removed = dec(0);
  for (const line of full.lines) {
    const value = await issueStock(tx, {
      date,
      type: "container_reversal",
      variantId: line.variantId,
      locationId: container.locationId,
      qty: line.quantity,
      value: line.landedTotalUsd ?? undefined,
      sourceType: "container_reversal",
      sourceId: containerId,
      userId,
    });
    removed = removed.plus(value);
  }
  const landed = dec(container.landedTotalUsd);
  const diff = landed.minus(removed); // positive: removed less than landed
  const journalId = await postJournal(tx, {
    date,
    type: "container_reversal",
    memo: `Annulation du déchargement du conteneur ${container.number}`,
    sourceType: "container",
    sourceId: containerId,
    exactValues: true,
    // The yuan or francs owed go back at the invoice's value: what a month-end revaluation, or the rate's
    // moves since, left in dollars on them goes with them. Those paid for come back at what was paid.
    clearRevalued: true,
    userId,
    lines: [
      { accountId: payables, debit: container.fobTotalUsd!, partyId: container.supplierId, ...invoice },
      ...takeback,
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit), debit: container.expensesTotalUsd! },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory), credit: removed.toFixed(2) },
      {
        accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.stockAdjustments),
        credit: diff.isPositive() ? diff.toFixed(2) : 0,
        debit: diff.isNegative() ? diff.abs().toFixed(2) : 0,
        memo: "Écart de coût à l'annulation (le stock de ces articles a changé depuis le déchargement)",
      },
    ],
  });
  await linkMovementsToJournal(tx, "container_reversal", containerId, journalId);
  // Keep the records so chassis numbers already typed come back when the container is offloaded again.
  if (units.length) await tx.update(motorcycleUnits).set({ status: "reversed" }).where(eq(motorcycleUnits.containerId, containerId));
  await tx
    .update(containerLines)
    .set({ fobUsd: null, allocatedUsd: null, landedTotalUsd: null, landedUnitCost: null })
    .where(eq(containerLines.containerId, containerId));
  await tx
    .update(containers)
    .set({
      status: "arrived",
      offloadDate: null,
      fobTotalUsd: null,
      expensesTotalUsd: null,
      landedTotalUsd: null,
      finalizeJournalId: null,
      finalizedAt: null,
      finalizedBy: null,
    })
    .where(eq(containers.id, containerId));
}
