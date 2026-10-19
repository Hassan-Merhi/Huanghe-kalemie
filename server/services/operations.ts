import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  accounts,
  exchangeRates,
  expenses,
  journalLines,
  journals,
  motorcycleUnits,
  parties,
  partners,
  products,
  locations,
  stockAdjustments,
  stockMovements,
  variants,
} from "@shared/schema";
import { cents, dec, sum, Decimal, MoneyError, type DecimalInput } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, forbidden, notFound, wholeUnitError, francDecimalsError } from "../errors";
import { wholeUnit } from "@shared/units";
import {
  assertMemoNotReserved,
  cnyRateFor,
  COST_FX_MEMO,
  contactLines,
  foreignBalance,
  FRANCS_MET_SOURCE,
  bookValue,
  lockBalances,
  lockForeignBalances,
  moneyLeg,
  nextNumber,
  rateFor,
  resolveRate,
  rateTolerancePct,
  postJournal,
  REVALUATION_SOURCES,
  reverseJournal,
  shopToday,
  SYSTEM_ACCOUNTS,
  systemAccountId,
  toUsd,
  type ForeignCurrency,
  type PostLine,
  yuanTrueUpLines,
} from "./ledger";
import { issueStock, linkMovementsToJournal, lockVariants, receiveStock } from "./stock";
import { variantColour } from "./catalog";
import { de, frDate, frMoney, frNumber } from "@shared/french";

async function requireParty(tx: Tx, id: number | null | undefined, types: string[]) {
  if (!id) throw badRequest("Choose who this is for", "Choisissez le bénéficiaire");
  const [party] = await tx.select().from(parties).where(eq(parties.id, id));
  if (!party || !types.includes(party.type)) throw badRequest("That customer, supplier or agent does not exist", "Ce client, fournisseur ou agent n'existe pas");
  return party;
}

async function requirePartner(tx: Tx, id: number) {
  const [partner] = await tx.select().from(partners).where(eq(partners.id, id));
  if (!partner) throw notFound("Partner", "Associé introuvable");
  return partner;
}

// ---------------------------------------------------------------- Operating expenses

/** An amount typed in one currency must not be taken from an account in another. */
export function assertSameCurrency(typed: string | null | undefined, account: string) {
  if (typed && typed !== account) {
    throw badRequest(
      `The amount is in ${typed} but the account pays in ${account}. Pick an account in ${typed} or change the amount.`,
      `Le montant est en ${typed === "CDF" ? "FC" : typed} mais le compte paie en ${account === "CDF" ? "FC" : account}. Choisissez un compte en ${typed === "CDF" ? "FC" : typed} ou changez le montant.`,
    );
  }
}

/** Refuse an exchange whose implied rate is far from the day's rate (a typo in one of the two amounts). */
async function assertImpliedRate(tx: Tx, date: string, implied: Decimal, reference: Decimal, label: string, tolerancePct?: Decimal) {
  const tolerance = tolerancePct ?? (await rateTolerancePct(tx));
  if (reference.lte(0)) return;
  const gap = implied.minus(reference).abs().dividedBy(reference).times(100);
  if (gap.gt(tolerance)) {
    throw badRequest(
      `These amounts mean 1 USD = ${implied.toDecimalPlaces(2).toString()} ${label}, more than ${tolerance.toString()}% away from ${reference.toDecimalPlaces(2).toString()}. Check both amounts.`,
      `Ces montants donnent 1 $ = ${frNumber(implied.toDecimalPlaces(2).toString())} ${label === "CDF" ? "FC" : label === "CNY" ? "¥" : label}, soit plus de ${frNumber(tolerance.toString())} % d'écart avec ${frNumber(reference.toDecimalPlaces(2).toString())}. Vérifiez les deux montants.`,
    );
  }
}

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

/** Same words, whatever the case, accents or spacing ("carburant du groupe electrogene " = "Carburant du groupe électrogène"). */
const sameText = (a: string, b: string) => {
  const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return fold(a) === fold(b);
};

/** Rent, salaries, electricity… Dr the expense account, Cr the money account (or what is owed). */
export async function createExpense(tx: Tx, input: ExpenseInput, userId: number) {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!account || account.type !== "expense") throw badRequest("Pick an expense category", "Choisissez une catégorie de dépense");
  if (!!input.paidFromAccountId === !!input.payablePartyId) {
    throw badRequest("Say either which account paid this or who is owed for it", "Indiquez soit le compte qui a payé, soit à qui c'est dû");
  }
  const amount = cents(input.amount);
  if (amount.lte(0)) throw badRequest("Amount must be greater than zero", "Le montant doit être supérieur à zéro");

  let currency: "USD" | "CDF" = input.currency ?? "USD";
  let usd: string;
  let rate: string | null = null;
  let creditLine: PostLine;
  if (input.paidFromAccountId) {
    const leg = await moneyLeg(tx, { accountId: input.paidFromAccountId, amount, rate: input.rate, date: input.date });
    assertSameCurrency(input.currency, leg.currency);
    currency = leg.currency;
    usd = leg.usd;
    rate = leg.rate;
    creditLine = { accountId: leg.accountId, credit: usd, nativeAmount: leg.nativeAmount, rate: leg.rate };
  } else {
    await requireParty(tx, input.payablePartyId, ["supplier", "agent", "employee"]);
    if (currency === "CDF" && !amount.isInteger()) throw francDecimalsError(amount);
    rate = currency === "CDF" ? await resolveRate(tx, input.date, input.rate) : null;
    usd = toUsd(currency, amount, rate);
    // A bill in francs stays owed in francs on the contact.
    creditLine = {
      accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payables),
      credit: usd,
      partyId: input.payablePartyId,
      ...(currency === "CDF" ? { currency: "CDF" as const, nativeAmount: amount, rate } : {}),
    };
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
    // "Loyer : Loyer de mars", but not "Carburant : Carburant" when the description is the category's name.
    memo: sameText(input.description, account.name) ? account.name : `${account.name}\u00a0: ${input.description}`,
    sourceType: "expense",
    sourceId: expense.id,
    userId,
    lines: [{ accountId: account.id, debit: usd }, creditLine],
  });
  const [updated] = await tx.update(expenses).set({ journalId }).where(eq(expenses.id, expense.id)).returning();
  // A bill owed in francs is settled by any dollar advance already paid to that contact.
  if (input.payablePartyId && currency === "CDF") await applyAdvances(tx, input.payablePartyId, input.date, `Avance imputée sur la dépense ${input.description}`, userId, { type: "expense", id: expense.id }, "CDF");
  return updated;
}

