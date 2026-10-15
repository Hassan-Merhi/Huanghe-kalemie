import { and, asc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  motorcycleUnits,
  parties,
  products,
  saleLines,
  salePayments,
  saleReturnLines,
  saleReturns,
  sales,
  variants,
} from "@shared/schema";
import { allocateCents, cents, dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { moneyLeg, nextNumber, postJournal, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId } from "./ledger";
import { issueStock, linkMovementsToJournal, receiveStock, stockQty } from "./stock";

/** Rounding left over from paying in CDF, absorbed into exchange differences. */
const ROUNDING_TOLERANCE = new Decimal("0.10");

export interface SaleLineInput {
  variantId: number;
  unitId?: number | null;
  qty: string;
  unitPrice: string;
  lineDiscount?: string | null;
}

export interface SalePaymentInput {
  accountId: number;
  amount: string;
  rate?: string | null;
}

export interface CreateSaleInput {
  date: string;
  locationId: number;
  customerId?: number | null;
  lines: SaleLineInput[];
  discount?: string | null;
  payments: SalePaymentInput[];
  note?: string | null;
}

export async function createSale(tx: Tx, input: CreateSaleInput, userId: number) {
  if (input.lines.length === 0) throw badRequest("Add at least one item", "Ajoutez au moins un article");

  const variantIds = Array.from(new Set(input.lines.map((l) => l.variantId)));
  const variantRows = await tx
    .select({ id: variants.id, sku: variants.sku, name: products.name, tracksSerials: products.tracksSerials, active: variants.active })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.id, variantIds));
  const byId = new Map(variantRows.map((v) => [v.id, v]));

  if (input.customerId) {
    const [c] = await tx.select().from(parties).where(eq(parties.id, input.customerId));
    if (!c || c.type !== "customer") throw badRequest("Customer not found", "Client introuvable");
  }

  // Line amounts before the sale-level discount.
  const usedUnits = new Set<number>();
  const gross = input.lines.map((l) => {
    const v = byId.get(l.variantId);
    if (!v) throw badRequest("One of the items does not exist", "Un des articles n'existe pas");
    if (!v.active) throw badRequest(`${v.name} (${v.sku}) is inactive`, `${v.name} (${v.sku}) est inactif`);
    const q = stockQty(l.qty);
    if (q.lte(0)) throw badRequest("Quantities must be greater than zero", "Les quantités doivent être supérieures à zéro");
    const price = cents(l.unitPrice);
    if (price.isNegative()) throw badRequest("Prices cannot be negative", "Les prix ne peuvent pas être négatifs");
    const lineDiscount = cents(l.lineDiscount ?? 0);
    const amount = cents(q.times(price)).minus(lineDiscount);
    if (amount.isNegative()) throw badRequest("A line discount is bigger than the line", "Une remise de ligne dépasse le montant de la ligne");
    if (v.tracksSerials) {
      if (!l.unitId) throw badRequest(`Pick the chassis number for ${v.name}`, `Choisissez le numéro de châssis pour ${v.name}`);
      if (!q.equals(1)) throw badRequest("Sell motorcycles one unit per line", "Vendez les motos à raison d'une unité par ligne");
      if (usedUnits.has(l.unitId)) throw badRequest("The same motorcycle is on the sale twice", "La même moto figure deux fois sur la vente");
      usedUnits.add(l.unitId);
    }
    return { input: l, variant: v, q, price, lineDiscount, amount };
  });

  const subtotal = sum(gross.map((g) => g.amount));
  const saleDiscount = cents(input.discount ?? 0);
  if (saleDiscount.isNegative()) throw badRequest("Discount cannot be negative", "La remise ne peut pas être négative");
  if (saleDiscount.gt(subtotal)) throw badRequest("Discount is bigger than the sale", "La remise dépasse le montant de la vente");
  const discountShares = saleDiscount.isZero()
    ? gross.map(() => new Decimal(0))
    : allocateCents(saleDiscount, gross.map((g) => g.amount));
  const total = subtotal.minus(saleDiscount);

  const legs = [];
  for (const p of input.payments) {
    legs.push(await moneyLeg(tx, { accountId: p.accountId, amount: p.amount, rate: p.rate }));
  }
  const paid = sum(legs.map((l) => l.usd));
  let rounding = new Decimal(0);
  let credit = total.minus(paid);
  if (credit.isNegative()) {
    if (credit.abs().gt(ROUNDING_TOLERANCE)) {
      throw badRequest("Payments are more than the total. Enter only the money kept, not the change given back.", "Les paiements dépassent le total. Saisissez seulement l'argent encaissé, pas la monnaie rendue.");
    }
    rounding = credit.abs(); // customer paid a few cents more because of the CDF rate
    credit = new Decimal(0);
  }
  if (credit.gt(0) && !input.customerId) throw badRequest("Choose a customer to sell on credit", "Choisissez un client pour vendre à crédit");

  const number = await nextNumber(tx, "sale", "S-");
  const [sale] = await tx
    .insert(sales)
    .values({
      number,
      date: input.date,
      locationId: input.locationId,
      customerId: input.customerId ?? null,
      subtotal: subtotal.toFixed(2),
      discount: saleDiscount.toFixed(2),
      total: total.toFixed(2),
      paidUsd: paid.minus(rounding).toFixed(2),
      creditUsd: credit.toFixed(2),
      cogs: "0",
      note: input.note ?? null,
      createdBy: userId,
    })
    .returning();

  let cogsTotal = new Decimal(0);
  for (let i = 0; i < gross.length; i++) {
    const g = gross[i];
    if (g.input.unitId) {
      const [unit] = await tx.select().from(motorcycleUnits).where(eq(motorcycleUnits.id, g.input.unitId)).for("update");
      if (!unit || unit.variantId !== g.variant.id) throw badRequest("That chassis number is not this model", "Ce numéro de châssis ne correspond pas à ce modèle");
      if (unit.status !== "in_stock") throw conflict(`Motorcycle ${unit.chassisNo ?? unit.id} is already sold`, `La moto ${unit.chassisNo ?? unit.id} est déjà vendue`);
      if (unit.locationId !== input.locationId) throw conflict("That motorcycle is at another location", "Cette moto se trouve dans un autre emplacement");
      if (!unit.chassisNo) throw badRequest("Enter the chassis number of this motorcycle before selling it", "Saisissez le numéro de châssis de cette moto avant de la vendre");
      await tx.update(motorcycleUnits).set({ status: "sold", saleId: sale.id }).where(eq(motorcycleUnits.id, unit.id));
    }
    const cogs = await issueStock(tx, {
      date: input.date,
      type: "sale",
      variantId: g.variant.id,
      locationId: input.locationId,
      qty: g.q,
      label: `${g.variant.name} (${g.variant.sku})`,
      sourceType: "sale",
      sourceId: sale.id,
      userId,
    });
    cogsTotal = cogsTotal.plus(cogs);
    await tx.insert(saleLines).values({
      saleId: sale.id,
      variantId: g.variant.id,
      unitId: g.input.unitId ?? null,
      qty: g.q.toFixed(3),
      unitPrice: g.price.toFixed(2),
      lineDiscount: g.lineDiscount.plus(discountShares[i]).toFixed(2),
      lineTotal: g.amount.minus(discountShares[i]).toFixed(2),
      cogs,
    });
  }

  if (legs.length) {
    await tx.insert(salePayments).values(
      legs.map((l, i) => ({
        saleId: sale.id,
        accountId: l.accountId,
        currency: l.currency,
        amountNative: cents(input.payments[i].amount).toFixed(2),
        rate: l.rate,
        amountUsd: l.usd,
      })),
    );
  }

  const journalId = await postJournal(tx, {
    date: input.date,
    type: "sale",
    memo: `Vente ${number}`,
    sourceType: "sale",
    sourceId: sale.id,
    userId,
    lines: [
      ...legs.map((l) => ({ accountId: l.accountId, debit: l.usd, nativeAmount: l.nativeAmount, rate: l.rate })),
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables), debit: credit, partyId: input.customerId },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.sales), credit: total },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.fx), credit: rounding, memo: "Arrondi CDF" },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.cogs), debit: cogsTotal },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory), credit: cogsTotal },
    ],
  });
  await linkMovementsToJournal(tx, "sale", sale.id, journalId);
  await tx.update(sales).set({ cogs: cogsTotal.toFixed(2), journalId }).where(eq(sales.id, sale.id));
  return getSale(tx, sale.id);
}

