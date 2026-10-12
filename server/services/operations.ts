import { and, eq, inArray } from "drizzle-orm";
import {
  accounts,
  expenses,
  motorcycleUnits,
  parties,
  partners,
  products,
  stockAdjustments,
  variants,
} from "@shared/schema";
import { cents, dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import {
  moneyLeg,
  nextNumber,
  postJournal,
  reverseJournal,
  SYSTEM_ACCOUNTS,
  systemAccountId,
  toUsd,
  type PostLine,
} from "./ledger";
import { issueStock, linkMovementsToJournal, receiveStock } from "./stock";

async function requireParty(tx: Tx, id: number | null | undefined, types: string[]) {
  if (!id) throw badRequest("Choose who this is for");
  const [party] = await tx.select().from(parties).where(eq(parties.id, id));
  if (!party || !types.includes(party.type)) throw badRequest("That customer, supplier or agent does not exist");
  return party;
}

async function requirePartner(tx: Tx, id: number) {
  const [partner] = await tx.select().from(partners).where(eq(partners.id, id));
  if (!partner) throw notFound("Partner");
  return partner;
}

// ---------------------------------------------------------------- Operating expenses

export interface ExpenseInput {
  date: string;
  accountId: number;
  description: string;
  amount: string;
  /** Only used when the expense is left unpaid; otherwise the paying account decides the currency. */
  currency?: "USD" | "CDF";
  rate?: string | null;
  paidFromAccountId?: number | null;
  payablePartyId?: number | null;
}

/** Rent, salaries, electricity… Dr the expense account, Cr the money account (or what is owed). */
export async function createExpense(tx: Tx, input: ExpenseInput, userId: number) {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!account || account.type !== "expense") throw badRequest("Pick an expense category");
  if (!!input.paidFromAccountId === !!input.payablePartyId) {
    throw badRequest("Say either which account paid this or who is owed for it");
  }
  const amount = cents(input.amount);
  if (amount.lte(0)) throw badRequest("Amount must be greater than zero");

  let currency: "USD" | "CDF" = input.currency ?? "USD";
  let usd: string;
  let rate: string | null = null;
  let creditLine: PostLine;
  if (input.paidFromAccountId) {
    const leg = await moneyLeg(tx, { accountId: input.paidFromAccountId, amount, rate: input.rate });
    currency = leg.currency;
    usd = leg.usd;
    rate = leg.rate;
    creditLine = { accountId: leg.accountId, credit: usd, nativeAmount: leg.nativeAmount, rate: leg.rate };
  } else {
    await requireParty(tx, input.payablePartyId, ["supplier", "agent"]);
    usd = toUsd(currency, amount, input.rate);
    rate = currency === "CDF" ? dec(input.rate).toFixed(4) : null;
    creditLine = { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables), credit: usd, partyId: input.payablePartyId };
  }

  const [expense] = await tx
    .insert(expenses)
    .values({
      date: input.date,
      accountId: account.id,
      description: input.description,
      amountNative: amount.toFixed(2),
      currency,
      rate,
      amountUsd: usd,
      paidFromAccountId: input.paidFromAccountId ?? null,
      payablePartyId: input.payablePartyId ?? null,
      createdBy: userId,
    })
    .returning();
  const journalId = await postJournal(tx, {
    date: input.date,
    type: "expense",
    memo: `${account.name}: ${input.description}`,
    sourceType: "expense",
    sourceId: expense.id,
    userId,
    lines: [{ accountId: account.id, debit: usd }, creditLine],
  });
  const [updated] = await tx.update(expenses).set({ journalId }).where(eq(expenses.id, expense.id)).returning();
  return updated;
}

export async function voidExpense(tx: Tx, id: number, date: string, userId: number) {
  const [expense] = await tx.select().from(expenses).where(eq(expenses.id, id)).for("update");
  if (!expense) throw notFound("Expense");
  if (expense.voidedAt) throw conflict("This expense is already cancelled");
  const voidJournalId = await reverseJournal(tx, expense.journalId!, { date, userId, memo: `Expense cancelled: ${expense.description}` });
  await tx.update(expenses).set({ voidedAt: new Date(), voidJournalId }).where(eq(expenses.id, id));
}