export async function voidExpense(tx: Tx, id: number, date: string, userId: number) {
  const [expense] = await tx.select().from(expenses).where(eq(expenses.id, id)).for("update");
  if (!expense) throw notFound("Expense", "Dépense introuvable");
  if (expense.voidedAt) throw conflict("This expense is already cancelled", "Cette dépense est déjà annulée");
  const [j] = await tx.select({ type: journals.type, number: journals.number }).from(journals).where(eq(journals.id, expense.journalId!));
  if (j?.type === "payment") {
    throw conflict(`This expense is part of payment voucher ${j.number}. Cancel the voucher from the daybook.`, `Cette dépense fait partie de la pièce de paiement ${j.number}. Annulez la pièce depuis le journal du jour.`);
  }
  const voidJournalId = await reverseJournal(tx, expense.journalId!, { date, userId, memo: `Dépense annulée\u00a0: ${expense.description}` });
  await reverseAdvances(tx, { type: "expense", id: expense.id }, date, userId);
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
  if (input.fromAccountId === input.toAccountId) throw badRequest("Pick two different accounts", "Choisissez deux comptes différents");
  const from = await moneyLeg(tx, { accountId: input.fromAccountId, amount: input.fromAmount, date: input.date });
  const to = await moneyLeg(tx, { accountId: input.toAccountId, amount: input.toAmount, date: input.date });
  if (from.currency !== to.currency) {
    // Changing dollars and francs: the two amounts must agree with the day's rate.
    const usdSide = from.currency === "USD" ? cents(input.fromAmount) : cents(input.toAmount);
    const cdfSide = from.currency === "CDF" ? cents(input.fromAmount) : cents(input.toAmount);
    const day = dec(from.rate ?? to.rate!);
    await assertImpliedRate(tx, input.date, cdfSide.dividedBy(usdSide), day, "CDF");
  } else if (!cents(input.fromAmount).equals(cents(input.toAmount))) {
    throw badRequest("A transfer in one currency must send and receive the same amount", "Un transfert dans la même devise doit envoyer et recevoir le même montant");
  }
  // What the money leaving is worth: dollars at face value, francs at what they cost on average, read
  // under the same locks the journal takes (see lockForeignBalances).
  await lockForeignBalances(tx, [from, to].filter((l) => l.currency === "CDF").map((l) => ({ accountId: l.accountId, partyId: null, currency: "CDF" })));
  let value = dec(from.usd);
  if (from.currency === "CDF") {
    const bal = await foreignBalance(tx, from.accountId, null, "CDF", input.date);
    value = bookValue(bal, dec(from.nativeAmount), dec(from.usd));
  }
  // Francs bought with dollars cost exactly the dollars paid; dollars received are worth their face value.
  const received = to.currency === "USD" ? dec(to.usd) : value;
  const toRate = to.currency === "CDF" && received.gt(0) ? dec(to.nativeAmount).dividedBy(received).toFixed(4) : to.rate;
  const diff = value.minus(received);
  const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
  return postJournal(tx, {
    date: input.date,
    type: "transfer",
    memo: input.memo ?? "Transfert",
    userId,
    lines: [
      { accountId: to.accountId, debit: received, nativeAmount: to.nativeAmount, rate: toRate },
      { accountId: from.accountId, credit: value, nativeAmount: from.nativeAmount, rate: from.rate },
      { accountId: fx, debit: diff.isPositive() ? diff : 0, credit: diff.isNegative() ? diff.abs() : 0, memo: "Écart de change" },
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
  /** Paying a supplier owed in yuan: how many yuan this payment settles. */
  settleNative?: string | null;
}

/** A customer pays what they owe. */
export async function receiveFromCustomer(tx: Tx, input: PartyPaymentInput, userId: number) {
  const party = await requireParty(tx, input.partyId, ["customer"]);
  // What they owe in francs and dollars decides the split, so one payment at a time per customer.
  await lockBalances(tx, { parties: [party.id] });
  const leg = await moneyLeg(tx, input);
  const receivables = await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables);
  return postJournal(tx, {
    date: input.date,
    type: "customer_receipt",
    memo: input.memo ?? `Paiement ${de(party.name)}`,
    userId,
    lines: [
      { accountId: leg.accountId, debit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate },
      ...(await contactLines(tx, { accountId: receivables, partyId: party.id, side: "credit", usd: leg.usd, money: leg, date: input.date })),
    ],
  });
}

/**
 * Lines applying a dollar advance paid to a supplier to the yuan they are still owed (beyond
 * `settledNative`, already settled by the same entry), so they are not paid twice. The yuan go at
 * the yuan rate on file, else at their cost; the exchange difference is booked when posted.
 */
export async function advanceToYuanLines(tx: Tx, payables: number, partyId: number, date: string, settledNative: Decimal = new Decimal(0)): Promise<PostLine[]> {
  // The advance read here must not be taken by another bill at the same time (see lockBalances).
  await lockBalances(tx, { parties: [partyId] });
  const cny = await foreignBalance(tx, payables, partyId, "CNY", date);
  if (!cny.native.isNegative() || !cny.usd.isNegative()) return [];
  const owedNative = cny.native.abs();
  let left = owedNative.minus(settledNative);
  if (left.lte(0)) return [];
  const dayRate = await cnyRateFor(tx, date);
  const usdOf = (n: Decimal) => (dayRate ? cents(n.dividedBy(dayRate)) : cents(cny.usd.abs().times(n).dividedBy(owedNative)));
  const nativeOf = (u: Decimal) => (dayRate ? cents(u.times(dayRate)) : cents(owedNative.times(u).dividedBy(cny.usd.abs())));
  const lines: PostLine[] = [];
  const yuanLine = (usd: Decimal, native: Decimal): PostLine => ({ accountId: payables, partyId, debit: usd, currency: "CNY", nativeAmount: native, rate: native.dividedBy(usd).toFixed(4), memo: "Avance imputée" });

  // Dollars paid in advance.
  const advance = Decimal.max((await foreignBalance(tx, payables, partyId, "USD", date)).usd, 0);
  if (advance.gt(0)) {
    const leftUsd = usdOf(left);
    const applyUsd = Decimal.min(advance, leftUsd);
    const applyNative = applyUsd.equals(leftUsd) ? left : nativeOf(applyUsd);
    if (applyUsd.gt(0) && applyNative.gt(0)) {
      lines.push(yuanLine(applyUsd, applyNative), { accountId: payables, partyId, credit: applyUsd, memo: "Avance imputée" });
      left = left.minus(applyNative);
    }
  }
  // Francs paid in advance, at the day's franc rate; each side leaves at its own cost when posted.
  const fc = await foreignBalance(tx, payables, partyId, "CDF", date);
  if (left.gt(0) && fc.native.gt(0) && fc.usd.gt(0)) {
    const fcRate = (await rateFor(tx, date)).rate;
    const fcUsd = cents(fc.native.dividedBy(fcRate));
    const leftUsd = usdOf(left);
    const applyUsd = Decimal.min(fcUsd, leftUsd);
    const applyNative = applyUsd.equals(leftUsd) ? left : nativeOf(applyUsd);
    // Whole francs leave the deposit (down, so it never gives more than the yuan take): a part of a franc
    // left on it could never be used. The francs are valued at their cost when posted, so the dollars stand.
    const francs = applyUsd.equals(fcUsd) ? fc.native : applyUsd.times(fcRate).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    if (applyUsd.gt(0) && applyNative.gt(0) && francs.gt(0)) {
      lines.push(yuanLine(applyUsd, applyNative), { accountId: payables, partyId, credit: applyUsd, currency: "CDF", nativeAmount: francs, rate: fcRate.toFixed(4), memo: "Avance imputée" });
    }
  }
  return lines;
}

/**
 * Lines applying a dollar advance to francs a supplier or employee is owed, at the day's franc rate.
 * Francs paid to them settle francs owed before dollars do, in date order: on a day before today, only
 * the francs still owed both that day and today take dollars (francs paid since settle the rest).
 */
export async function advanceToFrancLines(tx: Tx, payables: number, partyId: number, date: string): Promise<PostLine[]> {
  await lockBalances(tx, { parties: [partyId] });
  const fc = await foreignBalance(tx, payables, partyId, "CDF", date);
  const today = shopToday();
  const now = date < today ? await foreignBalance(tx, payables, partyId, "CDF", today) : fc;
  if (!fc.native.isNegative() || !fc.usd.isNegative() || !now.native.isNegative()) return [];
  const advance = Decimal.max((await foreignBalance(tx, payables, partyId, "USD", date)).usd, 0);
  if (advance.isZero()) return [];
  const fcRate = (await rateFor(tx, date)).rate;
  const owedNative = Decimal.min(fc.native.abs(), now.native.abs());
  const owedUsd = cents(owedNative.dividedBy(fcRate));
  let applyUsd = Decimal.min(advance, owedUsd);
  let francs = owedNative;
  if (!applyUsd.equals(owedUsd)) {
    // Part of what is owed: whole francs (down, so the advance never settles more than it is worth), and
    // the dollars they are worth. A part of a franc left owed could never be paid off.
    francs = applyUsd.times(fcRate).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    applyUsd = Decimal.min(cents(francs.dividedBy(fcRate)), applyUsd);
  }
  if (applyUsd.lte(0) || francs.lte(0)) return [];
  return [
    { accountId: payables, partyId, debit: applyUsd, currency: "CDF", nativeAmount: francs, rate: fcRate.toFixed(4), memo: "Avance imputée" },
    { accountId: payables, partyId, credit: applyUsd, memo: "Avance imputée" },
  ];
}

/**
 * Apply what was paid ahead to a contact (dollars, or francs for yuan) to what they are now owed in
 * yuan or francs, in one journal, so the same money is not paid twice. Used when a bill is booked.
 */
export async function applyAdvances(
  tx: Tx,
  partyId: number,
  date: string,
  memo: string,
  userId: number,
  source: { type: AdvanceSource; id: number },
  currency: "CNY" | "CDF",
): Promise<number | null> {
  // One bill at a time per contact takes their advance: a yuan bill and a franc bill posted together
  // would otherwise both take the same dollars. The bill's own journal took this lock already.
  await lockBalances(tx, { parties: [partyId] });
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  // Only the bill's own currency, so undoing the bill gives back exactly what it took.
  const linesOn = (on: string) => (currency === "CNY" ? advanceToYuanLines(tx, payables, partyId, on) : advanceToFrancLines(tx, payables, partyId, on));
  const post = async (on: string, lines: PostLine[]) =>
    postJournal(tx, { date: on, type: "supplier_payment", memo, userId, lines, sourceType: `advance_${source.type}`, sourceId: source.id });
  let first: number | null = null;
  const lines = await linesOn(date);
  if (lines.length) first = await post(date, lines);
  // Deposits paid since a bill dated before them: each settles it from the day it was paid (each day after
  // the bill on which dollars or francs were paid to the contact, its own part in a journal of its own), not
  // from today, so yuan work dated in between is not refused for a date the books chose (see
  // assertYuanInOrder). Only days after which nothing has taken from that advance yet, so what it holds
  // then is still there (and what one day applies leaves the next day's deposit whole); what is left is
  // applied today, as before. Those days are in open months: the bill's month is open, and so is every later
  // one. Undone (see reverseAdvances), every part goes back.
  if (date < shopToday()) {
    const days = await tx
      .select({ date: journals.date, paid: sql<boolean>`bool_or(${journalLines.debit} > 0)`, taken: sql<boolean>`bool_or(${journalLines.credit} > 0)` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(
        and(
          eq(journalLines.accountId, payables),
          eq(journalLines.partyId, partyId),
          inArray(journalLines.currency, ["USD", "CDF"]),
          sql`${journals.date} > ${date}`,
          lte(journals.date, shopToday()),
        ),
      )
      .groupBy(journals.date)
      .orderBy(journals.date);
    const paidOn = days.filter((d, i) => d.paid && !days.slice(i + 1).some((later) => later.taken)).map((d) => String(d.date));
    for (const on of Array.from(new Set([...paidOn, shopToday()]))) {
      const more = await linesOn(on);
      if (!more.length) continue;
      const id = await post(on, more);
      first ??= id;
    }
    if (currency === "CDF") {
      const id = await francsMetLines(tx, payables, partyId, date, days.filter((d) => d.paid).map((d) => String(d.date)), post);
      first ??= id;
    }
  }
  return first;
}

/**
 * Francs paid to a contact after a franc bill dated before them settle it as they come (they are the same
 * balance), before any dollar advance does (see advanceToFrancLines). They were booked at what they cost
 * then, the bill at its own rate: on the first day they leave no francs owed or held, the dollars left
 * between the two go to exchange differences, as they would have had the bill been booked first (see
 * costForeignOutflows). Francs worth under half a cent at that day's rate count as none, and go with the
 * dollars when a line can carry them (francs owed with dollars owed), else stay at no dollars, as the
 * residue a posting leaves does. Only what the rates of those francs explain: the bill's francs at the
 * lowest against the highest rate, plus a cent a line, and what a month-end revaluation of them restated
 * (a bill reversed since took its share of it, while francs paid dated before had left at a cost that
 * held it); more is for a person to correct (see selfCheck). The balance is a contact's on `accountId`,
 * or, with no contact, a balance sheet account's settled like one (withholdings to remit).
 * Undone with the bill's advances (see reverseAdvances).
 */
async function francsMetLines(tx: Tx, accountId: number, partyId: number | null, date: string, paidOn: string[], post: (on: string, lines: PostLine[]) => Promise<number | null>) {
  const party = partyId ? eq(journalLines.partyId, partyId) : isNull(journalLines.partyId);
  for (const on of Array.from(new Set(paidOn)).sort()) {
    const bal = await foreignBalance(tx, accountId, partyId, "CDF", on);
    const rate = (await rateFor(tx, on)).rate;
    if (!bal.native.abs().dividedBy(rate).lt("0.005") || bal.usd.isZero()) continue;
    const rows = await tx
      .select({ native: journalLines.nativeAmount, rate: journalLines.rate })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, accountId), party, eq(journalLines.currency, "CDF"), sql`${journals.date} >= ${date}`, lte(journals.date, on)));
    const posts = rows.filter((r) => r.native && !dec(r.native).isZero() && r.rate && dec(r.rate).gt(0));
    if (!posts.length) return null;
    const rates = posts.map((r) => dec(r.rate!));
    const billed = sum(posts.filter((r) => dec(r.native!).isNegative()).map((r) => dec(r.native!).abs()));
    // What the months' revaluations hold on the balance that day (see REVALUATION_SOURCES), and what a
    // container's reversal took back from the exchange differences of its francs' payments, so the claim
    // it leaves is worth what was paid (see yuanTrueUpLines): a bill dated before that day meets that
    // claim, and the difference is the bill's exchange difference, as it would be had it been booked first.
    const [reval] = await tx
      .select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, accountId), party, eq(journalLines.currency, "CDF"), eq(journals.type, "revaluation"), inArray(journals.sourceType, REVALUATION_SOURCES), lte(journals.date, on)));
    const [taken] = await tx
      .select({ usd: sql<string>`coalesce(sum(abs(${journalLines.debit} - ${journalLines.credit})), 0)` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, accountId), party, eq(journalLines.currency, "CDF"), eq(journalLines.kind, "settled_fx"), sql`${journals.date} >= ${date}`, lte(journals.date, on)));
    const revalued = dec(reval?.usd ?? 0).abs().plus(dec(taken?.usd ?? 0));
    const bound = billed.times(new Decimal(1).dividedBy(Decimal.min(...rates)).minus(new Decimal(1).dividedBy(Decimal.max(...rates)))).plus(new Decimal("0.01").times(posts.length)).plus(revalued);
    if (bal.usd.abs().gt(bound)) return null;
    // The francs go on the line only on the side that takes them off (a debit brings francs in).
    const francs = bal.native.isNegative() === bal.usd.isNegative() ? bal.native.abs() : new Decimal(0);
    const fx = await systemAccountId(tx, SYSTEM_ACCOUNTS.fx);
    return post(on, [
      { accountId, partyId, currency: "CDF", nativeAmount: francs.toFixed(2), rate: rate.toFixed(4), debit: bal.usd.isNegative() ? bal.usd.abs() : 0, credit: bal.usd.isPositive() ? bal.usd : 0, memo: COST_FX_MEMO, kind: "cost_fx" },
      { accountId: fx, debit: bal.usd.isPositive() ? bal.usd : 0, credit: bal.usd.isNegative() ? bal.usd.abs() : 0, memo: COST_FX_MEMO, kind: "cost_fx" },
    ]);
  }
  return null;
}

