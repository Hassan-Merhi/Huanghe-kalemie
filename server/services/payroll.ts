import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { accounts, journalLines, journals, parties, payrollRuns, type PayrollLine } from "@shared/schema";
import { allocateCents, cents, dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, francDecimalsError, notFound } from "../errors";
import { deMonth, monthText } from "@shared/french";
import { lockBalances, postJournal, resolveRate, reverseJournal, revaluedDollarLines, shopToday, SYSTEM_ACCOUNTS, systemAccountId, type PostLine } from "./ledger";
import { applyAdvances, reverseAdvances } from "./operations";
import { monthRange } from "./periods";
import { partyBalances } from "./reports";

/*
 * Payroll
 * - Each employee is a contact of type "employee" with a monthly salary.
 * - Running a month books Dr salaries (an expense, so the 75% partner carries it) and
 *   Cr payables for each employee: what the shop owes them.
 * - Advances are payments to the employee before payday. They sit as a debit on the same
 *   contact, so the amount left to pay after the run is the salary minus the advances.
 * - Paying salaries is a payment voucher with one line per employee.
 */

export async function employees(tx: Tx) {
  const rows = await tx.select().from(parties).where(eq(parties.type, "employee")).orderBy(asc(parties.name));
  const balances = await partyBalances(tx, "employee");
  const deducted = await advancesAfterRun(tx);
  return rows.map((p) => {
    const b = balances.find((x) => x.id === p.id);
    // Party balance is positive when they owe us (an advance not yet earned).
    const balance = b?.balance ?? "0.00";
    // What is still to repay is not deducted (an advance given once the salary was paid stays an advance).
    const after = deducted.get(p.id);
    const off = after ? Decimal.min(dec(after.usd), dec(after.usd).minus(Decimal.max(dec(balance), 0))) : null;
    return { ...p, balance, foreign: b?.foreign ?? [], advanceDeducted: after && off!.gt(0) ? { month: after.month, usd: off!.toFixed(2) } : null };
  });
}

/**
 * Advances given after the latest month's payroll was saved: they already came off the salary it owes
 * ("50,00 $ d'avance déjà déduits du salaire d'octobre"), so the Advances tab can say so instead of
 * "Aucune avance en cours". Payments to the employee posted after the run's journal, other than salary
 * payments ("Salaire …") and the franc/yuan advance matching, at most what the run owes them; the
 * caller keeps out what is still to repay. Read only.
 */
