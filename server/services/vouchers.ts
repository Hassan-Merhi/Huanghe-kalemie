import { and, desc, eq, inArray } from "drizzle-orm";
import { accounts, expenses, journals, parties, voucherDrafts, type DraftKind } from "@shared/schema";
import { cents, dec, sum } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { contactLines, moneyLeg, postJournal, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId, toUsd, type PostLine } from "./ledger";
import * as ops from "./operations";

/*
 * Payment and receipt vouchers: one cash box, bank or mobile money account on one side and
 * any number of lines on the other, posted as a single journal.
 * - A line is either a contact (customer, supplier, agent, employee) or a ledger account.
 * - Contact lines go to receivables (customers) or payables (everyone else) with the contact.
 * - Expense lines also appear in Expenses, so the expense list and the P&L stay the same.
 * - Amounts are in the money account's currency; CDF lines are valued at the voucher's rate.
 */

export interface VoucherLineInput {
  partyId?: number | null;
  accountId?: number | null;
  amount: string;
  memo?: string | null;
}

export interface VoucherInput {
  date: string;
  /** The cash box, bank or mobile money account money leaves (payment) or enters (receipt). */
  accountId: number;
  rate?: string | null;
  memo?: string | null;
  lines: VoucherLineInput[];
}

/** Accounts a voucher line cannot hit directly: money moves use transfers, stock and contacts have their own screens. */
const BLOCKED_KEYS: string[] = [
  SYSTEM_ACCOUNTS.inventory,
  SYSTEM_ACCOUNTS.goodsInTransit,
  SYSTEM_ACCOUNTS.receivables,
  SYSTEM_ACCOUNTS.payables,
  SYSTEM_ACCOUNTS.sales,
  SYSTEM_ACCOUNTS.cogs,
  SYSTEM_ACCOUNTS.stockAdjustments,
];

/** Accounts only the owner may post to: partners' money, opening balances and exchange differences. */
const OWNER_ONLY_KEYS: string[] = [SYSTEM_ACCOUNTS.openingEquity, SYSTEM_ACCOUNTS.fx];

export interface PostingRights {
  /** The owner may post to equity, opening balance and exchange accounts. */
  owner: boolean;
}

/**
 * Lines settling the same contact, or the same balance sheet account, become one: each line reads
 * the balance before the voucher, so two of them would both settle the same francs.
 */