/**
 * Francs paid to (or received from) a supplier, agent or employee, or paid on a balance sheet account
 * settled like a contact (withholdings to remit), dated before a franc entry already on them (a bill
 * booked first, the payment typed afterwards for an earlier day) settle it as they come too: the bill is
 * not taken out again at what the francs cost, so the dollars left between the two on the first day they
 * leave no francs owed or held go to exchange differences, as francsMetLines does for a bill dated before
 * francs already paid. Undone with the journal (see reverseJournal).
 */
export async function francsMetAfter(tx: Tx, journalId: number | null, date: string, userId: number): Promise<void> {
  if (!journalId) return;
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const own = await tx
    .select({ accountId: journalLines.accountId, partyId: journalLines.partyId, type: accounts.type, isMoney: accounts.isMoney, systemKey: accounts.systemKey })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalLines.journalId, journalId), eq(journalLines.currency, "CDF")));
  const keys = new Map<string, { accountId: number; partyId: number | null }>();
  for (const l of own) {
    const settled = l.accountId === payables ? !!l.partyId : !l.partyId && !l.isMoney && (l.type === "asset" || l.type === "liability") && l.systemKey !== SYSTEM_ACCOUNTS.receivables;
    if (settled) keys.set(`${l.accountId}|${l.partyId ?? ""}`, { accountId: l.accountId, partyId: l.partyId });
  }
  for (const key of keys.values()) {
    const later = await tx
      .selectDistinct({ date: journals.date })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, key.accountId), key.partyId ? eq(journalLines.partyId, key.partyId) : isNull(journalLines.partyId), eq(journalLines.currency, "CDF"), gt(journals.date, date)))
      .orderBy(journals.date);
    if (!later.length) continue;
    await francsMetLines(tx, key.accountId, key.partyId, date, later.map((d) => String(d.date)), (on, lines) =>
      postJournal(tx, {
        date: on,
        type: "supplier_payment",
        memo: key.partyId ? `Francs du ${frDate(date)} imputés sur la facture du ${frDate(on)}` : `Francs du ${frDate(date)} imputés sur les francs dus au ${frDate(on)}`,
        userId,
        lines,
        sourceType: FRANCS_MET_SOURCE,
        sourceId: journalId,
      }),
    );
  }
}

