import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { frDate, frMoney, frNumber } from "@shared/french";
import {
  accounts,
  journalLines,
  journals,
  locations,
  motorcycleUnits,
  parties,
  products,
  saleLines,
  salePayments,
  saleReturnLines,
  saleReturns,
  sales,
  settings,
  users,
  variants,
  type Role,
} from "@shared/schema";
import { allocateCents, cents, dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, forbidden, notFound, wholeUnitError } from "../errors";
import { wholeUnit } from "@shared/units";
import { lockBalances, moneyLeg, nextNumber, postJournal, resolveRate, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId, type PostLine } from "./ledger";
import { issueStock, linkMovementsToJournal, lockVariants, receiveStock, stockQty } from "./stock";

/**
 * Francs cannot be counted to the cent of a dollar: a sale paid partly in francs may be over or under
 * by up to 100 FC, absorbed into exchange differences. Dollar-only sales must match to the cent.
 */
const FRANC_ROUNDING = new Decimal(100);

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
  /** Change handed back from another drawer, e.g. francs paid and dollars given back. */
  change?: SalePaymentInput | null;
  note?: string | null;
}

export interface PriceRules {
  role: Role;
}

/** The biggest discount a role may give on a line, in % of the list price, and whether it may sell below cost. */
export async function priceLimits(tx: Tx, role: Role): Promise<{ maxDiscountPct: Decimal | null; belowCost: boolean }> {
  if (role === "owner") return { maxDiscountPct: null, belowCost: true };
  const rows = await tx.select().from(settings).where(inArray(settings.key, ["cashierDiscountPct", "managerDiscountPct", "managerBelowCost"]));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const pct = role === "manager" ? get("managerDiscountPct") ?? "20" : get("cashierDiscountPct") ?? "10";
  return { maxDiscountPct: dec(String(pct)), belowCost: role === "manager" && get("managerBelowCost") === true };
}

