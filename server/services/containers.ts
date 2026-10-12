import { and, asc, eq, inArray } from "drizzle-orm";
import {
  containerExpenses,
  containerLines,
  containers,
  motorcycleUnits,
  products,
  stockLevels,
  variants,
} from "@shared/schema";
import { computeLandedCost, type AllocationMethod, type LandedCostResult } from "@shared/landedCost";
import { cents, dec, sum } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { moneyLeg, postJournal, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId, toUsd } from "./ledger";
import { issueStock, linkMovementsToJournal, receiveStock } from "./stock";

export async function getContainer(tx: Tx, id: number) {
  const [container] = await tx.select().from(containers).where(eq(containers.id, id));
  if (!container) throw notFound("Container");
  const lines = await tx
    .select({
      line: containerLines,
      sku: variants.sku,
      attributes: variants.attributes,
      productName: products.name,
      tracksSerials: products.tracksSerials,
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
    lines: lines.map((l) => ({ ...l.line, sku: l.sku, attributes: l.attributes, productName: l.productName, tracksSerials: l.tracksSerials })),
    expenses: expenseRows,
  };
}

async function lockEditable(tx: Tx, id: number) {
  const [container] = await tx.select().from(containers).where(eq(containers.id, id)).for("update");
  if (!container) throw notFound("Container");
  if (container.status === "finalized") {
    throw conflict("This container is finalized. Reverse the offload before changing it.");
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
  await lockEditable(tx, containerId);
  const variantIds = Array.from(new Set(lines.map((l) => l.variantId)));
  if (variantIds.length) {
    const found = await tx
      .select({ id: variants.id, tracksSerials: products.tracksSerials })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(variants.id, variantIds));
    if (found.length !== variantIds.length) throw badRequest("One of the items does not exist");
    const serial = new Set(found.filter((f) => f.tracksSerials).map((f) => f.id));
    for (const l of lines) {
      if (serial.has(l.variantId) && !dec(l.quantity).isInteger()) {
        throw badRequest("Motorcycles must be whole units");
      }
    }
  }
  for (const l of lines) {
    if (dec(l.quantity).lte(0)) throw badRequest("Every line needs a quantity greater than zero");
    if (dec(l.unitPrice).isNegative()) throw badRequest("Unit price cannot be negative");
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
    throw badRequest("Say either which account paid this expense or who is owed for it");
  }
  if (input.method === "line") {
    if (!input.targetLineId) throw badRequest("Pick the line this expense belongs to");
    const [line] = await tx
      .select()
      .from(containerLines)
      .where(and(eq(containerLines.id, input.targetLineId), eq(containerLines.containerId, containerId)));
    if (!line) throw badRequest("That line is not in this container");
  }
  const amount = cents(input.amount);
  if (amount.lte(0)) throw badRequest("Amount must be greater than zero");

  let creditLine;
  let currency: "USD" | "CDF" = input.currency;
  let amountUsd: string;
  let rate: string | null = null;
  if (input.paidFromAccountId) {
    const leg = await moneyLeg(tx, { accountId: input.paidFromAccountId, amount, rate: input.rate });
    currency = leg.currency;
    amountUsd = leg.usd;
    rate = leg.rate;
    creditLine = { accountId: leg.accountId, credit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate };
  } else {
    amountUsd = toUsd(currency, amount, input.rate);
    rate = currency === "CDF" ? dec(input.rate).toFixed(4) : null;
    creditLine = { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables), credit: amountUsd, partyId: input.payablePartyId };
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
    memo: `${container.number}: ${input.type}${input.description ? ` (${input.description})` : ""}`,
    sourceType: "container_expense",
    sourceId: expense.id,
    userId,
    lines: [{ accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit), debit: amountUsd }, creditLine],
  });
  await tx.update(containerExpenses).set({ journalId }).where(eq(containerExpenses.id, expense.id));
  return expense;
}