async function advancesAfterRun(tx: Tx): Promise<Map<number, { month: string; usd: string }>> {
  const out = new Map<number, { month: string; usd: string }>();
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "posted"))
    .orderBy(sql`${payrollRuns.month} desc`, sql`${payrollRuns.id} desc`)
    .limit(1);
  if (!run?.journalId) return out;
  const lines = run.lines as PayrollLine[];
  const ids = lines.map((l) => l.partyId);
  if (!ids.length) return out;
  const rows = await tx
    .select({ partyId: journalLines.partyId, usd: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})::text` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(
      and(
        inArray(journalLines.partyId, ids),
        sql`${journals.id} > ${run.journalId}`,
        sql`coalesce(${journalLines.memo}, '') not like 'Salaire %'`,
        sql`coalesce(${journals.sourceType}, '') not like 'advance_%'`,
      ),
    )
    .groupBy(journalLines.partyId);
  for (const r of rows) {
    const line = lines.find((l) => l.partyId === r.partyId);
    const owed = dec(line?.netUsd ?? (run.currency === "USD" ? line?.net ?? 0 : 0));
    const given = Decimal.min(dec(r.usd), owed);
    if (r.partyId && given.gt(0)) out.set(r.partyId, { month: run.month, usd: given.toFixed(2) });
  }
  return out;
}

export async function salaryAccountId(tx: Tx) {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.code, "6010"), eq(accounts.type, "expense")));
  return row?.id ?? null;
}

export async function listRuns(tx: Tx) {
  const runs = await tx.select().from(payrollRuns).orderBy(asc(payrollRuns.month), asc(payrollRuns.id));
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  // Read only: each posted run's lines with `advanceUsd` (see advancesBeforeRun), so cancelling it can say
  // which part of a salary went back onto an advance and which part was paid in cash.
  return Promise.all(runs.map(async (r) => (r.status === "posted" && r.journalId ? { ...r, lines: await advancesBeforeRun(tx, payables, r) } : r)));
}

/**
 * What each employee had as an advance just before the run was posted, at most the run's net: that part of
 * the salary was deducted from the advance (Jean's 421 200 FC from his 150,00 $), not paid out, and on a
 * cancel it goes back onto the advance. The rest of what is no longer owed was paid in cash. Read only.
 */
async function advancesBeforeRun(tx: Tx, payables: number, run: typeof payrollRuns.$inferSelect): Promise<(PayrollLine & { advanceUsd: string })[]> {
  const lines = run.lines as PayrollLine[];
  const ids = lines.map((l) => l.partyId);
  const rows = ids.length
    ? await tx
        .select({ partyId: journalLines.partyId, usd: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})::text` })
        .from(journalLines)
        .where(and(eq(journalLines.accountId, payables), inArray(journalLines.partyId, ids), sql`${journalLines.journalId} < ${run.journalId}`))
        .groupBy(journalLines.partyId)
    : [];
  return lines.map((l) => {
    const before = Decimal.max(dec(rows.find((r) => r.partyId === l.partyId)?.usd ?? 0), 0);
    const owed = Decimal.max(dec(l.netUsd ?? (run.currency === "USD" ? l.net : 0)), 0);
    return { ...l, advanceUsd: Decimal.min(before, owed).toFixed(2) };
  });
}

export interface PayrollRunInput {
  month: string;
  date?: string | null;
  accountId: number;
  /** Currency the salaries are owed in. Defaults to USD. */
  currency?: "USD" | "CDF" | null;
  /** Francs per dollar for a CDF run; the day's rate when left out. */
  rate?: string | null;
  lines: { partyId: number; salary: string; bonus?: string | null; withheld?: string | null; penalty?: string | null; deduction?: string | null }[];
}

/**
 * Book a month's salaries.
 * - Salary cost (Dr expense) = salary + bonus − penalty. A penalty is a fine, so the shop spends less.
 * - Withheld amounts stay a salary cost: they are owed to someone else (tax, social security), so
 *   they go to "Retenues sur salaires à reverser" until paid with a payment voucher.
 * - Each employee is owed net = salary + bonus − withheld − penalty, in the run's currency.
 */