// ---------------------------------------------------------------- Money movements

export interface TransferInput {
  date: string;
  fromAccountId: number;
  fromAmount: string;
  toAccountId: number;
  toAmount: string;
  rate?: string | null;
  memo?: string | null;
}

/**
 * Move money between cash boxes, bank and mobile money, including changing USD to CDF.
 * Any difference in USD value from the exchange goes to exchange differences.
 */
export async function transferMoney(tx: Tx, input: TransferInput, userId: number) {
  if (input.fromAccountId === input.toAccountId) throw badRequest("Pick two different accounts");
  const from = await moneyLeg(tx, { accountId: input.fromAccountId, amount: input.fromAmount, rate: input.rate });
  const to = await moneyLeg(tx, { accountId: input.toAccountId, amount: input.toAmount, rate: input.rate });
  const diff = dec(from.usd).minus(to.usd);
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  return postJournal(tx, {
    date: input.date,
    type: "transfer",
    memo: input.memo ?? "Transfer",
    userId,
    lines: [
      { accountId: to.accountId, debit: to.usd, nativeAmount: to.nativeAmount, rate: to.rate },
      { accountId: from.accountId, credit: from.usd, nativeAmount: from.nativeAmount, rate: from.rate },
      { accountId: fx, debit: diff.isPositive() ? diff : 0, credit: diff.isNegative() ? diff.abs() : 0, memo: "Exchange difference" },
    ],
  });
}

export interface PartyPaymentInput {
  date: string;
  partyId: number;
  accountId: number;
  amount: string;
  rate?: string | null;
  memo?: string | null;
}

/** A customer pays what they owe. */
export async function receiveFromCustomer(tx: Tx, input: PartyPaymentInput, userId: number) {
  const party = await requireParty(tx, input.partyId, ["customer"]);
  const leg = await moneyLeg(tx, input);
  return postJournal(tx, {
    date: input.date,
    type: "customer_receipt",
    memo: input.memo ?? `Payment from ${party.name}`,
    userId,
    lines: [
      { accountId: leg.accountId, debit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables), credit: leg.usd, partyId: party.id },
    ],
  });
}

/** Pay a supplier or agent (container invoice, clearing agent, transporter, unpaid bills). */
export async function payParty(tx: Tx, input: PartyPaymentInput, userId: number) {
  const party = await requireParty(tx, input.partyId, ["supplier", "agent"]);
  const leg = await moneyLeg(tx, input);
  return postJournal(tx, {
    date: input.date,
    type: "supplier_payment",
    memo: input.memo ?? `Payment to ${party.name}`,
    userId,
    lines: [
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables), debit: leg.usd, partyId: party.id },
      { accountId: leg.accountId, credit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate },
    ],
  });
}

export interface PartnerMoneyInput {
  date: string;
  partnerId: number;
  accountId: number;
  amount: string;
  rate?: string | null;
  memo?: string | null;
}

/** A partner puts money into the business (capital). */
export async function partnerContribution(tx: Tx, input: PartnerMoneyInput, userId: number) {
  const partner = await requirePartner(tx, input.partnerId);
  const leg = await moneyLeg(tx, input);
  return postJournal(tx, {
    date: input.date,
    type: "partner_contribution",
    memo: input.memo ?? `Capital from ${partner.name}`,
    userId,
    lines: [
      { accountId: leg.accountId, debit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate },
      { accountId: partner.capitalAccountId, credit: leg.usd },
    ],
  });
}

/** A partner takes money out (against their profit balance). */
export async function partnerWithdrawal(tx: Tx, input: PartnerMoneyInput, userId: number) {
  const partner = await requirePartner(tx, input.partnerId);
  const leg = await moneyLeg(tx, input);
  return postJournal(tx, {
    date: input.date,
    type: "partner_withdrawal",
    memo: input.memo ?? `Withdrawal by ${partner.name}`,
    userId,
    lines: [
      { accountId: partner.currentAccountId, debit: leg.usd },
      { accountId: leg.accountId, credit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate },
    ],
  });
}