/** Remove an expense from a container that is not finalized; its journal is reversed. */
export async function removeExpense(tx: Tx, containerId: number, expenseId: number, date: string, userId: number) {
  await lockEditable(tx, containerId);
  const [expense] = await tx
    .select()
    .from(containerExpenses)
    .where(and(eq(containerExpenses.id, expenseId), eq(containerExpenses.containerId, containerId)));
  if (!expense) throw notFound("Expense");
  if (expense.journalId) await reverseJournal(tx, expense.journalId, { date, userId, memo: "Container expense removed" });
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
  if (method === "line" && !targetLineId) throw badRequest("Pick the line this expense belongs to");
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
export async function finalizeContainer(tx: Tx, containerId: number, offloadDate: string, userId: number) {
  const container = await lockEditable(tx, containerId);
  const full = await getContainer(tx, containerId);
  if (full.lines.length === 0) throw badRequest("Add the container's items before offloading");
  const unpinned = full.expenses.find((e) => e.method === "line" && !e.targetLineId);
  if (unpinned) throw badRequest("An expense charged to one line has no line. Pick its line first.");
  const result = await previewLandedCost(tx, containerId);

  const inventoryId = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const journalId = await postJournal(tx, {
    date: offloadDate,
    type: "container_finalize",
    memo: `Offload of container ${container.number}`,
    sourceType: "container",
    sourceId: containerId,
    userId,
    lines: [
      { accountId: inventoryId, debit: result.landedTotalUsd },
      {
        accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables),
        credit: result.fobTotalUsd,
        partyId: container.supplierId,
        memo: `Supplier invoice ${container.number}`,
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
      await tx.insert(motorcycleUnits).values(
        Array.from({ length: n }, () => ({
          variantId: line.variantId,
          locationId: container.locationId,
          containerId,
          status: "in_stock",
        })),
      );
    }
  }

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
  return result;
}

/**
 * Undo an offload while all of its stock is still on hand. Stock is removed at today's average
 * cost; any difference from the landed value goes to stock adjustments.
 */
export async function reverseContainer(tx: Tx, containerId: number, date: string, userId: number) {
  const [container] = await tx.select().from(containers).where(eq(containers.id, containerId)).for("update");
  if (!container) throw notFound("Container");
  if (container.status !== "finalized") throw badRequest("Only an offloaded container can be reversed");
  const full = await getContainer(tx, containerId);

  const units = await tx.select().from(motorcycleUnits).where(eq(motorcycleUnits.containerId, containerId));
  if (units.some((u) => u.status !== "in_stock")) {
    throw conflict("Some motorcycles from this container are already sold, so it cannot be reversed");
  }
  for (const line of full.lines) {
    const [lvl] = await tx
      .select({ qty: stockLevels.qty })
      .from(stockLevels)
      .where(and(eq(stockLevels.variantId, line.variantId), eq(stockLevels.locationId, container.locationId)));
    const needed = sum(full.lines.filter((l) => l.variantId === line.variantId).map((l) => l.quantity));
    if (dec(lvl?.qty ?? 0).lt(needed)) {
      throw conflict(`Not enough ${line.productName} (${line.sku}) left in stock to reverse this container`);
    }
  }

  let removed = dec(0);
  for (const line of full.lines) {
    const value = await issueStock(tx, {
      date,
      type: "container_reversal",
      variantId: line.variantId,
      locationId: container.locationId,
      qty: line.quantity,
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
    memo: `Reversal of container ${container.number} offload`,
    sourceType: "container",
    sourceId: containerId,
    userId,
    lines: [
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables), debit: container.fobTotalUsd!, partyId: container.supplierId },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit), debit: container.expensesTotalUsd! },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory), credit: removed.toFixed(2) },
      {
        accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.stockAdjustments),
        credit: diff.isPositive() ? diff.toFixed(2) : 0,
        debit: diff.isNegative() ? diff.abs().toFixed(2) : 0,
        memo: "Average cost difference on reversal",
      },
    ],
  });
  await linkMovementsToJournal(tx, "container_reversal", containerId, journalId);
  if (units.length) await tx.delete(motorcycleUnits).where(eq(motorcycleUnits.containerId, containerId));
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