async function mergeSettlingLines(tx: Tx, lines: VoucherLineInput[]): Promise<VoucherLineInput[]> {
  const ids = lines.map((l) => l.accountId).filter((x): x is number => !!x);
  const rows = ids.length ? await tx.select({ id: accounts.id, type: accounts.type }).from(accounts).where(inArray(accounts.id, ids)) : [];
  const settles = new Set(rows.filter((a) => a.type === "asset" || a.type === "liability").map((a) => a.id));
  const out: VoucherLineInput[] = [];
  const byKey = new Map<string, VoucherLineInput>();
  for (const [i, l] of lines.entries()) {
    if (cents(l.amount).lte(0)) throw badRequest(`Line ${i + 1}: the amount must be greater than zero`, `Ligne ${i + 1} : le montant doit être supérieur à zéro`);
    const key = l.partyId && !l.accountId ? `p${l.partyId}` : l.accountId && !l.partyId && settles.has(l.accountId) ? `a${l.accountId}` : null;
    const seen = key ? byKey.get(key) : undefined;
    if (seen) {
      seen.amount = cents(seen.amount).plus(cents(l.amount)).toFixed(2);
      if (l.memo && l.memo !== seen.memo) seen.memo = seen.memo ? `${seen.memo} ; ${l.memo}` : l.memo;
      continue;
    }
    const copy = { ...l };
    if (key) byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

async function voucherLines(tx: Tx, kind: "payment" | "receipt", input: VoucherInput, rights: PostingRights) {
  if (input.lines.length === 0) throw badRequest("Add at least one line", "Ajoutez au moins une ligne");
  input = { ...input, lines: await mergeSettlingLines(tx, input.lines) };
  const money = await moneyLeg(tx, { accountId: input.accountId, amount: sum(input.lines.map((l) => cents(l.amount))), rate: input.rate, date: input.date });
  const receivables = await systemAccountId(tx, SYSTEM_ACCOUNTS.receivables);
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);

  const partyIds = input.lines.map((l) => l.partyId).filter((x): x is number => !!x);
  const accountIds = input.lines.map((l) => l.accountId).filter((x): x is number => !!x);
  const partyRows = partyIds.length ? await tx.select().from(parties).where(inArray(parties.id, partyIds)) : [];
  const accountRows = accountIds.length ? await tx.select().from(accounts).where(inArray(accounts.id, accountIds)) : [];

  const lines: (PostLine & { usd: string; expense?: { accountId: number; name: string; native: string; description: string } })[] = [];
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    const amount = cents(l.amount);
    if (amount.lte(0)) throw badRequest(`Line ${n}: the amount must be greater than zero`, `Ligne ${n} : le montant doit être supérieur à zéro`);
    if (!!l.partyId === !!l.accountId) throw badRequest(`Line ${n}: pick a contact or an account`, `Ligne ${n} : choisissez un contact ou un compte`);
    const usd = toUsd(money.currency, amount, money.rate);
    const side = kind === "payment" ? { debit: usd } : { credit: usd };
    if (l.partyId) {
      const p = partyRows.find((x) => x.id === l.partyId);
      if (!p) throw badRequest(`Line ${n}: that contact does not exist`, `Ligne ${n} : ce contact n'existe pas`);
      const lineMoney = { currency: money.currency, nativeAmount: money.currency === "CDF" ? amount.toFixed(2) : null, rate: money.rate };
      const split =
        kind === "payment" && p.type !== "customer"
          ? // Paid like a payment to the contact: what is owed in yuan is settled too.
            await ops.payablesLines(tx, { payables, partyId: p.id, usd, money: lineMoney, date: input.date, memo: l.memo || p.name })
          : await contactLines(tx, {
              accountId: p.type === "customer" ? receivables : payables,
              partyId: p.id,
              side: kind === "payment" ? "debit" : "credit",
              usd,
              money: lineMoney,
              memo: l.memo || p.name,
              date: input.date,
            });
      split.forEach((line, k) => lines.push({ ...line, usd: k === 0 ? usd : "0" }));
    } else {
      const a = accountRows.find((x) => x.id === l.accountId);
      if (!a) throw badRequest(`Line ${n}: that account does not exist`, `Ligne ${n} : ce compte n'existe pas`);
      if (a.isMoney) throw badRequest(`Line ${n}: use a transfer to move money between ${a.name} and another money account`, `Ligne ${n} : utilisez un transfert pour déplacer de l'argent entre ${a.name} et un autre compte de trésorerie`);
      if (a.systemKey && BLOCKED_KEYS.includes(a.systemKey)) {
        throw badRequest(`Line ${n}: ${a.name} is kept by its own screen; pick a contact or another account`, `Ligne ${n} : ${a.name} est tenu par son propre écran ; choisissez un contact ou un autre compte`);
      }
      if (!rights.owner && (a.type === "equity" || a.partnerId || (a.systemKey && OWNER_ONLY_KEYS.includes(a.systemKey)))) {
        throw forbidden(`Line ${n}: only the owner can post to ${a.name}`, `Ligne ${n} : seul le propriétaire peut passer une écriture sur ${a.name}`);
      }
      // Paying out of an income or cost-of-sales account moves profit between the partners (rent
      // booked against other income lands 25% on the partner who does not bear running costs).
      if (!rights.owner && (a.type === "cost_of_sales" || (kind === "payment" && a.type === "income"))) {
        throw forbidden(
          `Line ${n}: only the owner can post a payment to ${a.name}. Pick an expense category.`,
          `Ligne ${n} : seul le propriétaire peut passer un paiement sur ${a.name}. Choisissez une catégorie de dépense.`,
        );
      }
      if (kind === "receipt" && a.type === "expense") {
        throw badRequest(`Line ${n}: an expense refund is recorded by cancelling the expense`, `Ligne ${n} : un remboursement de dépense s'enregistre en annulant la dépense`);
      }
      if (a.type === "asset" || a.type === "liability") {
        // A balance sheet account (withholdings to remit, deposits…) is settled like a contact: francs
        // clear its francs first, then its dollars, and only the rest stays in francs.
        const split = await contactLines(tx, {
          accountId: a.id,
          partyId: null,
          side: kind === "payment" ? "debit" : "credit",
          usd,
          money: { currency: money.currency, nativeAmount: money.currency === "CDF" ? amount.toFixed(2) : null, rate: money.rate },
          memo: l.memo || null,
          date: input.date,
        });
        split.forEach((line, k) => lines.push({ ...line, usd: k === 0 ? usd : "0" }));
        continue;
      }
      lines.push({
        ...side,
        usd,
        accountId: a.id,
        memo: l.memo || null,
        expense: a.type === "expense" && kind === "payment" ? { accountId: a.id, name: a.name, native: amount.toFixed(2), description: l.memo || input.memo || a.name } : undefined,
      });
    }
  }
  const total = sum(lines.map((l) => l.usd));
  const moneyLine: PostLine =
    kind === "payment"
      ? { accountId: money.accountId, credit: total, nativeAmount: money.nativeAmount, rate: money.rate }
      : { accountId: money.accountId, debit: total, nativeAmount: money.nativeAmount, rate: money.rate };
  return { money, lines, moneyLine, total };
}