export type AdvanceSource = "expense" | "container_expense" | "container" | "payroll";

/**
 * Undo the advances a bill took when the bill itself is undone, so the advance is a dollar advance again.
 * `memo` names what was undone when it is not an invoice (a payroll run); the reversal is the same.
 */
export async function reverseAdvances(tx: Tx, source: { type: AdvanceSource; id: number }, date: string, userId: number, memo = "Avance rendue\u00a0: la facture est annulée") {
  const rows = await tx
    .select({ id: journals.id, date: journals.date })
    .from(journals)
    .where(and(eq(journals.sourceType, `advance_${source.type}`), eq(journals.sourceId, source.id), isNull(journals.reversedByJournalId), isNull(journals.reversesJournalId)))
    // The latest part first: each undone gives back the advance the one before it left.
    .orderBy(desc(journals.id));
  for (const r of rows) await reverseJournal(tx, r.id, { date: date < r.date ? r.date : date, userId, memo });
}

/**
 * The payables side of money paid to a supplier, agent or employee. When they are owed in yuan (and
 * not in francs), the money settles, after any dollars owed, the yuan: as many yuan as the money
 * buys at the yuan rate on file (else at what the yuan cost), and the exchange difference goes to
 * gains or losses when posted. Only what is left goes through the usual dollar and franc balances.
 */
