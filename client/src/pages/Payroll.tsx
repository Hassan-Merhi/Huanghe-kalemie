import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ChevronDown, ChevronRight, HandCoins, Pencil, Plus, Printer, Undo2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { AccountSelect, MoneyAccountSelect, MonthSelect, PartySelect, useRateField } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useI18n, useT, count } from "@/lib/i18n";
import { cdf, d, date as fmtDate, todayLocal, usd } from "@/lib/format";
import type { Account, Party } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PartyDialog } from "@/pages/Contacts";

// ---------------------------------------------------------------- Types and helpers

interface RunLine {
  partyId: number;
  name: string;
  salary: string;
  bonus: string;
  deduction: string;
  net: string;
}

interface PayrollRun {
  id: number;
  month: string;
  date: string;
  accountId: number;
  totalUsd: string;
  lines: RunLine[];
  journalId: number | null;
}

interface PayrollData {
  employees: Party[];
  runs: PayrollRun[];
  salaryAccountId: number | null;
}

function lastDayOfMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

function formatMonth(month: string, lang: "fr" | "en") {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  const s = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function useMonthLabel() {
  const { lang } = useI18n();
  return (month: string) => formatMonth(month, lang);
}

/** Employee balance in words. Debit-positive: negative = we owe them, positive = an advance they still owe. */
export function EmployeeBalance({ balance, className }: { balance: string | null | undefined; className?: string }) {
  const t = useT();
  const b = d(balance);
  if (b.isZero()) return <span className={cn("text-muted-foreground", className)}>{t("Settled", "Soldé")}</span>;
  if (b.isNegative()) {
    const x = usd(b.abs().toFixed(2));
    return <span className={cn("font-medium text-blue-700 dark:text-blue-400", className)}>{t(`We owe them ${x}`, `On lui doit ${x}`)}</span>;
  }
  const x = usd(b.toFixed(2));
  return <span className={cn("font-medium text-amber-700 dark:text-amber-400", className)}>{t(`Advance to repay ${x}`, `Avance à rembourser ${x}`)}</span>;
}

// ---------------------------------------------------------------- Page

export default function Payroll() {
  const t = useT();
  const { can } = useAuth();
  const q = useQuery<PayrollData>({ queryKey: ["/api/payroll"] });
  const [tab, setTab] = useState("employees");
  const data = q.data;
  const employees = data?.employees ?? [];
  const active = employees.filter((e) => e.active);
  const owed = employees.reduce((s, e) => (d(e.balance).isNegative() ? s.plus(d(e.balance).abs()) : s), d(0));
  const advances = employees.reduce((s, e) => (d(e.balance).gt(0) ? s.plus(e.balance) : s), d(0));
  const monthly = active.reduce((s, e) => s.plus(d(e.monthlySalary)), d(0));

  return (
    <div>
      <PageHeader
        title={t("Payroll", "Paie")}
        description={t(
          "Staff, monthly salaries, advances and payments. Salaries are booked as a running cost; payments and advances go through the employee's account.",
          "Le personnel, les salaires du mois, les avances et les paiements. Les salaires sont une charge ; paiements et avances passent par le compte de l'employé.",
        )}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("Active staff", "Employés actifs")} value={active.length} />
        <StatCard label={t("Monthly salaries", "Masse salariale / mois")} value={usd(monthly.toFixed(2))} />
        <StatCard label={t("Owed to staff", "Dû au personnel")} value={usd(owed.toFixed(2))} />
        <StatCard label={t("Advances outstanding", "Avances en cours")} value={usd(advances.toFixed(2))} />
      </div>

      <ErrorText error={q.error} />
      {q.isLoading || !data ? (
        <Loading />
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 h-auto flex-wrap">
            <TabsTrigger value="employees">{t("Employees", "Employés")}</TabsTrigger>
            <TabsTrigger value="month">{t("Monthly payroll", "Paie du mois")}</TabsTrigger>
            <TabsTrigger value="advances">{t("Advances", "Avances")}</TabsTrigger>
            <TabsTrigger value="history">{t("History", "Historique")}</TabsTrigger>
          </TabsList>
          <TabsContent value="employees">
            <EmployeesTab employees={employees} canEdit={can("manager")} />
          </TabsContent>
          <TabsContent value="month">
            <MonthTab data={data} canEdit={can("manager")} />
          </TabsContent>
          <TabsContent value="advances">
            <AdvancesTab employees={employees} canEdit={can("manager")} />
          </TabsContent>
          <TabsContent value="history">
            <HistoryTab runs={data.runs} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Employees

function EmployeesTab({ employees, canEdit }: { employees: Party[]; canEdit: boolean }) {
  const t = useT();
  const [, navigate] = useLocation();
  const [editing, setEditing] = useState<Party | "new" | null>(null);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{t("Staff", "Personnel")}</CardTitle>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-4 w-4" /> {t("New employee", "Nouvel employé")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {employees.length === 0 ? (
          <div className="p-4"><EmptyState title={t("No employees yet", "Aucun employé pour l'instant")} /></div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Name", "Nom")}</TableHead>
                  <TableHead>{t("Position", "Poste")}</TableHead>
                  <TableHead className="text-right">{t("Monthly salary", "Salaire mensuel")}</TableHead>
                  <TableHead>{t("Start date", "Embauche")}</TableHead>
                  <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                  {canEdit && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map((e) => (
                  <TableRow key={e.id} className="cursor-pointer" onClick={() => navigate(`/contacts/${e.id}`)}>
                    <TableCell className="font-medium">
                      <Link href={`/contacts/${e.id}`} className="hover:underline" onClick={(ev) => ev.stopPropagation()}>{e.name}</Link>
                      {!e.active && <Badge variant="secondary" className="ml-2">{t("Inactive", "Inactif")}</Badge>}
                      {e.phone && <span className="block text-xs text-muted-foreground">{e.phone}</span>}
                    </TableCell>
                    <TableCell>{e.position ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-right"><Num>{e.monthlySalary ? usd(e.monthlySalary) : "—"}</Num></TableCell>
                    <TableCell className="whitespace-nowrap">{e.startDate ? fmtDate(e.startDate) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-right"><EmployeeBalance balance={e.balance} /></TableCell>
                    {canEdit && (
                      <TableCell onClick={(ev) => ev.stopPropagation()}>
                        <Button variant="ghost" size="icon" onClick={() => setEditing(e)} aria-label={t("Edit", "Modifier")}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {editing && <PartyDialog type="employee" party={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ---------------------------------------------------------------- Monthly payroll

interface GridEdit {
  include?: boolean;
  salary?: string;
  bonus?: string;
  deduction?: string;
}

function MonthTab({ data, canEdit }: { data: PayrollData; canEdit: boolean }) {
  const t = useT();
  const monthLabel = useMonthLabel();
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [edits, setEdits] = useState<Record<number, GridEdit>>({});
  const [accountId, setAccountId] = useState<number | null>(null);
  const [day, setDay] = useState("");
  const [paying, setPaying] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    setEdits({});
    setDay("");
  }, [month]);

  const run = data.runs.find((r) => r.month === month) ?? null;
  const active = data.employees.filter((e) => e.active);
  const effectiveAccount = accountId ?? data.salaryAccountId;
  // The current month defaults to today, not its last day: a future-dated entry would be missing from today's reports.
  const today = todayLocal();
  const effectiveDay = day || (month === today.slice(0, 7) ? today : lastDayOfMonth(month));

  const grid = active.map((e) => {
    const ed = edits[e.id] ?? {};
    const salary = ed.salary ?? (e.monthlySalary ? d(e.monthlySalary).toString() : "");
    const bonus = ed.bonus ?? "";
    const deduction = ed.deduction ?? "";
    const include = ed.include ?? true;
    const net = d(salary).plus(d(bonus)).minus(d(deduction));
    return { e, salary, bonus, deduction, include, net };
  });
  const included = grid.filter((g) => g.include);
  const total = included.reduce((s, g) => s.plus(g.net), d(0));
  const negative = included.find((g) => g.net.isNegative());
  const dayInMonth = effectiveDay.slice(0, 7) === month;

  function setEdit(id: number, patch: GridEdit) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  const post = useApiMutation<Record<string, unknown>, PayrollRun>("POST", "/api/payroll/runs", {
    success: t("Salaries booked", "Salaires comptabilisés"),
    onSuccess: () => setPaying(true),
  });
  const cancel = useApiMutation<Record<string, unknown>>("POST", `/api/payroll/runs/${month}/cancel`, {
    success: t("Payroll run cancelled", "Passage de paie annulé"),
    onSuccess: () => setConfirmCancel(false),
  });

  function submit() {
    if (!effectiveAccount) return;
    post.mutate({
      month,
      date: effectiveDay,
      accountId: effectiveAccount,
      lines: included.map((g) => ({
        partyId: g.e.id,
        salary: d(g.salary).toFixed(2),
        bonus: g.bonus.trim() ? d(g.bonus).toFixed(2) : null,
        deduction: g.deduction.trim() ? d(g.deduction).toFixed(2) : null,
      })),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("Month", "Mois")}>
          <MonthSelect value={month} onChange={setMonth} className="w-52" />
        </Field>
        {run && canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setPaying(true)}>
              <Wallet className="mr-1 h-4 w-4" /> {t("Pay salaries", "Payer les salaires")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmCancel(true)}>
              <Undo2 className="mr-1 h-4 w-4" /> {t("Cancel this run", "Annuler ce passage")}
            </Button>
          </div>
        )}
      </div>

      {run ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">{t(`Payroll ${monthLabel(month)}`, `Paie de ${monthLabel(month)}`)}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Booked on", "Comptabilisée le")} {fmtDate(run.date)} · {count(t, run.lines.length, ["employee", "employees"], ["employé", "employés"])}
              </p>
            </div>
            {run.journalId && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/vouchers/${run.journalId}`}><Printer className="mr-1 h-4 w-4" /> {t("View entry", "Voir l'écriture")}</Link>
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <RunLinesTable lines={run.lines} total={run.totalUsd} />
          </CardContent>
        </Card>
      ) : active.length === 0 ? (
        <EmptyState title={t("No active employees", "Aucun employé actif")}>
          {t("Add employees in the Employees tab first.", "Ajoutez d'abord des employés dans l'onglet Employés.")}
        </EmptyState>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t(`Prepare payroll for ${monthLabel(month)}`, `Préparer la paie de ${monthLabel(month)}`)}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t(
                "Booking records what each employee earned (salary expense, owed to the employee). Paying them comes next.",
                "Comptabiliser enregistre ce que chaque employé a gagné (charge de salaires, dû à l'employé). Le paiement vient ensuite.",
              )}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("Expense account", "Compte de charge")}>
                <AccountSelect value={effectiveAccount} onChange={setAccountId} types={["expense"]} />
              </Field>
              <Field label={t("Date", "Date")} error={dayInMonth ? null : t("The date must be inside the month", "La date doit être dans le mois")}>
                <Input type="date" value={effectiveDay} onChange={(e) => setDay(e.target.value)} />
              </Field>
            </div>
            <div className="-mx-6 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t("Employee", "Employé")}</TableHead>
                    <TableHead className="text-right">{t("Salary", "Salaire")}</TableHead>
                    <TableHead className="text-right">{t("Bonus", "Prime")}</TableHead>
                    <TableHead className="text-right">{t("Deduction", "Retenue")}</TableHead>
                    <TableHead className="text-right">{t("Net", "Net")}</TableHead>
                    <TableHead className="text-right">{t("Current balance", "Solde actuel")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grid.map((g) => (
                    <TableRow key={g.e.id} className={cn(!g.include && "opacity-50")}>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                          checked={g.include}
                          disabled={!canEdit}
                          onChange={(ev) => setEdit(g.e.id, { include: ev.target.checked })}
                          aria-label={t("Include", "Inclure")}
                        />
                      </TableCell>
                      <TableCell className="min-w-36 font-medium">
                        {g.e.name}
                        {g.e.position && <span className="block text-xs text-muted-foreground">{g.e.position}</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Input className="ml-auto w-24 text-right" inputMode="decimal" value={g.salary} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { salary: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input className="ml-auto w-20 text-right" inputMode="decimal" placeholder="0" value={g.bonus} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { bonus: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input className="ml-auto w-20 text-right" inputMode="decimal" placeholder="0" value={g.deduction} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { deduction: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Num className={cn("font-medium", g.net.isNegative() && "text-destructive")}>{usd(g.net.toFixed(2))}</Num>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm"><EmployeeBalance balance={g.e.balance} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{t("Total", "Total")} · {count(t, included.length, ["employee", "employees"], ["employé", "employés"])}</TableCell>
                    <TableCell className="text-right"><Num className="font-semibold">{usd(total.toFixed(2))}</Num></TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            {negative && <p className="text-sm text-destructive">{t(`${negative.e.name}: deductions are more than the salary`, `${negative.e.name} : les retenues dépassent le salaire`)}</p>}
            {canEdit && (
              <div className="flex justify-end">
                <Button
                  onClick={submit}
                  disabled={post.isPending || !effectiveAccount || !dayInMonth || included.length === 0 || !!negative || !total.gt(0)}
                >
                  {t("Book salaries", "Comptabiliser les salaires")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {paying && <PaySalariesDialog month={month} run={run} employees={data.employees} onClose={() => setPaying(false)} />}

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Cancel this payroll run?", "Annuler ce passage de paie\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                `The salary entry for ${monthLabel(month)} will be reversed. Payments already made stay on the employees' accounts.`,
                `L'écriture des salaires de ${monthLabel(month)} sera contre-passée. Les paiements déjà faits restent sur le compte des employés.`,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Back", "Retour")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancel.isPending}
              onClick={(e) => { e.preventDefault(); cancel.mutate({}); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("Cancel the run", "Annuler le passage")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RunLinesTable({ lines, total }: { lines: RunLine[]; total: string }) {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Employee", "Employé")}</TableHead>
            <TableHead className="text-right">{t("Salary", "Salaire")}</TableHead>
            <TableHead className="text-right">{t("Bonus", "Prime")}</TableHead>
            <TableHead className="text-right">{t("Deduction", "Retenue")}</TableHead>
            <TableHead className="text-right">{t("Net", "Net")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.partyId}>
              <TableCell className="font-medium">
                <Link href={`/contacts/${l.partyId}`} className="hover:underline">{l.name}</Link>
              </TableCell>
              <TableCell className="text-right"><Num>{usd(l.salary)}</Num></TableCell>
              <TableCell className="text-right"><Num>{d(l.bonus).isZero() ? "—" : usd(l.bonus)}</Num></TableCell>
              <TableCell className="text-right"><Num>{d(l.deduction).isZero() ? "—" : usd(l.deduction)}</Num></TableCell>
              <TableCell className="text-right"><Num className="font-medium">{usd(l.net)}</Num></TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={4}>{t("Total", "Total")}</TableCell>
            <TableCell className="text-right"><Num className="font-semibold">{usd(total)}</Num></TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------- Pay salaries

function PaySalariesDialog({ month, run, employees, onClose }: { month: string; run: PayrollRun | null; employees: Party[]; onClose: () => void }) {
  const t = useT();
  const monthLabel = useMonthLabel();
  const [account, setAccount] = useState<Account | null>(null);
  const [day, setDay] = useState(todayLocal());
  const { rate, setRate } = useRateField(day);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [doneId, setDoneId] = useState<number | null>(null);

  // One line per employee of the run, plus anyone else we still owe.
  const rows = useMemo(() => {
    const ids = new Set<number>(run?.lines.map((l) => l.partyId) ?? []);
    for (const e of employees) if (d(e.balance).isNegative()) ids.add(e.id);
    return employees.filter((e) => ids.has(e.id));
  }, [run, employees]);
  const owedOf = (e: Party) => (d(e.balance).isNegative() ? d(e.balance).abs() : d(0));
  const amountOf = (e: Party) => amounts[e.id] ?? owedOf(e).toFixed(2);

  const isCdf = account?.currency === "CDF";
  const r = d(rate);
  const lines = rows.map((e) => ({ e, usdAmount: d(amountOf(e)) })).filter((l) => l.usdAmount.gt(0));
  const total = lines.reduce((s, l) => s.plus(l.usdAmount), d(0));
  const frMonth = formatMonth(month, "fr");

  const pay = useApiMutation<Record<string, unknown>, { id: number; total: string }>("POST", "/api/vouchers/payment", {
    success: t("Salaries paid", "Salaires payés"),
    onSuccess: (res) => setDoneId(res.id),
  });

  function submit() {
    if (!account) return;
    pay.mutate({
      date: day,
      accountId: account.id,
      rate: isCdf ? r.toString() : undefined,
      memo: `Salaires ${frMonth}`,
      lines: lines.map((l) => ({
        partyId: l.e.id,
        amount: (isCdf ? l.usdAmount.times(r) : l.usdAmount).toFixed(2),
        memo: `Salaire ${frMonth}`,
      })),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(`Pay salaries · ${monthLabel(month)}`, `Payer les salaires · ${monthLabel(month)}`)}</DialogTitle>
          <DialogDescription>
            {t(
              "Prefilled with what each employee is owed; advances already given are deducted. Amounts are in USD.",
              "Prérempli avec ce qui est dû à chaque employé ; les avances déjà données sont déduites. Montants en USD.",
            )}
          </DialogDescription>
        </DialogHeader>
        {doneId ? (
          <div className="space-y-3 py-2">
            <p className="text-sm">{t("The payment voucher is saved.", "La pièce de paiement est enregistrée.")}</p>
            <Button asChild>
              <Link href={`/vouchers/${doneId}`}><Printer className="mr-1 h-4 w-4" /> {t("Open and print the voucher", "Ouvrir et imprimer la pièce")}</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("Pay from", "Payer depuis")} className="sm:col-span-1">
                <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
              </Field>
              <Field label={t("Date", "Date")}>
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
              {isCdf && (
                <Field label={t("Rate (CDF per USD)", "Taux (FC pour 1 USD)")}>
                  <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                </Field>
              )}
            </div>
            {rows.length === 0 ? (
              <EmptyState title={t("Nobody is owed anything", "Personne n'a rien à recevoir")} />
            ) : (
              <div className="divide-y rounded-md border">
                {rows.map((e) => {
                  const a = d(amountOf(e));
                  return (
                    <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{e.name}</p>
                        <p className="text-xs"><EmployeeBalance balance={e.balance} /></p>
                      </div>
                      <div className="text-right">
                        <Input className="w-28 text-right" inputMode="decimal" value={amountOf(e)} onChange={(ev) => setAmounts((p) => ({ ...p, [e.id]: ev.target.value }))} />
                        {isCdf && r.gt(0) && <p className="mt-0.5 text-xs text-muted-foreground">{cdf(a.times(r).toFixed(0))}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between rounded-md bg-muted/50 p-3 text-sm">
              <span>{t("Total", "Total")} · {count(t, lines.length, ["employee", "employees"], ["employé", "employés"])}</span>
              <Num className="font-semibold">
                {usd(total.toFixed(2))}
                {isCdf && r.gt(0) && <span className="ml-2 font-normal text-muted-foreground">{cdf(total.times(r).toFixed(0))}</span>}
              </Num>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{doneId ? t("Close", "Fermer") : t("Cancel", "Annuler")}</Button>
          {!doneId && (
            <Button onClick={submit} disabled={pay.isPending || !account || lines.length === 0 || (isCdf && !r.gt(0))}>
              {t("Pay", "Payer")} {usd(total.toFixed(2))}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Advances

function AdvancesTab({ employees, canEdit }: { employees: Party[]; canEdit: boolean }) {
  const t = useT();
  const [partyId, setPartyId] = useState<number | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(todayLocal());
  const { rate, setRate } = useRateField(day);
  const [memo, setMemo] = useState("");
  const [doneId, setDoneId] = useState<number | null>(null);
  const isCdf = account?.currency === "CDF";
  const r = d(rate);
  const a = d(amount);
  const outstanding = employees.filter((e) => d(e.balance).gt(0));
  const outstandingTotal = outstanding.reduce((s, e) => s.plus(e.balance), d(0));

  const give = useApiMutation<Record<string, unknown>, { id: number; total: string }>("POST", "/api/vouchers/payment", {
    success: t("Advance recorded", "Avance enregistrée"),
    onSuccess: (res) => {
      setDoneId(res.id);
      setAmount("");
      setMemo("");
      setPartyId(null);
    },
  });

  function submit() {
    if (!account || !partyId) return;
    const m = memo.trim() || "Avance sur salaire";
    give.mutate({
      date: day,
      accountId: account.id,
      rate: isCdf ? r.toString() : undefined,
      memo: m,
      lines: [{ partyId, amount: a.toFixed(2), memo: m }],
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><HandCoins className="h-4 w-4" /> {t("Give an advance", "Donner une avance")}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t("Advances are deducted automatically from the next salary payment.", "Les avances sont déduites automatiquement du prochain paiement de salaire.")}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label={t("Employee", "Employé")}>
              <PartySelect types={["employee"]} value={partyId} onChange={(id) => setPartyId(id)} allowCreate={false} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("Paid from", "Payé depuis")}>
                <MoneyAccountSelect value={account?.id ?? null} onChange={(_, acc) => setAccount(acc)} />
              </Field>
              <Field label={t("Date", "Date")}>
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
              <Field
                label={`${t("Amount", "Montant")}${account ? ` (${account.currency})` : ""}`}
                hint={isCdf && a.gt(0) && r.gt(0) ? `≈ ${usd(a.div(r).toFixed(2))}` : undefined}
              >
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              </Field>
              {isCdf && (
                <Field label={t("Rate (CDF per USD)", "Taux (FC pour 1 USD)")}>
                  <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                </Field>
              )}
            </div>
            <Field label={t("Memo", "Libellé")}>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t("Salary advance", "Avance sur salaire")} />
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {doneId && (
                <Button variant="outline" asChild>
                  <Link href={`/vouchers/${doneId}`}><Printer className="mr-1 h-4 w-4" /> {t("Print voucher", "Imprimer la pièce")}</Link>
                </Button>
              )}
              <Button onClick={submit} disabled={give.isPending || !partyId || !account || !a.gt(0) || (isCdf && !r.gt(0))}>
                {t("Give the advance", "Donner l'avance")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <Card className={cn(!canEdit && "lg:col-span-2")}>
        <CardHeader>
          <CardTitle className="text-base">{t("Advances outstanding", "Avances en cours")}</CardTitle>
          {!canEdit && (
            <p className="text-sm text-muted-foreground">
              {t("Advances are deducted automatically from the next salary payment.", "Les avances sont déduites automatiquement du prochain paiement de salaire.")}
            </p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {outstanding.length === 0 ? (
            <div className="p-4"><EmptyState title={t("No advance outstanding", "Aucune avance en cours")} /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Employee", "Employé")}</TableHead>
                  <TableHead className="text-right">{t("To repay", "À rembourser")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstanding.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">
                      <Link href={`/contacts/${e.id}`} className="hover:underline">{e.name}</Link>
                      {e.position && <span className="block text-xs text-muted-foreground">{e.position}</span>}
                    </TableCell>
                    <TableCell className="text-right"><Num className="font-medium text-amber-700 dark:text-amber-400">{usd(e.balance)}</Num></TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("Total", "Total")}</TableCell>
                  <TableCell className="text-right"><Num className="font-semibold">{usd(outstandingTotal.toFixed(2))}</Num></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- History

function HistoryTab({ runs }: { runs: PayrollRun[] }) {
  const t = useT();
  const monthLabel = useMonthLabel();
  const [open, setOpen] = useState<number | null>(null);
  const sorted = [...runs].sort((a, b) => b.month.localeCompare(a.month));
  if (sorted.length === 0) return <EmptyState title={t("No payroll booked yet", "Aucune paie comptabilisée pour l'instant")} />;
  const grand = sorted.reduce((s, r) => s.plus(r.totalUsd), d(0));
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t("Month", "Mois")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("Date", "Date")}</TableHead>
                <TableHead className="text-right">{t("Employees", "Employés")}</TableHead>
                <TableHead className="text-right">{t("Total", "Total")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <TableCell>{open === r.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                    <TableCell className="font-medium">{monthLabel(r.month)}</TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">{fmtDate(r.date)}</TableCell>
                    <TableCell className="text-right"><Num>{r.lines.length}</Num></TableCell>
                    <TableCell className="text-right"><Num className="font-medium">{usd(r.totalUsd)}</Num></TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {r.journalId && (
                        <Button variant="ghost" size="icon" asChild aria-label={t("View entry", "Voir l'écriture")}>
                          <Link href={`/vouchers/${r.journalId}`}><Printer className="h-4 w-4" /></Link>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {open === r.id && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-muted/30 p-2">
                        <RunLinesTable lines={r.lines} total={r.totalUsd} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>{t("Total", "Total")} · {count(t, sorted.length, ["month", "months"], ["mois", "mois"])}</TableCell>
                <TableCell className="text-right"><Num className="font-semibold">{usd(grand.toFixed(2))}</Num></TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