export async function postVoucher(tx: Tx, kind: "payment" | "receipt", input: VoucherInput, userId: number, rights: PostingRights) {
  const { money, lines, moneyLine, total } = await voucherLines(tx, kind, input, rights);
  const [acc] = await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, money.accountId));
  const journalId = await postJournal(tx, {
    date: input.date,
    type: kind,
    memo: input.memo || (kind === "payment" ? `Paiement depuis ${acc.name}` : `Reçu dans ${acc.name}`),
    sourceType: "voucher",
    userId,
    lines: [...lines.map(({ usd: _u, expense: _e, ...l }) => l), moneyLine],
  });
  const expenseLines = lines.filter((l) => l.expense);
  if (expenseLines.length) {
    await tx.insert(expenses).values(
      expenseLines.map((l) => ({
        date: input.date,
        accountId: l.expense!.accountId,
        description: l.expense!.description,
        amountNative: l.expense!.native,
        currency: money.currency,
        rate: money.rate,
        amountUsd: l.usd,
        paidFromAccountId: money.accountId,
        journalId,
        createdBy: userId,
      })),
    );
  }
  return { id: journalId!, total: total.toFixed(2) };
}

/** Undo a payment or receipt voucher: reverse its journal and cancel the expenses it created. */
export async function reverseVoucher(tx: Tx, journalId: number, date: string, userId: number) {
  const [j] = await tx.select().from(journals).where(eq(journals.id, journalId));
  if (!j) throw notFound("Voucher", "Pièce introuvable");
  const reversalId = await reverseJournal(tx, journalId, { date, userId });
  await tx.update(expenses).set({ voidedAt: new Date(), voidJournalId: reversalId }).where(eq(expenses.journalId, journalId));
  return reversalId;
}

// ---------------------------------------------------------------- Optional vouchers (drafts)

/** Rough USD total for the list; the real value is computed when the draft is posted. */
async function draftTotal(tx: Tx, kind: DraftKind, payload: Record<string, unknown>): Promise<string | null> {
  try {
    if (kind === "payment" || kind === "receipt") {
      const p = payload as unknown as VoucherInput;
      const native = sum((p.lines ?? []).map((l) => cents(l.amount || 0)));
      const [acc] = p.accountId ? await tx.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, p.accountId)) : [];
      if (acc?.currency === "CDF") return p.rate && dec(p.rate).gt(0) ? cents(native.dividedBy(p.rate)).toFixed(2) : null;
      return native.toFixed(2);
    }
    if (kind === "journal") {
      return sum(((payload.lines as { debit?: string }[]) ?? []).map((l) => cents(l.debit || 0))).toFixed(2);
    }
    if (kind === "transfer") return payload.fromAmount ? cents(payload.fromAmount as string).toFixed(2) : null;
  } catch {
    return null;
  }
  return null;
}