export async function payablesLines(
  tx: Tx,
  input: { payables: number; partyId: number; usd: DecimalInput; money: { currency: string; nativeAmount: string | null; rate: string | null }; date: string; memo?: string | null },
): Promise<PostLine[]> {
  const { payables, partyId } = input;
  // The yuan, francs and dollars owed decide the split, so one payment at a time per contact.
  await lockBalances(tx, { parties: [partyId] });
  const cny = await foreignBalance(tx, payables, partyId, "CNY", input.date);
  const fcOwed = (await foreignBalance(tx, payables, partyId, "CDF", input.date)).native.negated();
  const usdBalance = (await foreignBalance(tx, payables, partyId, "USD", input.date)).usd;
  const usdOwed = Decimal.max(usdBalance.negated(), 0);
  const total = cents(input.usd);
  const memo = input.memo ?? null;
  let cnyUsd = new Decimal(0);
  const lines: PostLine[] = [];
  if (cny.native.isNegative() && cny.usd.isNegative() && !fcOwed.gt(0)) {
    const owedNative = cny.native.abs();
    const available = Decimal.max(total.minus(usdOwed), 0);
    const dayRate = await cnyRateFor(tx, input.date);
    let native = new Decimal(0);
    if (available.gt(0) && dayRate) {
      // The dollars shown for all the yuan owed settle all of them (as with francs, see contactLines): the
      // yuan they buy, rounded to the fen, would leave a few worth less than a cent. Yuan worth under half
      // a cent show as 0 $; the journal clears them with no money (see costForeignOutflows).
      const allUsd = cents(owedNative.dividedBy(dayRate));
      if (available.gte(allUsd)) {
        native = owedNative;
        cnyUsd = allUsd;
      } else {
        native = Decimal.min(cents(available.times(dayRate)), owedNative);
        cnyUsd = available;
      }
    } else if (available.gt(0)) {
      cnyUsd = Decimal.min(available, cny.usd.abs());
      native = cnyUsd.equals(cny.usd.abs()) ? owedNative : cents(owedNative.times(cnyUsd).dividedBy(cny.usd.abs()));
    }
    if (cnyUsd.gt(0) && native.gt(0)) {
      lines.push({ accountId: payables, partyId, debit: cnyUsd, currency: "CNY", nativeAmount: native, rate: native.dividedBy(cnyUsd).toFixed(4), memo });
    } else {
      cnyUsd = new Decimal(0);
      native = new Decimal(0);
    }
    lines.push(...(await advanceToYuanLines(tx, payables, partyId, input.date, native)));
  }
  const rest = total.minus(cnyUsd);
  if (rest.gt(0)) {
    const restNative = input.money.nativeAmount
      ? cnyUsd.isZero()
        ? dec(input.money.nativeAmount)
        : // Whole francs on what is left (an advance in francs), so no part of a franc is left on it.
          dec(input.money.nativeAmount).times(rest).dividedBy(total).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
      : null;
    lines.push(
      ...(await contactLines(tx, {
        accountId: payables,
        partyId,
        side: "debit",
        usd: rest,
        money: { currency: input.money.currency, nativeAmount: restNative ? restNative.toFixed(2) : null, rate: input.money.rate },
        date: input.date,
        memo,
      })),
    );
  }
  return lines;
}

/** Yuan to settle are a count of yuan: fewer than none is a typo, never "none". */
export const negativeSettleError = () => badRequest("The yuan to settle cannot be negative", "Les yuans à solder ne peuvent pas être négatifs");

/**
 * The payables side of money received from a supplier, agent or employee: payablesLines the other way.
 * When they owe us yuan (a paid yuan bill since undone) and no francs, the money settles, after any
 * dollars they owe, the yuan it covers at what those yuan cost on the books (so no rate entered for the
 * day changes how many it settles, and no exchange difference comes of it): all of them when it covers
 * their cost, else as many as it buys at that cost. Never more yuan than they owe both on the receipt's
 * date and today (a receipt dated back cannot settle yuan a later one already settled). Settling all the
 * yuan named by `settleNative` for less than their cost writes the difference off to gains or losses:
 * only on that explicit request, within 1 % of their exact cost before it is rounded to the cent (the
 * owner: within 5 %, as a payment of yuan allows, so refunding exactly what was paid can always close yuan
 * a revaluation or a back-dated reversal left at more than that). Only what
 * is left goes through the usual dollar and franc balances (see contactLines). Every line is a credit:
 * nothing goes out.
 */
export async function payablesReceiptLines(
  tx: Tx,
  input: {
    payables: number;
    partyId: number;
    usd: DecimalInput;
    money: { currency: string; nativeAmount: string | null; rate: string | null };
    date: string;
    memo?: string | null;
    settleNative?: string | null;
    name?: string;
    owner?: boolean;
  },
): Promise<PostLine[]> {
  const { payables, partyId } = input;
  const name = input.name ?? "This contact";
  // The yuan, francs and dollars owed decide the split, so one posting at a time per contact.
  await lockBalances(tx, { parties: [partyId] });
  const cny = await foreignBalance(tx, payables, partyId, "CNY", input.date);
  const cnyToday = await foreignBalance(tx, payables, partyId, "CNY");
  const fcClaim = (await foreignBalance(tx, payables, partyId, "CDF", input.date)).native;
  const usdClaim = Decimal.max((await foreignBalance(tx, payables, partyId, "USD", input.date)).usd, 0);
  const total = cents(input.usd);
  const memo = input.memo ?? null;
  const claimed = cny.native.gt(0) && cny.usd.gt(0);
  // The yuan they owe on the receipt's date and still owe today.
  const claimNative = claimed ? Decimal.max(Decimal.min(cny.native, cnyToday.native), 0) : new Decimal(0);
  // What `native` of those yuan cost on the books, as the journal takes them out (see costForeignOutflows).
  const cost = (native: Decimal) => bookValue(cny, native, new Decimal(0));
  if (input.settleNative && dec(input.settleNative).isNegative()) throw negativeSettleError();
  const settle = input.settleNative && dec(input.settleNative).gt(0) ? cents(input.settleNative) : null;
  let cnyUsd = new Decimal(0);
  let native = new Decimal(0);
  const lines: PostLine[] = [];
  if (settle) {
    if (claimNative.lte(0)) throw badRequest(`${name} owes nothing in yuan on that date and today`, `${name} ne doit rien en yuans à cette date et aujourd'hui`);
    if (settle.gt(claimNative)) throw badRequest(`${name} owes only ${claimNative.toFixed(2)} CNY on that date and today`, `${name} ne doit que ${frMoney(claimNative, "CNY")} à cette date et aujourd'hui`);
    if (input.money.currency !== "USD") throw badRequest("Receive yuan owed into a dollar account", "Encaissez des yuans dus sur un compte en dollars");
    const value = cost(settle);
    // Their exact cost: rounded half up to the cent, 0,10 ¥ worth 0,014 $ would read as 0,01 $ and pass,
    // and a run of cent receipts settle the yuan below cost (as payablesReceiptLines' own split avoids).
    const exact = settle.equals(cny.native) ? cny.usd : cny.usd.times(settle).dividedBy(cny.native);
    if (total.lt(exact)) {
      // Less than what the yuan cost: the rest is a loss shared by the partners, so only a small one.
      // Staff get 1 %, below the 3 % franc tolerance: the yuan's cost moves with no rate anybody enters,
      // so only a bank's fee or rounding can explain a gap. The owner gets the 5 % a yuan payment allows:
      // a gap the month-end revaluation put back on a claim the reversal had brought to what was paid.
      const limit = input.owner ? new Decimal(5) : Decimal.min(await rateTolerancePct(tx), 1);
      const gap = exact.minus(total).dividedBy(exact).times(100);
      if (gap.gt(limit)) {
        // To four places when the cent hides the gap (0,0141 $, not 0,01 $).
        const places = cents(exact).equals(exact) ? 2 : 4;
        throw badRequest(
          `${total.toFixed(2)} $ is ${gap.toFixed(2)} % less than the ${exact.toFixed(places)} $ the ${settle.toFixed(2)} CNY cost: at most ${limit.toFixed(0)} % can be written off. Receive it without settling all the yuan.`,
          `${frMoney(total)} est ${frNumber(gap, 2)} % en dessous des ${frNumber(exact, places)}\u00a0$ qu'ont coûté les ${frMoney(settle, "CNY")} : au plus ${frNumber(limit, 0)} % peuvent être passés en perte. Encaissez sans solder tous les yuans.`,
        );
      }
      cnyUsd = total;
    } else cnyUsd = value;
    native = settle;
  } else if (claimNative.gt(0) && !fcClaim.gt(0)) {
    const available = Decimal.max(total.minus(usdClaim), 0);
    const allUsd = cost(claimNative);
    if (available.gte(allUsd)) {
      native = claimNative;
      cnyUsd = allUsd;
    } else if (available.gt(0)) {
      // As many yuan as the dollars cover at their cost, to the fen: the most whose exact cost, before it is
      // rounded to the cent, is no more than the dollars. Never more: on a cent, rounding the cost half up
      // would let 0,10 ¥ worth 0,014 $ go for 0,01 $, and a run of cent receipts settle the yuan below cost.
      native = Decimal.min(available.times(cny.native).dividedBy(cny.usd).toDecimalPlaces(2, Decimal.ROUND_FLOOR), claimNative);
      cnyUsd = available;
    }
  }
  if (cnyUsd.gt(0) && native.gt(0)) {
    lines.push({ accountId: payables, partyId, credit: cnyUsd, currency: "CNY", nativeAmount: native, rate: native.dividedBy(cnyUsd).toFixed(4), memo });
  } else cnyUsd = new Decimal(0);
  const rest = total.minus(cnyUsd);
  if (rest.gt(0)) {
    const restNative = input.money.nativeAmount
      ? cnyUsd.isZero()
        ? dec(input.money.nativeAmount)
        : dec(input.money.nativeAmount).times(rest).dividedBy(total).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
      : null;
    lines.push(
      ...(await contactLines(tx, {
        accountId: payables,
        partyId,
        side: "credit",
        usd: rest,
        money: { currency: input.money.currency, nativeAmount: restNative ? restNative.toFixed(2) : null, rate: input.money.rate },
        date: input.date,
        memo,
      })),
    );
  }
  return lines;
}