export async function runPayroll(tx: Tx, input: PayrollRunInput, userId: number) {
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw badRequest("Pick a month", "Choisissez un mois");
  const [existing] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.month, input.month), eq(payrollRuns.status, "posted")));
  if (existing) throw conflict(`Salaries for ${input.month} are already booked. Cancel that run first to redo it.`, `Les salaires ${deMonth(input.month)} sont déjà comptabilisés. Annulez d'abord ce passage pour le refaire.`);
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!account || account.type !== "expense") throw badRequest("Pick an expense account for salaries", "Choisissez un compte de charges pour les salaires");
  const { from, to } = monthRange(input.month);
  // Without a date, the month's last day, or today while the month is still running.
  const date = input.date ?? (to > shopToday() ? shopToday() : to);
  if (date < from || date > to) throw badRequest(`The date must be in ${input.month}`, `La date doit être en ${monthText(input.month)}`);
  const currency = input.currency ?? "USD";
  const rate = currency === "CDF" ? await resolveRate(tx, date, input.rate) : null;
  const usdOf = (native: Decimal) => (rate ? cents(native.dividedBy(rate)) : native);

  const staff = await tx.select().from(parties).where(eq(parties.type, "employee"));
  const lines: PayrollLine[] = [];
  const seen = new Set<number>();
  for (const l of input.lines) {
    const p = staff.find((s) => s.id === l.partyId);
    if (!p) throw badRequest("One of the employees does not exist", "Un des employés n'existe pas");
    if (seen.has(p.id)) throw badRequest(`${p.name} is listed twice`, `${p.name} figure deux fois`);
    seen.add(p.id);
    const salary = cents(l.salary || 0);
    const bonus = cents(l.bonus || 0);
    const withheld = cents(l.withheld || 0);
    // Older screens send one "deduction": it always lowered the cost, so it is a penalty.
    const penalty = cents(l.penalty || (l.withheld == null ? l.deduction : null) || 0);
    if ([salary, bonus, withheld, penalty].some((x) => x.isNegative())) throw badRequest("Amounts cannot be negative", "Les montants ne peuvent pas être négatifs");
    const fractional = rate ? [salary, bonus, withheld, penalty].find((x) => !x.isInteger()) : undefined;
    if (fractional) throw francDecimalsError(fractional);
    const net = salary.plus(bonus).minus(withheld).minus(penalty);
    if (net.isNegative()) throw badRequest(`${p.name}: deductions are more than the salary`, `${p.name} : les retenues dépassent le salaire`);
    if (net.isZero() && withheld.isZero()) continue;
    lines.push({
      partyId: p.id,
      name: p.name,
      salary: salary.toFixed(2),
      bonus: bonus.toFixed(2),
      withheld: withheld.toFixed(2),
      penalty: penalty.toFixed(2),
      deduction: withheld.plus(penalty).toFixed(2),
      net: net.toFixed(2),
      netUsd: usdOf(net).toFixed(2),
    });
  }
  if (!lines.length) throw badRequest("Nothing to book: enter at least one salary", "Rien à comptabiliser : saisissez au moins un salaire");
  // Francs owed are valued once for the whole run and shared by amount, so the cost is what all those
  // francs are worth, not the sum of each line rounded to the cent.
  const withheldNative = sum(lines.map((l) => l.withheld ?? 0));
  let withheldUsd = usdOf(withheldNative);
  if (rate) {
    const natives = [...lines.map((l) => dec(l.net)), withheldNative];
    const shares = allocateCents(usdOf(sum(natives)), natives);
    lines.forEach((l, i) => (l.netUsd = shares[i].toFixed(2)));
    withheldUsd = shares[lines.length];
  }
  // Each employee's advance is taken below: all of them first, in id order (see lockBalances).
  await lockBalances(tx, { parties: lines.map((l) => l.partyId) });
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const native = (amount: string) => (rate ? { currency: "CDF" as const, nativeAmount: amount, rate } : {});
  const owed: PostLine[] = lines
    .filter((l) => !dec(l.net).isZero())
    .map((l) => ({ accountId: payables, credit: l.netUsd!, partyId: l.partyId, memo: `Salaire ${monthText(input.month)}`, ...native(l.net) }));
  if (!withheldNative.isZero()) {
    owed.push({
      accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payrollWithheld),
      credit: withheldUsd,
      memo: `Retenues sur salaires ${monthText(input.month)}`,
      ...native(withheldNative.toFixed(2)),
    });
  }
  // The cost is the sum of what is owed, so the journal balances to the cent in either currency.
  const total = sum(owed.map((l) => l.credit ?? 0));
  const journalId = await postJournal(tx, {
    date,
    type: "payroll",
    memo: `Salaires ${monthText(input.month)}`,
    sourceType: "payroll",
    userId,
    lines: [{ accountId: account.id, debit: total, memo: `Salaires ${monthText(input.month)}` }, ...owed],
  });
  const [run] = await tx
    .insert(payrollRuns)
    .values({ month: input.month, date, accountId: account.id, currency, rate, totalUsd: total.toFixed(2), lines, journalId, createdBy: userId })
    .returning();
  if (journalId) await tx.update(journals).set({ sourceId: run.id }).where(eq(journals.id, journalId));
  // Salary advances paid in dollars come off salaries owed in francs.
  if (currency === "CDF") {
    for (const l of lines) await applyAdvances(tx, l.partyId, date, `Avance déduite du salaire ${monthText(input.month)}`, userId, { type: "payroll", id: run.id }, "CDF");
  }
  return run;
}