export async function listDrafts(tx: Tx) {
  return tx.select().from(voucherDrafts).orderBy(desc(voucherDrafts.date), desc(voucherDrafts.id));
}

export async function saveDraft(
  tx: Tx,
  input: { id?: number | null; kind: DraftKind; date: string; memo?: string | null; payload: Record<string, unknown> },
  userId: number,
  rights: PostingRights = { owner: true },
) {
  const values = { kind: input.kind, date: input.date, memo: input.memo ?? null, payload: input.payload, totalUsd: await draftTotal(tx, input.kind, input.payload) };
  if (input.id) {
    // Someone else's pending voucher is theirs to change (the owner may change any): otherwise a
    // changed amount would be posted by whoever validates it, with their rights.
    const [current] = await tx.select({ createdBy: voucherDrafts.createdBy }).from(voucherDrafts).where(eq(voucherDrafts.id, input.id)).for("update");
    if (!current) throw notFound("Pending voucher", "Pièce en attente introuvable");
    if (!rights.owner && current.createdBy !== userId) {
      throw forbidden("Only the person who saved this pending voucher, or the owner, can change it", "Seule la personne qui a enregistré cette pièce en attente, ou le propriétaire, peut la modifier");
    }
    const [row] = await tx.update(voucherDrafts).set({ ...values, updatedAt: new Date() }).where(eq(voucherDrafts.id, input.id)).returning();
    if (!row) throw notFound("Pending voucher", "Pièce en attente introuvable");
    return row;
  }
  const [row] = await tx.insert(voucherDrafts).values({ ...values, createdBy: userId }).returning();
  return row;
}

export async function deleteDraft(tx: Tx, id: number, userId?: number, rights: PostingRights = { owner: true }) {
  if (!rights.owner) {
    const [current] = await tx.select({ createdBy: voucherDrafts.createdBy }).from(voucherDrafts).where(eq(voucherDrafts.id, id));
    if (current && current.createdBy !== userId) {
      throw forbidden("Only the person who saved this pending voucher, or the owner, can delete it", "Seule la personne qui a enregistré cette pièce en attente, ou le propriétaire, peut la supprimer");
    }
  }
  const rows = await tx.delete(voucherDrafts).where(eq(voucherDrafts.id, id)).returning({ id: voucherDrafts.id });
  if (!rows.length) throw notFound("Pending voucher", "Pièce en attente introuvable");
}

/** Post a draft through the same service a voucher saved directly would use, then remove it. */
export async function finalizeDraft(
  tx: Tx,
  id: number,
  userId: number,
  rights: PostingRights,
  /** Validates the stored payload with the same schema the direct endpoint uses. */
  parse: (kind: DraftKind, payload: Record<string, unknown>) => Record<string, unknown>,
) {
  const [draft] = await tx.select().from(voucherDrafts).where(eq(voucherDrafts.id, id)).for("update");
  if (!draft) throw notFound("Pending voucher", "Pièce en attente introuvable");
  const p = parse(draft.kind, { ...draft.payload, date: draft.date });
  let result: unknown;
  switch (draft.kind) {
    case "payment":
    case "receipt":
      result = await postVoucher(tx, draft.kind, p as unknown as VoucherInput, userId, rights);
      break;
    case "journal":
      result = { id: await ops.manualJournal(tx, p as unknown as Parameters<typeof ops.manualJournal>[1], userId) };
      break;
    case "transfer":
      result = { id: await ops.transferMoney(tx, p as unknown as ops.TransferInput, userId) };
      break;
    case "adjustment":
      if (!rights.owner && (p as { kind?: string }).kind === "opening") {
        throw forbidden("Only the owner can enter opening stock", "Seul le propriétaire peut saisir le stock d'ouverture");
      }
      result = await ops.adjustStock(tx, p as unknown as ops.AdjustmentInput, userId, rights);
      break;
    default:
      throw conflict("Unknown voucher type", "Type de pièce inconnu");
  }
  await tx.delete(voucherDrafts).where(and(eq(voucherDrafts.id, id)));
  return { kind: draft.kind, result };
}
