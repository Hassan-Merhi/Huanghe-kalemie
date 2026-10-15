import { and, asc, eq } from "drizzle-orm";
import { accounts, journals, parties, payrollRuns, type PayrollLine } from "@shared/schema";
import { cents, dec, sum, Decimal } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, francDecimalsError, notFound } from "../errors";
import { deMonth, monthText } from "@shared/french";
import { postJournal, resolveRate, reverseJournal, shopToday, SYSTEM_ACCOUNTS, systemAccountId, type PostLine } from "./ledger";
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
  return rows.map((p) => {
    const b = balances.find((x) => x.id === p.id);
    // Party balance is positive when they owe us (an advance not yet earned).
    const balance = b?.balance ?? "0.00";
    return { ...p, balance, foreign: b?.foreign ?? [] };
  });
}

export async function salaryAccountId(tx: Tx) {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.code, "6010"), eq(accounts.type, "expense")));
  return row?.id ?? null;
}

export async function listRuns(tx: Tx) {
  return tx.select().from(payrollRuns).orderBy(asc(payrollRuns.month), asc(payrollRuns.id));
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
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const native = (amount: string) => (rate ? { currency: "CDF" as const, nativeAmount: amount, rate } : {});
  const owed: PostLine[] = lines
    .filter((l) => !dec(l.net).isZero())
    .map((l) => ({ accountId: payables, credit: l.netUsd!, partyId: l.partyId, memo: `Salaire ${monthText(input.month)}`, ...native(l.net) }));
  const withheldNative = sum(lines.map((l) => l.withheld ?? 0));
  if (!withheldNative.isZero()) {
    owed.push({
      accountId: await systemAccountId(tx, SYSTEM_ACCOUNTS.payrollWithheld),
      credit: usdOf(withheldNative),
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
  const cancelJournalId = run.journalId
    ? await reverseJournal(tx, run.journalId, { date: date || run.date, userId, memo: `Annulation des salaires ${monthText(month)}` })
    : null;
  await reverseAdvances(tx, { type: "payroll", id: run.id }, date || run.date, userId);
  await tx.update(payrollRuns).set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: userId, cancelJournalId }).where(eq(payrollRuns.id, run.id));
}