export async function getSale(tx: Tx, id: number) {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, id));
  if (!sale) throw notFound("Sale", "Vente introuvable");
  const lines = await tx
    .select({
      line: saleLines,
      sku: variants.sku,
      attributes: variants.attributes,
      productName: products.name,
      chassisNo: motorcycleUnits.chassisNo,
      engineNo: motorcycleUnits.engineNo,
    })
    .from(saleLines)
    .innerJoin(variants, eq(variants.id, saleLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(motorcycleUnits, eq(motorcycleUnits.id, saleLines.unitId))
    .where(eq(saleLines.saleId, id))
    .orderBy(asc(saleLines.id));
  const payments = await tx.select().from(salePayments).where(eq(salePayments.saleId, id));
  const returns = await tx.select().from(saleReturns).where(eq(saleReturns.saleId, id));
  const [customer] = sale.customerId ? await tx.select().from(parties).where(eq(parties.id, sale.customerId)) : [];
  return {
    ...sale,
    customer: customer ?? null,
    lines: lines.map((l) => ({
      ...l.line,
      sku: l.sku,
      attributes: l.attributes,
      productName: l.productName,
      chassisNo: l.chassisNo,
      engineNo: l.engineNo,
    })),
    payments,
    returns,
  };
}

/** Cancel a whole sale: stock comes back at the cost it left with, and the journal is reversed. */
export async function voidSale(tx: Tx, id: number, date: string, reason: string, userId: number) {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, id)).for("update");
  if (!sale) throw notFound("Sale", "Vente introuvable");
  if (sale.status === "voided") throw conflict("This sale is already cancelled", "Cette vente est déjà annulée");
  const returns = await tx.select({ id: saleReturns.id }).from(saleReturns).where(eq(saleReturns.saleId, id));
  if (returns.length) throw conflict("This sale has returns, so it cannot be cancelled. Return the remaining items instead.", "Cette vente a des retours, elle ne peut donc pas être annulée. Retournez plutôt les articles restants.");
  const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, id));

  const voidJournalId = sale.journalId
    ? await reverseJournal(tx, sale.journalId, { date, type: "sale_void", memo: `Vente ${sale.number} annulée : ${reason}`, userId })
    : null;
  for (const line of lines) {
    await receiveStock(tx, {
      date,
      type: "sale_void",
      variantId: line.variantId,
      locationId: sale.locationId,
      qty: line.qty,
      value: line.cogs,
      sourceType: "sale_void",
      sourceId: sale.id,
      journalId: voidJournalId,
      userId,
    });
    if (line.unitId) {
      await tx.update(motorcycleUnits).set({ status: "in_stock", saleId: null }).where(eq(motorcycleUnits.id, line.unitId));
    }
  }
  await tx
    .update(sales)
    .set({ status: "voided", voidedAt: new Date(), voidReason: reason, voidJournalId })
    .where(eq(sales.id, id));
  return getSale(tx, id);
}