// ---------------------------------------------------------------- Manual & opening journals

export interface ManualLineInput {
  accountId: number;
  debit?: string | null;
  credit?: string | null;
  partyId?: number | null;
  nativeAmount?: string | null;
  rate?: string | null;
  memo?: string | null;
}

export async function manualJournal(
  tx: Tx,
  input: { date: string; memo: string; lines: ManualLineInput[]; type?: "manual" | "opening" },
  userId: number,
) {
  const debit = sum(input.lines.map((l) => cents(l.debit ?? 0)));
  const credit = sum(input.lines.map((l) => cents(l.credit ?? 0)));
  if (!debit.equals(credit)) {
    throw badRequest(`Debits (${debit.toFixed(2)}) and credits (${credit.toFixed(2)}) must be equal`);
  }
  if (debit.isZero()) throw badRequest("Enter some amounts");
  const ids = input.lines.map((l) => l.accountId);
  const rows = await tx.select().from(accounts).where(inArray(accounts.id, ids));
  const inventoryId = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const transitId = await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit);
  for (const r of rows) {
    if (r.id === inventoryId || r.id === transitId) {
      throw badRequest(`${r.name} is kept by stock and containers. Use a stock adjustment or the container screen.`);
    }
  }
  return postJournal(tx, {
    date: input.date,
    type: input.type ?? "manual",
    memo: input.memo,
    userId,
    lines: input.lines.map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 })),
  });
}

// ---------------------------------------------------------------- Stock adjustments

export interface AdjustmentLineInput {
  variantId: number;
  /** Signed: positive adds stock, negative removes it. */
  qtyChange: string;
  /** Cost per unit for added stock. Defaults to the current average cost. */
  unitCost?: string | null;
  /** Motorcycles being removed. */
  unitIds?: number[];
  /** Motorcycles being added. */
  serials?: { chassisNo: string; engineNo?: string | null; color?: string | null }[];
}

export interface AdjustmentInput {
  date: string;
  locationId: number;
  /** "opening" posts against opening balances; anything else is a stock gain or loss (shared cost). */
  kind: "opening" | "count" | "damage" | "loss" | "found" | "other";
  reason: string;
  lines: AdjustmentLineInput[];
}