/**
 * The lines by which a container's reversal takes back the exchange differences its yuan's payments booked.
 * Paying yuan settles them at what they cost on the books, and the gap from the dollars paid (a discount
 * within the 5 % a payment allows, or the rate's move) goes to gains or losses. Once the container is
 * undone, the yuan paid against its bill pay the next bill of the supplier still owed, and the rest come
 * back as yuan the supplier owes us, at what was paid for them: were they to come back at the invoice's
 * dollars, refunding exactly what was paid would leave yuan nobody could clear, and the discount would
 * stay as profit. What a month-end revaluation left on the yuan still owed goes with the bill in the
 * share of its yuan, so the yuan still owed keep theirs. A franc bill the same (`currency` "CDF"). The
 * supplier's whole yuan history counts, in the order it was posted, whatever the dates (see
 * yuanTrueUpLines). The caller holds the supplier's lock.
 */
export async function settledFxTakebackLines(
  tx: Tx,
  input: { payables: number; partyId: number; currency: ForeignCurrency; billJournalId: number; native: Decimal; usd: DecimalInput; rate: DecimalInput },
): Promise<PostLine[]> {
  return yuanTrueUpLines(tx, { payables: input.payables, partyId: input.partyId, currency: input.currency, bill: input.billJournalId, native: input.native, usd: dec(input.usd), rate: input.rate });
}

/** The date of a contact's first yuan owed to them dated after `date`, if any. Read only. */
async function yuanDebtAfter(tx: Tx, payables: number, partyId: number, date: string): Promise<string | null> {
  const [row] = await tx
    .select({ date: sql<string | null>`min(${journals.date})::text` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, "CNY"), sql`${journalLines.nativeAmount} < 0`, sql`${journals.date} > ${date}`));
  return row?.date ?? null;
}

