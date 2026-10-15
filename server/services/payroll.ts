import { and, asc, eq } from "drizzle-orm";
import { accounts, parties, payrollRuns, type PayrollLine } from "@shared/schema";
import { cents, sum } from "@shared/money";
import type { Tx } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { postJournal, reverseJournal, SYSTEM_ACCOUNTS, systemAccountId } from "./ledger";
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
    return { ...p, balance };
  });
}

export async function salaryAccountId(tx: Tx) {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.code, "6010"), eq(accounts.type, "expense")));
  return row?.id ?? null;
}

export async function listRuns(tx: Tx) {
  return tx.select().from(payrollRuns).orderBy(asc(payrollRuns.month));
}

export interface PayrollRunInput {
  month: string;
  date?: string | null;
  accountId: number;
  lines: { partyId: number; salary: string; bonus?: string | null; deduction?: string | null }[];
}

export async function runPayroll(tx: Tx, input: PayrollRunInput, userId: number) {
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw badRequest("Pick a month", "Choisissez un mois");
  const [existing] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.month, input.month));
  if (existing) throw conflict(`Salaries for ${input.month} are already booked. Cancel that run first to redo it.`, `Les salaires de ${input.month} sont déjà comptabilisés. Annulez d'abord ce passage pour le refaire.`);
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!account || account.type !== "expense") throw badRequest("Pick an expense account for salaries", "Choisissez un compte de charges pour les salaires");
  const { from, to } = monthRange(input.month);
  const date = input.date ?? to;
  if (date < from || date > to) throw badRequest(`The date must be in ${input.month}`, `La date doit être dans ${input.month}`);

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
    const deduction = cents(l.deduction || 0);
    if (salary.isNegative() || bonus.isNegative() || deduction.isNegative()) throw badRequest("Amounts cannot be negative", "Les montants ne peuvent pas être négatifs");
    const net = salary.plus(bonus).minus(deduction);
    if (net.isNegative()) throw badRequest(`${p.name}: deductions are more than the salary`, `${p.name} : les retenues dépassent le salaire`);
    if (net.isZero()) continue;
    lines.push({ partyId: p.id, name: p.name, salary: salary.toFixed(2), bonus: bonus.toFixed(2), deduction: deduction.toFixed(2), net: net.toFixed(2) });
  }
  if (!lines.length) throw badRequest("Nothing to book: enter at least one salary", "Rien à comptabiliser : saisissez au moins un salaire");
  const total = sum(lines.map((l) => l.net));
  const payables = await systemAccountId(tx, SYSTEM_ACCOUNTS.payables);
  const journalId = await postJournal(tx, {
    date,
    type: "payroll",
    memo: `Salaires ${input.month}`,
    sourceType: "payroll",
    userId,
    lines: [
      { accountId: account.id, debit: total, memo: `Salaires ${input.month}` },
      ...lines.map((l) => ({ accountId: payables, credit: l.net, partyId: l.partyId, memo: `Salaire ${input.month}` })),
    ],
  });
  const [run] = await tx
    .insert(payrollRuns)
    .values({ month: input.month, date, accountId: account.id, totalUsd: total.toFixed(2), lines, journalId, createdBy: userId })
    .returning();
  return run;
}

/** Undo a month's salaries. Without a date the reversal is dated like the run, so that month's profit loses them, not today's. */
export async function cancelRun(tx: Tx, month: string, date: string | null | undefined, userId: number) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.month, month)).for("update");
  if (!run) throw notFound("Payroll run", "Passage de paie introuvable");
  if (run.journalId) await reverseJournal(tx, run.journalId, { date: date || run.date, userId, memo: `Annulation des salaires ${month}` });
  await tx.delete(payrollRuns).where(eq(payrollRuns.id, run.id));
}