export interface ReturnInput {
  date: string;
  lines: { saleLineId: number; qty: string }[];
  /** Money account the refund is paid from. Leave empty to reduce what the customer owes. */
  refundAccountId?: number | null;
  rate?: string | null;
  reason: string;
}

/** Take items back from a sale, at the price they were sold for and the cost they left with. */
export async function returnSale(tx: Tx, saleId: number, input: ReturnInput, userId: number) {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for("update");
  if (!sale) throw notFound("Sale", "Vente introuvable");
  if (sale.status === "voided") throw conflict("This sale is cancelled", "Cette vente est annulée");
  if (input.lines.length === 0) throw badRequest("Pick what is coming back", "Choisissez ce qui est retourné");
  if (new Set(input.lines.map((l) => l.saleLineId)).size !== input.lines.length) {
    throw badRequest("The same item is listed twice on this return", "Le même article figure deux fois sur ce retour");
  }
  if (input.date < sale.date) {
    throw badRequest(`A return cannot be dated before the sale (${sale.date})`, `Un retour ne peut pas être daté avant la vente (${sale.date})`);
  }
  if (!input.refundAccountId && !sale.customerId) {
    throw badRequest("This sale has no customer, so pick the account the refund is paid from", "Cette vente n'a pas de client : choisissez le compte qui paie le remboursement");
  }

  const lineRows = await tx
    .select()
    .from(saleLines)
    .where(and(eq(saleLines.saleId, saleId), inArray(saleLines.id, input.lines.map((l) => l.saleLineId))))
    .for("update");

  const number = await nextNumber(tx, "return", "R-");
  const [ret] = await tx
    .insert(saleReturns)
    .values({ number, saleId, date: input.date, total: "0", cogs: "0", refundAccountId: input.refundAccountId ?? null, reason: input.reason, createdBy: userId })
    .returning();

  let total = new Decimal(0);
  let cogsTotal = new Decimal(0);
  for (const req of input.lines) {
    const line = lineRows.find((l) => l.id === req.saleLineId);
    if (!line) throw badRequest("That item is not on this sale", "Cet article ne figure pas sur cette vente");
    const q = stockQty(req.qty);
    const remaining = dec(line.qty).minus(line.returnedQty);
    if (q.lte(0) || q.gt(remaining)) throw badRequest(`You can return at most ${remaining.toString()} of that item`, `Vous pouvez retourner au maximum ${remaining.toString()} de cet article`);
    const isLast = q.equals(remaining);
    // Amount and cost already returned on this line, so the last return takes exactly what is left.
    const prior = await tx.select().from(saleReturnLines).where(eq(saleReturnLines.saleLineId, line.id));
    const priorAmount = sum(prior.map((p) => p.amount));
    const priorCogs = sum(prior.map((p) => p.cogs));
    const amount = isLast ? dec(line.lineTotal).minus(priorAmount) : cents(dec(line.lineTotal).times(q).dividedBy(line.qty));
    const cogs = isLast ? dec(line.cogs).minus(priorCogs) : cents(dec(line.cogs).times(q).dividedBy(line.qty));

    await tx.insert(saleReturnLines).values({ returnId: ret.id, saleLineId: line.id, qty: q.toFixed(3), amount: amount.toFixed(2), cogs: cogs.toFixed(2) });
    await tx.update(saleLines).set({ returnedQty: dec(line.returnedQty).plus(q).toFixed(3) }).where(eq(saleLines.id, line.id));
    await receiveStock(tx, {
      date: input.date,
      type: "sale_return",
      variantId: line.variantId,
      locationId: sale.locationId,
      qty: q,
      value: cogs,
      sourceType: "sale_return",
      sourceId: ret.id,
      userId,
    });
    if (line.unitId) {
      await tx.update(motorcycleUnits).set({ status: "in_stock", saleId: null }).where(eq(motorcycleUnits.id, line.unitId));
    }
    total = total.plus(amount);
    cogsTotal = cogsTotal.plus(cogs);
  }

  let refundLine;
  if (input.refundAccountId) {
    const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.refundAccountId));
    if (!acc) throw badRequest("Refund account not found", "Compte de remboursement introuvable");
    // Refund the USD value; for a CDF box, pay it out at the given rate.
    // Francs are handed back in whole notes and coins.
    const native = acc.currency === "CDF" ? total.times(dec(input.rate, "rate")).toDecimalPlaces(0) : total;
    const leg = await moneyLeg(tx, { accountId: input.refundAccountId, amount: native, rate: input.rate });
    refundLine = { accountId: leg.accountId, credit: total, nativeAmount: leg.nativeAmount, rate: leg.rate };
  } else {
    refundLine = { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables), credit: total, partyId: sale.customerId };
  }

  const journalId = await postJournal(tx, {
    date: input.date,
    type: "sale_return",
    memo: `Retour ${number} sur la vente ${sale.number} : ${input.reason}`,
    sourceType: "sale_return",
    sourceId: ret.id,
    userId,
    lines: [
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.sales), debit: total },
      refundLine,
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory), debit: cogsTotal },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.cogs), credit: cogsTotal },
    ],
  });
  await linkMovementsToJournal(tx, "sale_return", ret.id, journalId);
  await tx.update(saleReturns).set({ total: total.toFixed(2), cogs: cogsTotal.toFixed(2), journalId }).where(eq(saleReturns.id, ret.id));
  return getSale(tx, saleId);
}