/** Pay a supplier or agent (container invoice, clearing agent, transporter, unpaid bills). */
export async function payParty(tx: Tx, input: PartyPaymentInput, userId: number) {
  const party = await requireParty(tx, input.partyId, ["supplier", "agent", "employee"]);
  // Before any of their balances is read (see payablesLines).
  await lockBalances(tx, { parties: [party.id] });
  const leg = await moneyLeg(tx, input);
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  let partyLines: PostLine[];
  if (input.settleNative && dec(input.settleNative).isNegative()) throw negativeSettleError();
  if (input.settleNative && dec(input.settleNative).gt(0)) {
    // Dollars paid against an invoice in yuan: the yuan settled leave at their book cost.
    // A dollar advance goes to the yuan first; only what is left is owed.
    const advanceLines = await advanceToYuanLines(tx, payables, party.id, input.date);
    const cny = await foreignBalance(tx, payables, party.id, "CNY", input.date);
    const owed = cny.native.negated().minus(sum(advanceLines.filter((l) => l.currency === "CNY").map((l) => dec(l.nativeAmount!))));
    const settle = cents(input.settleNative);
    if (owed.lte(0)) {
      // Measured on the payment's date: a back-dated payment says so, and when the yuan debt starts.
      const start = await yuanDebtAfter(tx, payables, party.id, input.date);
      throw badRequest(
        `${party.name} is not owed anything in yuan on ${input.date}${advanceLines.length ? " once their advance is counted" : ""}${start ? ` (their yuan debt starts on ${start})` : ""}`,
        `${party.name} n'a rien à recevoir en yuans au ${frDate(input.date)}${advanceLines.length ? " une fois son avance déduite" : ""}${start ? ` (sa dette en yuans commence le ${frDate(start)})` : ""}`,
      );
    }
    if (settle.gt(owed)) throw badRequest(`${party.name} is owed only ${owed.toFixed(2)} CNY`, `${party.name} n'attend que ${frMoney(owed, "CNY")}`);
    if (leg.currency !== "USD") throw badRequest("Pay a yuan invoice from a dollar account", "Payez une facture en yuans depuis un compte en dollars");
    // The yuan settled must be worth roughly what the dollars paid: compare with the yuan rate of the
    // day when one is on file, else with what those yuan cost.
    const day = await cnyRateFor(tx, input.date);
    const reference = day ? day : cny.usd.isZero() ? null : cny.native.abs().dividedBy(cny.usd.abs());
    if (reference && owed.dividedBy(reference).lt("0.005")) {
      // Left by an older posting: worth nothing to pay, they are cleared by the next entry on this contact.
      throw badRequest(
        `The ${owed.toFixed(2)} CNY left are worth under half a cent: there is nothing to pay. Pay in dollars without yuan to settle, and they are cleared.`,
        `Les ${frMoney(owed, "CNY")} restants valent moins d'un demi-centime : il n'y a rien à payer. Payez en dollars sans yuans à solder, et ils seront soldés.`,
      );
    }
    // The dollars shown for the yuan settled always pass: on a few yuan, a cent's rounding is far more than
    // 5 % (0,04 ¥ shown as 0,01 $), while a typo in either amount changes the dollars shown.
    if (reference && !cents(settle.dividedBy(reference)).equals(cents(leg.usd))) {
      const tolerance = Decimal.max(await rateTolerancePct(tx), 5);
      await assertImpliedRate(tx, input.date, settle.dividedBy(leg.usd), reference, "CNY", tolerance);
    }
    partyLines = [...advanceLines, { accountId: payables, partyId: party.id, debit: leg.usd, currency: "CNY", nativeAmount: settle, rate: settle.dividedBy(leg.usd).toFixed(4) }];
  } else {
    partyLines = await payablesLines(tx, { payables, partyId: party.id, usd: leg.usd, money: leg, date: input.date });
  }
  const journalId = await postJournal(tx, {
    date: input.date,
    type: "supplier_payment",
    memo: input.memo ?? `Paiement à ${party.name}`,
    userId,
    lines: [...partyLines, { accountId: leg.accountId, credit: leg.usd, nativeAmount: leg.nativeAmount, rate: leg.rate }],
  });
  // Francs paid dated before a franc bill already booked (see francsMetAfter).
  await francsMetAfter(tx, journalId, input.date, userId);
  return journalId;
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
    memo: input.memo ?? `Apport en capital ${de(partner.name)}`,
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
    memo: input.memo ?? `Retrait ${de(partner.name)}`,
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
    throw badRequest(`Debits (${debit.toFixed(2)}) and credits (${credit.toFixed(2)}) must be equal`, `Les débits (${frMoney(debit)}) et les crédits (${frMoney(credit)}) doivent être égaux`);
  }
  if (debit.isZero()) throw badRequest("Enter some amounts", "Saisissez des montants");
  input.lines.forEach((l, i) => assertMemoNotReserved(l.memo, i + 1));
  const ids = input.lines.map((l) => l.accountId);
  const rows = await tx.select().from(accounts).where(inArray(accounts.id, ids));
  const inventoryId = await systemAccountId(tx, SYSTEM_ACCOUNTS.inventory);
  const transitId = await systemAccountId(tx, SYSTEM_ACCOUNTS.goodsInTransit);
  for (const r of rows) {
    if (r.id === inventoryId || r.id === transitId) {
      throw badRequest(`${r.name} is kept by stock and containers. Use a stock adjustment or the container screen.`, `${r.name} est tenu par le stock et les conteneurs. Utilisez un ajustement de stock ou l'écran des conteneurs.`);
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

/**
 * Stock found or counted in is a gain shared by the partners at its cost, so staff do not choose
 * it: an item with at least one unit in stock comes back at its average cost (so taking stock out
 * and counting it back in never changes its value), and otherwise at what it cost when bought,
 * net of reversed containers and weighted by quantity, within 10%. Staff never value a gain above
 * the item's selling price: a cost pinned on one unit, or a typo reversed later, would otherwise
 * become profit. Anything else is for the owner.
 */
async function staffGainCost(tx: Tx, variant: typeof variants.$inferSelect, name: string, typed: Decimal | null): Promise<Decimal> {
  const q = dec(variant.stockQty);
  let cost: Decimal;
  if (q.gte(1)) {
    const avg = dec(variant.stockValue).dividedBy(q);
    if (typed && typed.minus(avg).abs().gt(Decimal.max(avg.times("0.01"), "0.01"))) {
      throw forbidden(
        `${name}: stock found goes in at its average cost (${avg.toFixed(2)}). Leave the cost empty, or ask the owner.`,
        `${name} : le stock retrouvé entre à son coût moyen (${frMoney(avg)}). Laissez le coût vide, ou demandez au propriétaire.`,
      );
    }
    cost = avg;
  } else {
    const [bought] = await tx
      .select({ qty: sql<string>`coalesce(sum(${stockMovements.qty}), 0)`, value: sql<string>`coalesce(sum(${stockMovements.value}), 0)` })
      .from(stockMovements)
      .where(and(eq(stockMovements.variantId, variant.id), inArray(stockMovements.type, ["container_in", "container_reversal", "opening"])));
    const boughtQty = dec(bought?.qty ?? 0);
    const reference = boughtQty.gte(1) && dec(bought.value).gt(0) ? dec(bought.value).dividedBy(boughtQty) : null;
    if (!reference) throw forbidden(`${name} has no cost yet. Ask the owner to enter it.`, `${name} n'a pas encore de coût. Demandez au propriétaire de le saisir.`);
    if (typed && typed.minus(reference).abs().gt(reference.times("0.10").plus("0.01"))) {
      throw forbidden(
        `${name}: ${typed.toFixed(2)} is far from its cost (${reference.toFixed(2)}). Leave the cost empty to use it, or ask the owner.`,
        `${name} : ${frMoney(typed)} s'écarte de son coût (${frMoney(reference)}). Laissez le coût vide pour l'utiliser, ou demandez au propriétaire.`,
      );
    }
    cost = typed ?? reference;
  }
  const sell = dec(variant.sellPrice);
  if (!sell.gt(0) || cost.gt(sell)) {
    throw forbidden(
      `${name}: a cost of ${cost.toFixed(2)} is above its selling price (${sell.toFixed(2)}). Ask the owner to enter this stock.`,
      `${name} : un coût de ${frMoney(cost)} dépasse son prix de vente (${frMoney(sell)}). Demandez au propriétaire de saisir ce stock.`,
    );
  }
  return cost;
}

export async function adjustStock(tx: Tx, input: AdjustmentInput, userId: number, opts: { owner: boolean } = { owner: true }) {
  if (input.lines.length === 0) throw badRequest("Add at least one item", "Ajoutez au moins un article");
  // A count where everything matched is still worth recording; other adjustments must change something.
  if (input.kind !== "count" && input.lines.every((l) => dec(l.qtyChange, "quantity").isZero())) {
    throw badRequest("Nothing to adjust: every quantity change is zero", "Rien à ajuster : toutes les variations de quantité sont à zéro");
  }
  // One line per item: removing and adding the same item in one adjustment would revalue it.
  const seenVariants = new Set<number>();
  for (const l of input.lines) {
    if (seenVariants.has(l.variantId)) throw badRequest("The same item is on the adjustment twice: enter one net change", "Le même article figure deux fois : saisissez une seule variation nette");
    seenVariants.add(l.variantId);
  }
  const [location] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, input.locationId));
  if (!location) throw badRequest("That location does not exist", "Cet emplacement n'existe pas");
  // All the items at once, in id order (see lockVariants).
  await lockVariants(tx, input.lines.map((l) => l.variantId));
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
      .select({ variant: variants, tracksSerials: products.tracksSerials, name: products.name, unit: products.unit })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(variants.id, line.variantId));
    if (!v) throw badRequest("One of the items does not exist", "Un des articles n'existe pas");
    if (v.tracksSerials && !change.isInteger()) throw badRequest("Motorcycles must be whole units", "Les motos se comptent en unités entières");
    if (!change.isInteger() && wholeUnit(v.unit)) throw wholeUnitError(`${v.name} (${v.variant.sku})`);

    if (change.isPositive()) {
      if (input.kind !== "opening" && input.kind !== "found" && input.kind !== "count" && input.kind !== "other") {
        throw badRequest("Damage and loss can only remove stock", "Les dégâts et pertes ne peuvent que retirer du stock");
      }
      let unit = line.unitCost != null && line.unitCost !== "" ? dec(line.unitCost, "unit cost") : null;
      if (unit?.isNegative()) throw badRequest("Cost cannot be negative", "Le coût ne peut pas être négatif");
      // A cost typed above zero must book something: below a millionth, or on a line worth under half a
      // cent ("0.333 m at 0.01"), it would go into stock at 0.00 $.
      if (unit?.gt(0) && (unit.toDecimalPlaces(6).isZero() || cents(unit.times(change)).isZero())) {
        throw new MoneyError(
          `${v.name} (${v.variant.sku}): ${change.toFixed()} at ${unit.toFixed()} $ is worth less than one cent. Enter the cost of a larger quantity, or 0.`,
          `${v.name} (${v.variant.sku}) : ${frNumber(change.toFixed())} à ${frNumber(unit.toFixed())} $ vaut moins d'un centime. Saisissez le coût d'une plus grande quantité, ou 0.`,
        );
      }
      // The cost typed, kept on the movement for the cost shown (see receiveStock); never one the books chose.
      const typed = unit;
      if (!opts.owner && input.kind !== "opening") unit = await staffGainCost(tx, v.variant, v.name, unit);
      if (!unit) {
        const q = dec(v.variant.stockQty);
        if (q.isZero()) throw badRequest(`Give a cost per unit for ${v.name} (${v.variant.sku}); it has no stock to take an average from`, `Indiquez un coût unitaire pour ${v.name} (${v.variant.sku}) : il n'a pas de stock pour calculer une moyenne`);
        unit = dec(v.variant.stockValue).dividedBy(q);
      }
      if (unit.isNegative()) throw badRequest("Cost cannot be negative", "Le coût ne peut pas être négatif");
      const value = cents(unit.times(change));
      await receiveStock(tx, {
        date: input.date,
        type: input.kind === "opening" ? "opening" : "adjustment",
        variantId: v.variant.id,
        locationId: input.locationId,
        qty: change,
        value,
        // Only the cost typed: the running average (or the cost a manager's line was held to) is value ÷ qty to
        // six decimals, which would show 0,124444 $ where the cost typed before still gives the value.
        unitCost: typed && unit.equals(typed) ? unit : null,
        sourceType: "adjustment",
        sourceId: adj.id,
        note: input.reason,
        userId,
      });
      gains = gains.plus(value);
      if (v.tracksSerials) {
        const serials = line.serials ?? [];
        if (serials.length > change.toNumber()) throw badRequest("More chassis numbers than motorcycles added", "Plus de numéros de châssis que de motos ajoutées");
        const chassis = serials.map((s) => s.chassisNo?.trim().toUpperCase()).filter((c): c is string => !!c);
        if (new Set(chassis).size !== chassis.length) throw badRequest("The same chassis number is entered twice", "Le même numéro de châssis est saisi deux fois");
        // A motorcycle removed earlier and now found again gets its old record back, history included.
        const back = new Map<string, number>();
        if (chassis.length) {
          const taken = await tx.select().from(motorcycleUnits).where(inArray(motorcycleUnits.chassisNo, chassis)).for("update");
          for (const u of taken) {
            if (u.status === "removed" && u.variantId === v.variant.id) back.set(u.chassisNo!, u.id);
            else throw conflict(`Chassis number ${u.chassisNo} is already registered`, `Le numéro de châssis ${u.chassisNo} est déjà enregistré`);
          }
        }
        const rows = Array.from({ length: change.toNumber() }, (_, i) => ({
          variantId: v.variant.id,
          locationId: input.locationId,
          chassisNo: serials[i]?.chassisNo?.trim().toUpperCase() || null,
          engineNo: serials[i]?.engineNo?.trim().toUpperCase() || null,
          color: serials[i]?.color || variantColour(v.variant.attributes),
          status: "in_stock",
        }));
        const fresh = [];
        for (const r of rows) {
          const old = r.chassisNo ? back.get(r.chassisNo) : undefined;
          if (old) {
            await tx
              .update(motorcycleUnits)
              .set({ status: "in_stock", locationId: r.locationId, saleId: null, ...(r.engineNo ? { engineNo: r.engineNo } : {}) })
              .where(eq(motorcycleUnits.id, old));
          } else fresh.push(r);
        }
        if (fresh.length) await tx.insert(motorcycleUnits).values(fresh);
      }
    } else {
      if (input.kind === "opening") throw badRequest("Opening stock can only add stock", "Le stock d'ouverture ne peut qu'ajouter du stock");
      const q = change.abs();
      if (v.tracksSerials) {
        const ids = line.unitIds ?? [];
        if (ids.length !== q.toNumber()) throw badRequest(`Pick which ${q.toString()} motorcycle(s) of ${v.name} are removed`, `Choisissez quelle(s) ${q.toString()} moto(s) ${de(v.name)} sont retirées`);
        const units = await tx.select().from(motorcycleUnits).where(inArray(motorcycleUnits.id, ids)).for("update");
        if (units.length !== ids.length || units.some((u) => u.variantId !== v.variant.id || u.status !== "in_stock" || u.locationId !== input.locationId)) {
          throw badRequest("One of the motorcycles picked is not in stock here", "Une des motos choisies n'est pas en stock ici");
        }
        // The record and its chassis number are kept, marked removed.
        await tx.update(motorcycleUnits).set({ status: "removed" }).where(inArray(motorcycleUnits.id, ids));
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
    memo: `${number}\u00a0: ${input.reason}`,
    sourceType: "adjustment",
    sourceId: adj.id,
    userId,
    lines: [
      { accountId: inventory, debit: gains, memo: "Stock ajouté" },
      { accountId: offset, credit: gains },
      { accountId: offset, debit: losses },
      { accountId: inventory, credit: losses, memo: "Stock retiré" },
    ],
  });
  await linkMovementsToJournal(tx, "adjustment", adj.id, journalId);
  await tx.update(stockAdjustments).set({ journalId }).where(eq(stockAdjustments.id, adj.id));
  return { ...adj, journalId, gains: gains.toFixed(2), losses: losses.toFixed(2) };
}

export async function ensureAccountsExist(tx: Tx, ids: number[]) {
  const rows = await tx.select({ id: accounts.id }).from(accounts).where(and(inArray(accounts.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("One of the accounts does not exist", "Un des comptes n'existe pas");
}