/**
 * Undo a month's salaries. Without a date the reversal is dated like the run, so that month's profit
 * loses them, not today's. The run is kept, marked cancelled, so the history shows what happened.
 */
export async function cancelRun(tx: Tx, month: string, date: string | null | undefined, userId: number) {
  const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.month, month), eq(payrollRuns.status, "posted"))).for("update");
  if (!run) throw notFound("Payroll run", "Passage de paie introuvable");
  if (run.journalId) {
    // Withholdings already paid over would leave 2100 owed back by whoever received them. The same lock
    // as a payment of 2100, so a cancel and that payment cannot both pass. Each currency is compared in
    // itself (francs in francs), so a month-end revaluation of the francs doesn't count as a payment.
    const withheldId = await systemAccountId(tx, SYSTEM_ACCOUNTS.payrollWithheld);
    // The employees' balances first, then this account's (see lockBalances): the cancel gives their
    // advances back and clears what is left of their francs.
    await lockBalances(tx, { parties: (run.lines as PayrollLine[]).map((l) => l.partyId), accounts: [withheldId] });
    const owedOn = async (currency: "USD" | "CDF", journalId?: number) => {
      const [r] = await tx
        .select({
          usd: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)`,
          native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`,
        })
        .from(journalLines)
        .where(and(eq(journalLines.accountId, withheldId), eq(journalLines.currency, currency), journalId ? eq(journalLines.journalId, journalId) : sql`true`));
      return currency === "CDF" ? dec(r?.native ?? 0).negated() : dec(r?.usd ?? 0);
    };
    for (const currency of ["USD", "CDF"] as const) {
      const withheld = await owedOn(currency, run.journalId);
      if (withheld.gt(0) && (await owedOn(currency)).minus(withheld).lt(currency === "CDF" ? -0.5 : -0.005)) {
        throw conflict(
          "This run's withholdings were already paid over. Cancel that payment first.",
          "Les retenues de ce passage de paie ont déjà été versées. Annulez d'abord ce versement.",
        );
      }
    }
  }
  const cancelJournalId = run.journalId
    ? await reverseJournal(tx, run.journalId, { date: date || run.date, userId, memo: `Annulation des salaires ${monthText(month)}` })
    : null;
  await reverseAdvances(tx, { type: "payroll", id: run.id }, date || run.date, userId, `Avance rendue\u00a0: la paie ${deMonth(month)} est annulée`);
  if (run.journalId) await clearFrancResidue(tx, run.journalId, date || run.date, userId);
  await tx.update(payrollRuns).set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: userId, cancelJournalId }).where(eq(payrollRuns.id, run.id));
}

/**
 * A cancel reverses the run at its own rate. When a month-end revaluation restated those francs in
 * between (or the rate moved since the advances), an account or employee can be left with no francs but a few cents of dollars; they are
 * moved to the exchange account, as the next revaluation would have done (see revaluedDollarLines).
 * The reversal itself clears the balances it empties; this is for those the advances given back empty.
 */
async function clearFrancResidue(tx: Tx, journalId: number, date: string, userId: number) {
  const touched = await tx
    .selectDistinct({ accountId: journalLines.accountId, partyId: journalLines.partyId })
    .from(journalLines)
    .where(and(eq(journalLines.journalId, journalId), eq(journalLines.currency, "CDF")));
  const lines = await revaluedDollarLines(tx, touched.map((t) => ({ ...t, currency: "CDF" as const })), date);
  if (!lines.length) return;
  await postJournal(tx, {
    date,
    type: "payroll",
    memo: "Écart de change à l'annulation des salaires",
    sourceType: "payroll_fx",
    userId,
    lines: lines.map((l): PostLine => ({ ...l, currency: l.currency === "USD" ? null : l.currency })),
  });
}