export async function createSale(tx: Tx, input: CreateSaleInput, userId: number, rules?: PriceRules) {
  if (input.lines.length === 0) throw badRequest("Add at least one item", "Ajoutez au moins un article");
  const [location] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, input.locationId));
  if (!location) throw badRequest("That location does not exist", "Cet emplacement n'existe pas");

  const variantIds = Array.from(new Set(input.lines.map((l) => l.variantId)));
  // All the items at once, in id order (see lockVariants), so two sales of the same items cannot cross.
  await lockVariants(tx, variantIds);
  const variantRows = await tx
    .select({ id: variants.id, sku: variants.sku, name: products.name, tracksSerials: products.tracksSerials, unit: products.unit, active: variants.active, sellPrice: variants.sellPrice })
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
    if (!q.isInteger() && wholeUnit(v.unit)) throw wholeUnitError(`${v.name} (${v.sku})`);
    const price = cents(l.unitPrice);
    if (price.isNegative()) throw badRequest("Prices cannot be negative", "Les prix ne peuvent pas être négatifs");
    // 0 $ is almost always a price typed wrong ("4,50" read as nothing); a gift is a 100 % line discount instead.
    if (price.isZero()) throw badRequest(`${v.name} (${v.sku}): enter the selling price (it is 0 $)`, `${v.name} (${v.sku}) : saisissez le prix de vente (il est à 0 $)`);
    const lineDiscount = cents(l.lineDiscount ?? 0);
    if (lineDiscount.isNegative()) throw badRequest("A discount cannot be negative", "Une remise ne peut pas être négative");
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
  const limits = rules ? await priceLimits(tx, rules.role) : { maxDiscountPct: null, belowCost: true };
  if (limits.maxDiscountPct) {
    gross.forEach((g, i) => {
      const list = cents(g.q.times(g.variant.sellPrice));
      if (list.lte(0)) return;
      const given = list.minus(g.amount.minus(discountShares[i]));
      if (given.times(100).gt(list.times(limits.maxDiscountPct!))) {
        const pct = limits.maxDiscountPct!.toString();
        throw forbidden(
          `${g.variant.name}: the discount is more than the ${pct}% you may give. Ask the owner.`,
          `${g.variant.name} : la remise dépasse les ${pct} % autorisés. Demandez au propriétaire.`,
        );
      }
    });
  }

  // Every franc leg of a sale uses one rate, so francs taken at one rate cannot go back as change at
  // another. Staff take the day's rate; the owner may type one within the tolerance.
  const staffRate = !!rules && rules.role !== "owner";
  let saleRate: string | null | undefined = staffRate ? null : undefined;
  const legs = [];
  for (const p of input.payments) {
    const leg = await moneyLeg(tx, { accountId: p.accountId, amount: p.amount, rate: saleRate === undefined ? p.rate : saleRate, date: input.date });
    if (leg.rate && saleRate === undefined) saleRate = leg.rate;
    legs.push(leg);
  }
  const changeLeg = input.change && dec(input.change.amount).gt(0)
    ? await moneyLeg(tx, { accountId: input.change.accountId, amount: input.change.amount, rate: saleRate === undefined ? input.change.rate : saleRate, date: input.date })
    : null;
  const received = sum(legs.map((l) => l.usd));
  if (changeLeg && dec(changeLeg.usd).gte(received)) {
    throw badRequest("The change given back is more than the money received", "La monnaie rendue dépasse l'argent reçu");
  }
  const paid = received.minus(changeLeg?.usd ?? 0);
  const francLegs = [...legs, ...(changeLeg ? [changeLeg] : [])].filter((l) => l.currency === "CDF" && l.rate);
  const tolerance = francLegs.length
    ? Decimal.max(...francLegs.map((l) => FRANC_ROUNDING.dividedBy(l.rate!).toDecimalPlaces(2, Decimal.ROUND_UP)))
    : new Decimal(0);
  // The tolerance in dollars rounds up (0,04 $ at 2 808 FC is 112 FC): the francs over or under, counted
  // in francs at the sale's one rate, must also be 100 FC at most.
  const francRate = francLegs[0]?.rate ? dec(francLegs[0].rate) : null;
  const inFrancs = (l: { currency: string; usd: string; nativeAmount: string | null }) => (l.currency === "CDF" ? dec(l.nativeAmount!) : dec(l.usd).times(francRate!));
  const francGap = francRate ? total.times(francRate).minus(sum(legs.map(inFrancs))).plus(changeLeg ? inFrancs(changeLeg) : 0) : new Decimal(0);
  // Positive: the customer paid a few cents short (a loss); negative: a few cents over (a gain).
  let rounding = new Decimal(0);
  let credit = total.minus(paid);
  if (!credit.isZero() && credit.abs().lte(tolerance) && francGap.abs().lte(FRANC_ROUNDING)) {
    rounding = credit;
    credit = new Decimal(0);
  } else if (credit.isNegative()) {
    throw badRequest(
      "Payments are more than the total. Enter the change given back, or only the money kept.",
      "Les paiements dépassent le total. Indiquez la monnaie rendue, ou seulement l'argent encaissé.",
    );
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
      paidUsd: total.minus(credit).toFixed(2),
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
    if (!limits.belowCost && g.amount.minus(discountShares[i]).lt(cogs)) {
      // A cashier never sees cost, so the message does not give it.
      throw forbidden(
        rules?.role === "manager"
          ? `${g.variant.name}: ${g.amount.minus(discountShares[i]).toFixed(2)} is below its cost (${dec(cogs).toFixed(2)}). Only the owner can sell below cost.`
          : `${g.variant.name}: this price is too low. Ask the owner.`,
        rules?.role === "manager"
          ? `${g.variant.name} : ${frMoney(g.amount.minus(discountShares[i]))} est sous le coût (${frMoney(cogs)}). Seul le propriétaire peut vendre à perte.`
          : `${g.variant.name} : ce prix est trop bas. Demandez au propriétaire.`,
      );
    }
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
  if (changeLeg) {
    // Stored as a negative payment, so the drawer count for that account goes down by the change.
    await tx.insert(salePayments).values({
      saleId: sale.id,
      accountId: changeLeg.accountId,
      currency: changeLeg.currency,
      amountNative: cents(input.change!.amount).negated().toFixed(2),
      rate: changeLeg.rate,
      amountUsd: dec(changeLeg.usd).negated().toFixed(2),
    });
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
      ...(changeLeg ? [{ accountId: changeLeg.accountId, credit: changeLeg.usd, nativeAmount: changeLeg.nativeAmount, rate: changeLeg.rate, memo: "Monnaie rendue" }] : []),
      {
        accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.fx),
        debit: rounding.isPositive() ? rounding : 0,
        credit: rounding.isNegative() ? rounding.abs() : 0,
        memo: "Arrondi FC",
      },
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
      unit: products.unit,
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
  const returnRows = await tx.select().from(saleReturns).where(eq(saleReturns.saleId, id));
  // What came back on each return, for the return slip (no cost: cashiers read this too).
  const returnLines = returnRows.length
    ? await tx
        .select({ returnId: saleReturnLines.returnId, saleLineId: saleReturnLines.saleLineId, qty: saleReturnLines.qty, amount: saleReturnLines.amount })
        .from(saleReturnLines)
        .where(inArray(saleReturnLines.returnId, returnRows.map((r) => r.id)))
        .orderBy(asc(saleReturnLines.id))
    : [];
  // The money actually handed back on each return, in the drawer's own currency (francs for Caisse FC).
  const refundRows = returnRows.some((r) => r.journalId && r.refundAccountId)
    ? await tx
        .select({ journalId: journalLines.journalId, accountId: journalLines.accountId, credit: journalLines.credit, nativeAmount: journalLines.nativeAmount, rate: journalLines.rate, currency: accounts.currency })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(and(inArray(journalLines.journalId, returnRows.map((r) => r.journalId).filter((x): x is number => !!x)), eq(accounts.isMoney, true)))
    : [];
  const receivables = await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables);
  const toBalanceRows = returnRows.some((r) => r.journalId)
    ? await tx
        .select({ journalId: journalLines.journalId, credit: journalLines.credit })
        .from(journalLines)
        .where(and(inArray(journalLines.journalId, returnRows.map((r) => r.journalId).filter((x): x is number => !!x)), eq(journalLines.accountId, receivables)))
    : [];
  const returns = returnRows.map((r) => {
    const refund = refundRows.filter((x) => x.journalId === r.journalId && x.accountId === r.refundAccountId);
    // Francs handed back are worth what they were at the refund's rate; the drawer's line carries them at
    // their average cost, the difference being an exchange gain or loss, not money given to the customer.
    const refundUsd = sum(refund.map((x) => (x.currency === "CDF" && x.nativeAmount && x.rate && dec(x.rate).gt(0) ? cents(dec(x.nativeAmount).abs().dividedBy(x.rate)) : dec(x.credit))));
    const refundCurrency = refund[0]?.currency ?? null;
    const refundNative = refundCurrency === "CDF" ? sum(refund.map((x) => dec(x.nativeAmount ?? 0).abs())) : refundUsd;
    return {
      ...r,
      lines: returnLines.filter((l) => l.returnId === r.id).map(({ returnId: _r, ...l }) => l),
      refundUsd: refund.length ? refundUsd.toFixed(2) : null,
      refundNative: refund.length ? refundNative.toFixed(2) : null,
      refundCurrency,
      /** The part taken off what the customer owes instead of paid out. */
      refundToBalanceUsd: sum(toBalanceRows.filter((x) => x.journalId === r.journalId).map((x) => x.credit)).toFixed(2),
    };
  });
  const [customer] = sale.customerId ? await tx.select().from(parties).where(eq(parties.id, sale.customerId)) : [];
  const [cashier] = sale.createdBy ? await tx.select({ fullName: users.fullName, username: users.username }).from(users).where(eq(users.id, sale.createdBy)) : [];
  // The franc rounding as the Sales list reads it: the "Arrondi FC" lines on exchange differences, + when the
  // shop kept a few cents (the customer handed over a little more, or got a little less back on a refund).
  // `saleFcRoundingUsd` is the till's alone, for the receipt; `fcRoundingUsd` adds the returns' refunds.
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  const roundingRows = sale.journalId
    ? await tx
        .select({ journalId: journalLines.journalId, usd: sql<string>`(${journalLines.credit} - ${journalLines.debit})::text` })
        .from(journalLines)
        .where(and(eq(journalLines.accountId, fx), eq(journalLines.memo, "Arrondi FC"), inArray(journalLines.journalId, [sale.journalId, ...returnRows.map((r) => r.journalId).filter((x): x is number => !!x)])))
    : [];
  const saleFcRounding = sum(roundingRows.filter((r) => r.journalId === sale.journalId).map((r) => r.usd));
  const fcRounding = sum(roundingRows.map((r) => r.usd));
  // A credit sale to a customer holding an avoir (paid ahead) owes nothing new: the credit comes off that avoir.
  // Read from the customer's balance just after this sale was posted, so the receipt and the sale page say
  // what was covered then, and what avoir was left.
  let avoir: { usedUsd: string; leftUsd: string } | null = null;
  if (sale.customerId && sale.journalId && dec(sale.creditUsd).gt(0)) {
    const [after] = await tx
      .select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.partyId, sale.customerId), lte(journalLines.journalId, sale.journalId)));
    const before = dec(after.usd).minus(sale.creditUsd);
    const used = Decimal.min(dec(sale.creditUsd), Decimal.max(before.negated(), 0));
    if (used.gt(0)) avoir = { usedUsd: used.toFixed(2), leftUsd: Decimal.max(dec(after.usd).negated(), 0).toFixed(2) };
  }
  return {
    ...sale,
    saleFcRoundingUsd: saleFcRounding.toFixed(2),
    fcRoundingUsd: fcRounding.toFixed(2),
    /** The part of the credit covered by the customer's avoir at the time of the sale, and the avoir left after it. */
    avoirUsedUsd: avoir?.usedUsd ?? null,
    avoirLeftUsd: avoir?.leftUsd ?? null,
    customer: customer ?? null,
    cashierName: cashier ? cashier.fullName || cashier.username : null,
    lines: lines.map((l) => ({
      ...l.line,
      sku: l.sku,
      attributes: l.attributes,
      productName: l.productName,
      // So a return of "1.000" pieces is asked about (1 000 or 1?) rather than read as 1.
      unit: l.unit,
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
  // The items before the reversing journal (see lockVariants), as a sale of them locks them first.
  await lockVariants(tx, lines.map((l) => l.variantId));

  const voidJournalId = sale.journalId
    ? await reverseJournal(tx, sale.journalId, { date, type: "sale_void", memo: `Vente ${sale.number} annulée\u00a0: ${reason}`, userId })
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
    throw badRequest(`A return cannot be dated before the sale (${sale.date})`, `Un retour ne peut pas être daté avant la vente (${frDate(sale.date)})`);
  }
  if (!input.refundAccountId && !sale.customerId) {
    throw badRequest("This sale has no customer, so pick the account the refund is paid from", "Cette vente n'a pas de client : choisissez le compte qui paie le remboursement");
  }

  const lineRows = await tx
    .select()
    .from(saleLines)
    .where(and(eq(saleLines.saleId, saleId), inArray(saleLines.id, input.lines.map((l) => l.saleLineId))))
    .for("update");
  await lockVariants(tx, lineRows.map((l) => l.variantId));
  // What the customer owes decides how much of the refund comes off the debt (see lockBalances).
  await lockBalances(tx, { parties: [sale.customerId] });

  if (input.refundAccountId) {
    const [account] = await tx.select({ id: accounts.id, isMoney: accounts.isMoney }).from(accounts).where(eq(accounts.id, input.refundAccountId));
    if (!account?.isMoney) throw badRequest("Pick the cash box, bank or mobile money account the refund leaves", "Choisissez la caisse, la banque ou le compte mobile d'où part le remboursement");
  }
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
    if (q.lte(0) || q.gt(remaining)) throw badRequest(`You can return at most ${remaining.toString()} of that item`, `Vous pouvez retourner au maximum ${frNumber(remaining)} de cet article`);
    if (!q.isInteger()) {
      const [p] = await tx.select({ unit: products.unit, name: products.name, sku: variants.sku }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, line.variantId));
      if (p && wholeUnit(p.unit)) throw wholeUnitError(`${p.name} (${p.sku})`);
    }
    const isLast = q.equals(remaining);
    // Amount and cost already returned on this line, so the last return takes exactly what is left.
    const prior = await tx.select().from(saleReturnLines).where(eq(saleReturnLines.saleLineId, line.id));
    const priorAmount = sum(prior.map((p) => p.amount));
    const priorCogs = sum(prior.map((p) => p.cogs));
    // Each return takes its share of the running total, rounded once, so many small returns of a
    // decimal item add up to the same cents as one big return.
    const doneQty = dec(line.returnedQty).plus(q);
    const shareOf = (whole: string) => cents(dec(whole).times(doneQty).dividedBy(line.qty));
    const amount = isLast ? dec(line.lineTotal).minus(priorAmount) : Decimal.max(shareOf(line.lineTotal).minus(priorAmount), 0);
    const cogs = isLast ? dec(line.cogs).minus(priorCogs) : Decimal.max(shareOf(line.cogs).minus(priorCogs), 0);

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

  const receivables = await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables);
  // Goods sold on credit and not yet paid come off what the customer owes before any cash goes back:
  // a refund in cash of something never paid for would hand out money and leave the debt.
  let toDebt = new Decimal(0);
  if (sale.customerId && dec(sale.creditUsd).gt(0)) {
    const [prior] = await tx
      .select({ usd: sql<string>`coalesce(sum(${journalLines.credit}), 0)` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .innerJoin(saleReturns, and(eq(journals.sourceType, "sale_return"), eq(journals.sourceId, saleReturns.id)))
      .where(and(eq(saleReturns.saleId, saleId), eq(journalLines.accountId, receivables)));
    const [owed] = await tx
      .select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, receivables), eq(journalLines.partyId, sale.customerId), lte(journals.date, input.date)));
    const unpaidOnSale = Decimal.max(dec(sale.creditUsd).minus(prior.usd), 0);
    toDebt = Decimal.min(total, unpaidOnSale, Decimal.max(dec(owed.usd), 0));
  }
  const toCash = input.refundAccountId ? total.minus(toDebt) : new Decimal(0);
  const refundLines: PostLine[] = [];
  if (toCash.gt(0)) {
    const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.refundAccountId!));
    if (!acc) throw badRequest("Refund account not found", "Compte de remboursement introuvable");
    // Refund the USD value; for a CDF box, pay it out at the given rate.
    // Francs go back in 100 FC steps, rounded down so a refund never pays out more than was
    // returned: the few francs kept are the return's rounding, posted to the same "Arrondi FC" line
    // as a sale's. Under 100 FC nothing is handed back.
    const rate = acc.currency === "CDF" ? await resolveRate(tx, input.date, input.rate) : null;
    const native = rate ? toCash.times(rate).dividedBy(FRANC_ROUNDING).toDecimalPlaces(0, Decimal.ROUND_FLOOR).times(FRANC_ROUNDING) : toCash;
    let paidOut = new Decimal(0);
    if (native.gt(0)) {
      const leg = await moneyLeg(tx, { accountId: input.refundAccountId!, amount: native, rate, date: input.date });
      paidOut = rate ? Decimal.min(dec(leg.usd), toCash) : toCash;
      refundLines.push({ accountId: leg.accountId, credit: paidOut, nativeAmount: leg.nativeAmount, rate: leg.rate });
    }
    // Positive: the customer got a few cents less than the refund (a gain); negative: a few cents more (a loss).
    const rounding = toCash.minus(paidOut);
    if (!rounding.isZero()) {
      refundLines.push({
        accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.fx),
        debit: rounding.isNegative() ? rounding.abs() : 0,
        credit: rounding.isPositive() ? rounding : 0,
        memo: "Arrondi FC",
      });
    }
  }
  if (total.gt(toCash)) refundLines.push({ accountId: receivables, credit: total.minus(toCash), partyId: sale.customerId });

  const journalId = await postJournal(tx, {
    date: input.date,
    type: "sale_return",
    memo: `Retour ${number} sur la vente ${sale.number}\u00a0: ${input.reason}`,
    sourceType: "sale_return",
    sourceId: ret.id,
    userId,
    lines: [
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.sales), debit: total },
      ...refundLines,
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory), debit: cogsTotal },
      { accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.cogs), credit: cogsTotal },
    ],
  });
  await linkMovementsToJournal(tx, "sale_return", ret.id, journalId);
  await tx.update(saleReturns).set({ total: total.toFixed(2), cogs: cogsTotal.toFixed(2), journalId }).where(eq(saleReturns.id, ret.id));
  return getSale(tx, saleId);
}