export async function adjustStock(tx: Tx, input: AdjustmentInput, userId: number) {
  if (input.lines.length === 0) throw badRequest("Add at least one item");
  const number = await nextNumber(tx, "adjustment", "ADJ-");
  const [adj] = await tx
    .insert(stockAdjustments)
    .values({ number, date: input.date, locationId: input.locationId, kind: input.kind, reason: input.reason, createdBy: userId })
    .returning();

  let gains = new Decimal(0);
  let losses = new Decimal(0);
  for (const line of input.lines) {
    const change = dec(line.qtyChange, "quantity");
    if (change.isZero()) continue;
    const [v] = await tx
      .select({ variant: variants, tracksSerials: products.tracksSerials, name: products.name })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(variants.id, line.variantId));
    if (!v) throw badRequest("One of the items does not exist");
    if (v.tracksSerials && !change.isInteger()) throw badRequest("Motorcycles must be whole units");

    if (change.isPositive()) {
      if (input.kind !== "opening" && input.kind !== "found" && input.kind !== "count" && input.kind !== "other") {
        throw badRequest("Damage and loss can only remove stock");
      }
      let unit = line.unitCost != null && line.unitCost !== "" ? dec(line.unitCost, "unit cost") : null;
      if (!unit) {
        const q = dec(v.variant.stockQty);
        if (q.isZero()) throw badRequest(`Give a cost per unit for ${v.name} (${v.variant.sku}); it has no stock to take an average from`);
        unit = dec(v.variant.stockValue).dividedBy(q);
      }
      if (unit.isNegative()) throw badRequest("Cost cannot be negative");
      const value = cents(unit.times(change));
      await receiveStock(tx, {
        date: input.date,
        type: input.kind === "opening" ? "opening" : "adjustment",
        variantId: v.variant.id,
        locationId: input.locationId,
        qty: change,
        value,
        sourceType: "adjustment",
        sourceId: adj.id,
        note: input.reason,
        userId,
      });
      gains = gains.plus(value);
      if (v.tracksSerials) {
        const serials = line.serials ?? [];
        if (serials.length > change.toNumber()) throw badRequest("More chassis numbers than motorcycles added");
        const chassis = serials.map((s) => s.chassisNo?.trim().toUpperCase()).filter((c): c is string => !!c);
        if (new Set(chassis).size !== chassis.length) throw badRequest("The same chassis number is entered twice");
        if (chassis.length) {
          const taken = await tx.select({ chassisNo: motorcycleUnits.chassisNo }).from(motorcycleUnits).where(inArray(motorcycleUnits.chassisNo, chassis));
          if (taken.length) throw conflict(`Chassis number ${taken[0].chassisNo} is already registered`);
        }
        const rows = Array.from({ length: change.toNumber() }, (_, i) => ({
          variantId: v.variant.id,
          locationId: input.locationId,
          chassisNo: serials[i]?.chassisNo?.trim().toUpperCase() || null,
          engineNo: serials[i]?.engineNo?.trim().toUpperCase() || null,
          color: serials[i]?.color || null,
          status: "in_stock",
        }));
        await tx.insert(motorcycleUnits).values(rows);
      }
    } else {
      if (input.kind === "opening") throw badRequest("Opening stock can only add stock");
      const q = change.abs();
      if (v.tracksSerials) {
        const ids = line.unitIds ?? [];
        if (ids.length !== q.toNumber()) throw badRequest(`Pick which ${q.toString()} motorcycle(s) of ${v.name} are removed`);
        const units = await tx.select().from(motorcycleUnits).where(inArray(motorcycleUnits.id, ids)).for("update");
        if (units.length !== ids.length || units.some((u) => u.variantId !== v.variant.id || u.status !== "in_stock" || u.locationId !== input.locationId)) {
          throw badRequest("One of the motorcycles picked is not in stock here");
        }
        await tx.delete(motorcycleUnits).where(inArray(motorcycleUnits.id, ids));
      }
      const value = await issueStock(tx, {
        date: input.date,
        type: "adjustment",
        variantId: v.variant.id,
        locationId: input.locationId,
        qty: q,
        label: `${v.name} (${v.variant.sku})`,
        sourceType: "adjustment",
        sourceId: adj.id,
        note: input.reason,
        userId,
      });
      losses = losses.plus(value);
    }
  }

  const inventory = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const offset = await systemAccountId(tx, input.kind === "opening" ? SYSTEM_ACCOUNTS.openingEquity : SYSTEM_ACCOUNTS.stockAdjustments);
  const journalId = await postJournal(tx, {
    date: input.date,
    type: input.kind === "opening" ? "opening" : "stock_adjustment",
    memo: `${number}: ${input.reason}`,
    sourceType: "adjustment",
    sourceId: adj.id,
    userId,
    lines: [
      { accountId: inventory, debit: gains, memo: "Stock added" },
      { accountId: offset, credit: gains },
      { accountId: offset, debit: losses },
      { accountId: inventory, credit: losses, memo: "Stock removed" },
    ],
  });
  await linkMovementsToJournal(tx, "adjustment", adj.id, journalId);
  await tx.update(stockAdjustments).set({ journalId }).where(eq(stockAdjustments.id, adj.id));
  return { ...adj, journalId, gains: gains.toFixed(2), losses: losses.toFixed(2) };
}

export async function ensureAccountsExist(tx: Tx, ids: number[]) {
  const rows = await tx.select({ id: accounts.id }).from(accounts).where(and(inArray(accounts.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("One of the accounts does not exist");
}
