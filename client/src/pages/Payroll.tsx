import { Fragment, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { capitalize, de, deMonth, monthText } from "@shared/french";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Check, ChevronDown, ChevronRight, HandCoins, Pencil, Plus, Printer, Undo2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { EmptyState, ErrorText, Field, francDecimalsError, Loading, Num, PageHeader, StatCard, SubmitButton, unclearAmount } from "@/components/common";
import { AccountSelect, MoneyAccountSelect, MonthSelect, PartySelect, RateInput, useAccounts, useRateField, useRateTooFar } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useI18n, useT, count } from "@/lib/i18n";
import { curLabel, cdf, d, date as fmtDate, money, number, todayLocal, typedNumberOk, usd } from "@/lib/format";
import type { Account, Party } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PartyDialog } from "@/pages/Contacts";

// ---------------------------------------------------------------- Types and helpers

interface RunLine {
  partyId: number;
  name: string;
  salary: string;
  bonus: string;
  /** Kept from the pay, still a cost: owed to someone else. Older runs have only `deduction`. */
  withheld?: string;
  /** A fine: lowers the cost. */
  penalty?: string;
  deduction: string;
  net: string;
  netUsd?: string;
  /** Posted runs: the part of the net that came off an advance the employee already had, not paid in cash. */
  advanceUsd?: string;
}

interface PayrollRun {
  id: number;
  month: string;
  status: "posted" | "cancelled";
  currency: "USD" | "CDF";
  rate: string | null;
  date: string;
  accountId: number;
  totalUsd: string;
  lines: RunLine[];
  journalId: number | null;
  cancelledAt: string | null;
  cancelJournalId: number | null;
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

/** "octobre 2026" in running text (French months are lower case), "October 2026" in English. */
function useMonthLabel() {
  const { lang } = useI18n();
  return (month: string) => monthText(month, lang);
}

/**
 * Employee balance in words. Debit-positive: negative = we owe them, positive = an advance they still owe.
 * `beforePay`: beside a month not yet recorded, nothing due reads "Aucune avance", never "Soldé" (as if paid).
 */
export function EmployeeBalance({ balance, className, beforePay }: { balance: string | null | undefined; className?: string; beforePay?: boolean }) {
  const t = useT();
  const b = d(balance);
  if (b.isZero()) return <span className={cn("text-muted-foreground", className)}>{beforePay ? t("No advance", "Aucune avance") : t("Settled", "Soldé")}</span>;
  if (b.isNegative()) {
    const x = usd(b.abs().toFixed(2));
    return <span className={cn("font-medium text-blue-700 dark:text-blue-400", className)}>{t(`We owe them ${x}`, `On lui doit ${x}`)}</span>;
  }
  const x = usd(b.toFixed(2));
  return <span className={cn("font-medium text-amber-800 dark:text-amber-400", className)}>{t(`Advance to repay ${x}`, `Avance à rembourser ${x}`)}</span>;
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
          "Le personnel, les salaires du mois, les avances et les paiements. Les salaires sont une charge\u00a0; paiements et avances passent par le compte de l'employé.",
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
  withheld?: string;
  penalty?: string;
}

function MonthTab({ data, canEdit }: { data: PayrollData; canEdit: boolean }) {
  const t = useT();
  const monthLabel = useMonthLabel();
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [edits, setEdits] = useState<Record<number, GridEdit>>({});
  const [accountId, setAccountId] = useState<number | null>(null);
  const [day, setDay] = useState("");
  const [paying, setPaying] = useState(false);
  // The payroll just saved: said at the top of the payment dialog that opens, not by a toast over its title.
  const [justSaved, setJustSaved] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmFar, setConfirmFar] = useState(false);
  const [currency, setCurrency] = useState<"USD" | "CDF">("USD");

  useEffect(() => {
    setEdits({});
    setDay("");
  }, [month]);

  const run = data.runs.find((r) => r.month === month && r.status !== "cancelled") ?? null;
  const cancelledRuns = data.runs.filter((r) => r.month === month && r.status === "cancelled");
  const active = data.employees.filter((e) => e.active);
  /** Nobody on this run is still owed anything: the salaries are paid, so there is nothing left to pay. */
  const fullyPaid = !!run && run.lines.every((l) => !d(data.employees.find((e) => e.id === l.partyId)?.balance).isNegative());
  const effectiveAccount = accountId ?? data.salaryAccountId;
  // The current month defaults to today, not its last day: a future-dated entry would be missing from today's reports.
  const today = todayLocal();
  const effectiveDay = day || (month === today.slice(0, 7) ? today : lastDayOfMonth(month));
  const { rate, setRate } = useRateField(effectiveDay);
  const rateFar = useRateTooFar(effectiveDay, rate);
  // Francs with centimes (a slip the server refuses) are shown as typed, not rounded to "416 200 FC".
  const fmt = (v: unknown) => (currency === "CDF" && !d(v).isInteger() ? `${number(v, 2)}\u00a0FC` : money(v, currency));
  /** "Les montants en FC sont des nombres entiers" for a franc field typed with centimes ("5000,5"). */
  const centsError = (v: string) => francDecimalsError(t, currency, v);

  const grid = active.map((e) => {
    const ed = edits[e.id] ?? {};
    // Monthly salaries are kept in dollars; a franc payroll starts from them at the rate.
    const base = e.monthlySalary ? d(e.monthlySalary) : null;
    const salary = ed.salary ?? (base ? (currency === "CDF" ? (d(rate).gt(0) ? base.times(d(rate)).toDecimalPlaces(0).toString() : "") : base.toString()) : "");
    const bonus = ed.bonus ?? "";
    const withheld = ed.withheld ?? "";
    const penalty = ed.penalty ?? "";
    const include = ed.include ?? true;
    const net = d(salary).plus(d(bonus)).minus(d(withheld)).minus(d(penalty));
    // The usual salary in the run's currency, to question "842 4000" typed for 842 400 FC.
    const usual = base?.gt(0) ? (currency === "CDF" ? (d(rate).gt(0) ? base.times(d(rate)).toDecimalPlaces(0) : null) : base) : null;
    return { e, salary, bonus, withheld, penalty, include, net, usual };
  });
  const included = grid.filter((g) => g.include);
  const total = included.reduce((s, g) => s.plus(g.net), d(0));
  const negative = included.find((g) => g.net.isNegative());
  /** Francs are paid in 100 FC notes: only a warning, the amount stays as typed. */
  const notRound = currency === "CDF" ? included.find((g) => g.net.gt(0) && !g.net.mod(100).isZero()) : undefined;
  const withCents = included.find((g) => [g.salary, g.bonus, g.withheld, g.penalty].some((v) => centsError(v)));
  const gridInvalid = !!withCents || included.some((g) => ![g.salary, g.bonus, g.withheld, g.penalty].every(typedNumberOk));
  const dayInMonth = effectiveDay.slice(0, 7) === month;
  // A salary more than twice, or under half, the usual one is said and confirmed before saving, never refused.
  const farOff = included.filter((g) => g.usual && g.salary.trim() && typedNumberOk(g.salary) && (d(g.salary).gt(g.usual.times(2)) || d(g.salary).lt(g.usual.dividedBy(2))));
  const farOffText = (g: (typeof grid)[number]) => {
    const ratio = d(g.salary).dividedBy(g.usual!);
    const hint = ratio.gte(5) ? t(" An extra zero?", " Un zéro de trop\u00a0?") : ratio.lte(0.2) ? t(" A zero missing?", " Un zéro oublié\u00a0?") : "";
    return t(`${g.e.name}: ${fmt(g.salary)} instead of the usual ${fmt(g.usual!.toString())}.`, `${g.e.name}\u00a0: ${fmt(g.salary)} au lieu de ${fmt(g.usual!.toString())} habituels.`) + hint;
  };

  /** Switching currency converts what was typed at the rate, so 250 $ does not become 250 FC. */
  function changeCurrency(next: "USD" | "CDF") {
    if (next === currency) return;
    const r = d(rate);
    const conv = (v: string | undefined) => {
      if (v === undefined || !v.trim() || !r.gt(0)) return v;
      return next === "CDF" ? d(v).times(r).toDecimalPlaces(0).toString() : d(v).dividedBy(r).toDecimalPlaces(2).toString();
    };
    setEdits((prev) =>
      Object.fromEntries(Object.entries(prev).map(([k, e]) => [k, { ...e, salary: conv(e.salary), bonus: conv(e.bonus), withheld: conv(e.withheld), penalty: conv(e.penalty) }])),
    );
    setCurrency(next);
  }

  function setEdit(id: number, patch: GridEdit) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  const post = useApiMutation<Record<string, unknown>, PayrollRun>("POST", "/api/payroll/runs", {
    onSuccess: () => {
      setJustSaved(true);
      setPaying(true);
    },
  });
  // What cancelling changes for the part of each net pay no longer owed. Paid out in cash, reversing the salary
  // leaves that money as an advance to repay; deducted from an advance the employee already had (or one given
  // after the run, which came off it), it simply goes back onto that advance: said apart, by what happened.
  const zero = { usd: d(0), native: d(0), people: 0 };
  const { paidAsAdvance, backOnAdvance } = (run?.lines ?? []).reduce(
    (s, l) => {
      const e = data.employees.find((x) => x.id === l.partyId);
      const bal = d(e?.balance);
      const netUsd = d(l.netUsd ?? (run!.currency === "USD" ? l.net : 0));
      const usdPart = Decimal.max(bal.plus(netUsd), 0).minus(Decimal.max(bal, 0));
      if (!usdPart.gt(0)) return s;
      const after = e?.advanceDeducted?.month === run!.month ? d(e.advanceDeducted.usd) : d(0);
      const fromAdvance = Decimal.min(d(l.advanceUsd ?? 0).plus(after), usdPart);
      const cash = usdPart.minus(fromAdvance);
      // In the run's currency, at the run's own rate (the whole net when all of it was settled).
      const native = (x: Decimal) => (netUsd.gt(0) ? x.dividedBy(netUsd).times(d(l.net)) : x);
      const add = (acc: typeof zero, x: Decimal) => (x.gt(0) ? { usd: acc.usd.plus(x), native: acc.native.plus(native(x)), people: acc.people + 1 } : acc);
      return { paidAsAdvance: add(s.paidAsAdvance, cash), backOnAdvance: add(s.backOnAdvance, fromAdvance) };
    },
    { paidAsAdvance: zero, backOnAdvance: zero },
  );
  const cancel = useApiMutation<Record<string, unknown>>("POST", `/api/payroll/runs/${month}/cancel`, {
    success: t("Payroll cancelled", "Paie annulée"),
    onSuccess: () => setConfirmCancel(false),
  });

  function submit() {
    if (!effectiveAccount) return;
    post.mutate({
      month,
      date: effectiveDay,
      accountId: effectiveAccount,
      currency,
      rate: currency === "CDF" ? d(rate).toString() : null,
      lines: included.map((g) => ({
        partyId: g.e.id,
        salary: d(g.salary).toFixed(2),
        bonus: g.bonus.trim() ? d(g.bonus).toFixed(2) : null,
        withheld: g.withheld.trim() ? d(g.withheld).toFixed(2) : null,
        penalty: g.penalty.trim() ? d(g.penalty).toFixed(2) : null,
      })),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("Month", "Mois")}>
          {/* Salaries are earned month by month: next month's payroll is not offered before it starts. */}
          <MonthSelect value={month} onChange={setMonth} className="w-52" max={todayLocal().slice(0, 7)} />
        </Field>
        {run && canEdit && (
          <div className="flex flex-wrap gap-2">
            {fullyPaid ? (
              <Badge variant="outline" className="h-9 border-green-700/40 bg-green-50 px-3 text-sm font-medium text-green-800 dark:border-green-400/40 dark:bg-green-950/40 dark:text-green-300">
                <Check className="mr-1 h-4 w-4" /> {t("Salaries paid", "Salaires payés")}
              </Badge>
            ) : (
              <Button onClick={() => setPaying(true)}>
                <Wallet className="mr-1 h-4 w-4" /> {t("Pay salaries", "Payer les salaires")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setConfirmCancel(true)}>
              <Undo2 className="mr-1 h-4 w-4" /> {t(`Cancel the ${monthLabel(month)} payroll`, `Annuler la paie ${deMonth(month)}`)}
            </Button>
          </div>
        )}
      </div>

      {run ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">{t(`Payroll ${monthLabel(month)}`, `Paie ${deMonth(month)}`)}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Saved on", "Enregistrée le")} {fmtDate(run.date)} · {count(t, run.lines.length, ["employee", "employees"], ["employé", "employés"])}
              </p>
            </div>
            {run.journalId && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/vouchers/${run.journalId}`}><Printer className="mr-1 h-4 w-4" /> {t("View entry", "Voir l'écriture")}</Link>
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <RunLinesTable run={run} />
          </CardContent>
        </Card>
      ) : active.length === 0 ? (
        <EmptyState title={t("No active employees", "Aucun employé actif")}>
          {t("Add employees in the Employees tab first.", "Ajoutez d'abord des employés dans l'onglet Employés.")}
        </EmptyState>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t(`Prepare payroll for ${monthLabel(month)}`, `Préparer la paie ${deMonth(month)}`)}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t(
                "Saving records what each employee earned this month and now is owed. Paying them comes next.",
                "Enregistrer la paie note ce que chaque employé a gagné ce mois-ci et ce qui lui est dû. Le paiement vient ensuite.",
              )}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("Recorded under", "Classée dans les dépenses")} required>
                <AccountSelect hideCode value={effectiveAccount} onChange={setAccountId} types={["expense"]} />
              </Field>
              <Field label={t("Date", "Date")} error={dayInMonth ? null : t("The date must be inside the month", "La date doit être dans le mois")} required>
                <Input type="date" aria-label={t("Payroll date", "Date de la paie")} value={effectiveDay} onChange={(e) => setDay(e.target.value)} />
              </Field>
              <Field label={t("Salaries owed in", "Salaires dus en")}>
                <Select value={currency} onValueChange={(v) => changeCurrency(v as "USD" | "CDF")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">{t("Dollars ($)", "Dollars ($)")}</SelectItem>
                    <SelectItem value="CDF">{t("Francs (FC)", "Francs (FC)")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {currency === "CDF" && (
                <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} required>
                  <RateInput day={effectiveDay} value={rate} onChange={setRate} />
                </Field>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "Withheld: kept from the pay but owed to someone else (tax, social security); it stays a salary cost. Penalty: a fine, it lowers the cost.",
                "Retenue\u00a0: gardée sur la paie mais due à un tiers (impôt, sécurité sociale)\u00a0; elle reste une charge de salaire. Pénalité\u00a0: une amende, elle réduit la charge.",
              )}
            </p>
            <div className="-mx-6 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t("Employee", "Employé")}</TableHead>
                    <TableHead className="text-right">{t("Salary", "Salaire")}</TableHead>
                    <TableHead className="text-right">{t("Bonus", "Prime")}</TableHead>
                    <TableHead className="text-right">{t("Withheld", "Retenue")}</TableHead>
                    <TableHead className="text-right">{t("Penalty", "Pénalité")}</TableHead>
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
                        <Input className="w-full text-right sm:ml-auto sm:w-28" inputMode="decimal" usd={currency === "USD"} thousands={currency === "CDF"} aria-label={t(`Salary of ${g.e.name}`, `Salaire ${de(g.e.name)}`)} aria-invalid={!!centsError(g.salary) || undefined} value={g.salary} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { salary: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input className="w-full text-right sm:ml-auto sm:w-24" inputMode="decimal" usd={currency === "USD"} thousands={currency === "CDF"} aria-label={t(`Bonus for ${g.e.name}`, `Prime ${de(g.e.name)}`)} placeholder="—" aria-invalid={!!centsError(g.bonus) || undefined} value={g.bonus} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { bonus: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input className="w-full text-right sm:ml-auto sm:w-24" inputMode="decimal" usd={currency === "USD"} thousands={currency === "CDF"} aria-label={t(`Withheld for ${g.e.name}`, `Retenue ${de(g.e.name)}`)} placeholder="—" aria-invalid={!!centsError(g.withheld) || undefined} value={g.withheld} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { withheld: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input className="w-full text-right sm:ml-auto sm:w-24" inputMode="decimal" usd={currency === "USD"} thousands={currency === "CDF"} aria-label={t(`Penalty for ${g.e.name}`, `Pénalité ${de(g.e.name)}`)} placeholder="—" aria-invalid={!!centsError(g.penalty) || undefined} value={g.penalty} disabled={!canEdit} onChange={(ev) => setEdit(g.e.id, { penalty: ev.target.value })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Num className={cn("font-medium", g.net.isNegative() && "text-destructive")}>{fmt(g.net.toFixed(2))}</Num>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm"><EmployeeBalance balance={g.e.balance} beforePay /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={6}>{t("Total", "Total")} · {count(t, included.length, ["employee", "employees"], ["employé", "employés"])}</TableCell>
                    {/* A line that cannot be saved (centimes, an amount unread) makes no total: "—" until it is corrected. */}
                    <TableCell className="text-right"><Num className="font-semibold">{gridInvalid ? "—" : fmt(total.toFixed(2))}</Num></TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            {/* Centimes are refused below; "not a multiple of 100 FC" would only repeat it. */}
            {currency === "CDF" && notRound && !withCents && (
              <p className="text-sm text-amber-800 dark:text-amber-400">
                {t(
                  `${notRound.e.name}: ${fmt(notRound.net.toString())} is not a multiple of 100 FC, which is hard to pay in notes`,
                  `${notRound.e.name} : ${fmt(notRound.net.toString())} n'est pas un multiple de 100 FC, difficile à payer en billets`,
                )}
              </p>
            )}
            {withCents && <p className="text-sm text-destructive">{t(`${withCents.e.name}: franc amounts are whole numbers (no centimes)`, `${withCents.e.name}\u00a0: les montants en FC sont des nombres entiers (sans centimes)`)}</p>}
            {negative && <p className="text-sm text-destructive">{t(`${negative.e.name}: deductions are more than the salary`, `${negative.e.name}\u00a0: les retenues dépassent le salaire`)}</p>}
            {farOff.length > 0 && !gridInvalid && (
              <div className="space-y-1 text-sm text-amber-800 dark:text-amber-400" data-testid="payroll-far-off">
                {farOff.map((g) => <p key={g.e.id}>{farOffText(g)}</p>)}
              </div>
            )}
            {canEdit && (
              <div className="flex justify-end">
                <SubmitButton
                  onClick={() => (farOff.length ? setConfirmFar(true) : submit())}
                  blocked={
                    !effectiveAccount
                      ? t("Choose the expense account", "Choisissez le compte de charge")
                      : !dayInMonth
                        ? t("Choose a date inside the month", "Choisissez une date dans le mois")
                        : currency === "CDF" && !d(rate).gt(0)
                          ? t("Enter the exchange rate", "Saisissez le taux de change")
                        : currency === "CDF" && rateFar
                          ? rateFar
                          : included.length === 0
                            ? t("Include at least one employee", "Incluez au moins un employé")
                            : included.some((g) => ![g.salary, g.bonus, g.withheld, g.penalty].every(typedNumberOk))
                              ? t("Correct the amounts that cannot be read", "Corrigez les montants illisibles")
                              : withCents
                                ? t("Remove the centimes from the franc amounts", "Retirez les centimes des montants en FC")
                              : negative
                                ? t("Fix the deductions that are more than the salary", "Corrigez les retenues qui dépassent le salaire")
                                : !total.gt(0)
                                  ? t("The total must be above zero", "Le total doit être supérieur à zéro")
                                  : null
                  }
                  pending={post.isPending}
                >
                  {t("Save the payroll", "Enregistrer la paie")}
                </SubmitButton>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {cancelledRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Cancelled runs", "Paies annulées")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("Kept for the record. Their entries were reversed.", "Gardées pour l'historique. Leurs écritures ont été annulées.")}</p>
          </CardHeader>
          <CardContent className="space-y-4 p-0 pb-4">
            {cancelledRuns.map((r) => (
              <div key={r.id} className="space-y-1">
                <p className="flex flex-wrap items-center gap-2 px-6 text-sm">
                  <Badge variant="destructive">{t("Cancelled", "Annulée")}</Badge>
                  {t("Saved on", "Enregistrée le")} {fmtDate(r.date)}
                  {r.cancelledAt && <> · {t("cancelled on", "annulée le")} {fmtDate(r.cancelledAt)}</>}
                  {r.cancelJournalId && <Link href={`/vouchers/${r.cancelJournalId}`} className="text-primary hover:underline">{t("cancelling entry", "écriture d'annulation")}</Link>}
                </p>
                <RunLinesTable run={r} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {paying && <PaySalariesDialog month={month} run={run} employees={data.employees} saved={justSaved} onClose={() => { setPaying(false); setJustSaved(false); }} />}

      <AlertDialog open={confirmFar} onOpenChange={setConfirmFar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{farOff.length === 1 ? t("An unusual salary?", "Un salaire inhabituel\u00a0?") : t(`${farOff.length} unusual salaries?`, `${farOff.length} salaires inhabituels\u00a0?`)}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {farOff.map((g) => <p key={g.e.id}>{farOffText(g)}</p>)}
                <p>{t("The salary saved is what they are owed, and what the payment then offers to pay.", `Le salaire enregistré est ce qui ${farOff.length === 1 ? "lui" : "leur"} est dû, et ce que le paiement proposera ensuite de payer.`)}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmFar(false);
                submit();
              }}
            >
              {t("Save anyway", "Enregistrer quand même")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`Cancel the ${monthLabel(month)} payroll?`, `Annuler la paie ${deMonth(month)}\u00a0?`)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(`The salary entry for ${monthLabel(month)} will be reversed.`, `L'écriture des salaires ${deMonth(month)} sera annulée.`)}{" "}
              {paidAsAdvance.usd.gt(0) &&
                (run?.currency === "CDF"
                  ? t(
                      `${cdf(paidAsAdvance.native.toFixed(0))} already paid will become advances (${usd(paidAsAdvance.usd.toFixed(2))}) to repay or deduct from the next salaries.`,
                      `${cdf(paidAsAdvance.native.toFixed(0))} déjà payés deviendront des avances (${usd(paidAsAdvance.usd.toFixed(2))}) à rembourser ou à déduire des prochains salaires.`,
                    )
                  : t(
                      `${usd(paidAsAdvance.usd.toFixed(2))} already paid will become advances to repay or deduct from the next salaries.`,
                      `${usd(paidAsAdvance.usd.toFixed(2))} déjà payés deviendront des avances à rembourser ou à déduire des prochains salaires.`,
                    ))}{" "}
              {/* No cash paid: the salary only came off an advance, which gets that money back. */}
              {backOnAdvance.usd.gt(0) &&
                (() => {
                  const amount = run?.currency === "CDF" ? `${cdf(backOnAdvance.native.toFixed(0))} (${usd(backOnAdvance.usd.toFixed(2))})` : usd(backOnAdvance.usd.toFixed(2));
                  return backOnAdvance.people === 1
                    ? t(`${amount} already deducted from the advance go back onto it.`, `${amount} déjà déduits de son avance y sont remis.`)
                    : t(`${amount} already deducted from their advances go back onto them.`, `${amount} déjà déduits de leurs avances y sont remis.`);
                })()}
              {!paidAsAdvance.usd.gt(0) && !backOnAdvance.usd.gt(0) && t("Nothing has been paid on it yet.", "Rien n'a encore été payé dessus.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Back", "Retour")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancel.isPending}
              onClick={(e) => { e.preventDefault(); cancel.mutate({}); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("Cancel the payroll", "Annuler la paie")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RunLinesTable({ run }: { run: PayrollRun }) {
  const t = useT();
  const fmt = (v: unknown) => money(v, run.currency);
  // Older runs only know one deduction, which lowered the cost: shown as a penalty.
  const penaltyOf = (l: RunLine) => l.penalty ?? (l.withheld == null ? l.deduction : "0");
  const total = run.lines.reduce((s, l) => s.plus(d(l.net)), d(0));
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Employee", "Employé")}</TableHead>
            <TableHead className="text-right">{t("Salary", "Salaire")}</TableHead>
            <TableHead className="text-right">{t("Bonus", "Prime")}</TableHead>
            <TableHead className="text-right">{t("Withheld", "Retenue")}</TableHead>
            <TableHead className="text-right">{t("Penalty", "Pénalité")}</TableHead>
            <TableHead className="text-right">{t("Net", "Net")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {run.lines.map((l) => (
            <TableRow key={l.partyId}>
              <TableCell className="font-medium">
                <Link href={`/contacts/${l.partyId}`} className="hover:underline">{l.name}</Link>
              </TableCell>
              <TableCell className="text-right"><Num>{fmt(l.salary)}</Num></TableCell>
              <TableCell className="text-right"><Num>{d(l.bonus).isZero() ? "—" : fmt(l.bonus)}</Num></TableCell>
              <TableCell className="text-right"><Num>{d(l.withheld).isZero() ? "—" : fmt(l.withheld)}</Num></TableCell>
              <TableCell className="text-right"><Num>{d(penaltyOf(l)).isZero() ? "—" : fmt(penaltyOf(l))}</Num></TableCell>
              <TableCell className="text-right"><Num className="font-medium">{fmt(l.net)}</Num></TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={5}>
              {t("Total", "Total")}
              {run.currency === "CDF" && run.rate && <span className="ml-2 text-xs text-muted-foreground">{t(`at ${cdf(run.rate)} per $1`, `à ${cdf(run.rate)} pour 1 $`)}</span>}
            </TableCell>
            <TableCell className="text-right">
              <Num className="font-semibold">{fmt(total.toFixed(2))}</Num>
              {run.currency === "CDF" && <span className="block text-xs text-muted-foreground">{t("cost", "charge")} {usd(run.totalUsd)}</span>}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------- Pay salaries

function PaySalariesDialog({ month, run, employees, saved, onClose }: { month: string; run: PayrollRun | null; employees: Party[]; saved?: boolean; onClose: () => void }) {
  const t = useT();
  const monthLabel = useMonthLabel();
  const [account, setAccount] = useState<Account | null>(null);
  const [day, setDay] = useState(todayLocal());
  const { rate, setRate } = useRateField(day);
  const rateFar = useRateTooFar(day, rate);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [doneId, setDoneId] = useState<number | null>(null);

  // One line per employee of the run, plus anyone else we still owe.
  const rows = useMemo(() => {
    const ids = new Set<number>(run?.lines.map((l) => l.partyId) ?? []);
    for (const e of employees) if (d(e.balance).isNegative()) ids.add(e.id);
    return employees.filter((e) => ids.has(e.id));
  }, [run, employees]);
  const owedOf = (e: Party) => (d(e.balance).isNegative() ? d(e.balance).abs() : d(0));
  const isCdf = account?.currency === "CDF";
  const r = d(rate);
  // Francs owed (from a payroll in francs) are paid in francs to the franc; the dollar part at the day's rate.
  const owedFc = (e: Party) => {
    const f = e.foreign?.find((x) => x.currency === "CDF");
    return f && d(f.native).isNegative() ? { native: d(f.native).abs(), usd: d(f.usd).abs() } : { native: d(0), usd: d(0) };
  };
  const suggested = (e: Party) => {
    if (!isCdf) return owedOf(e).toFixed(2);
    const fc = owedFc(e);
    const dollars = owedOf(e).minus(fc.usd);
    // The exact net, to the franc: rounding it up to 100 FC would book the few francs over as an advance
    // (870 500 FC paid on 870 480 FC owed leaves 0,01 $ to repay). The note below says when it is not in 100 FC notes.
    const owed = fc.native.plus(dollars.gt(0) && r.gt(0) ? dollars.times(r) : 0);
    if (!owed.gt(0)) return "0";
    return owed.toDecimalPlaces(0).toFixed(0);
  };
  /** What is owed, in francs first when it is paid in francs or was earned in francs: "On lui doit 702 000 FC (250,00 $)". */
  const owedText = (e: Party) => {
    const owed = owedOf(e);
    if (!owed.gt(0)) return null;
    const fc = owedFc(e);
    const dollars = owed.minus(fc.usd);
    const francs = isCdf && r.gt(0) ? fc.native.plus(dollars.gt(0) ? dollars.times(r) : 0) : !dollars.gt(0) ? fc.native : null;
    if (!francs || !francs.gt(0)) return null;
    const x = `${cdf(francs.toFixed(0))} (${usd(owed.toFixed(2))})`;
    return <span className="font-medium text-blue-700 dark:text-blue-400">{t(`We owe them ${x}`, `On lui doit ${x}`)}</span>;
  };
  const keyOf = (e: Party) => `${e.id}:${isCdf ? "CDF" : "USD"}`;
  const amountOf = (e: Party) => amounts[keyOf(e)] ?? suggested(e);
  /** What they are owed in the paying account's currency, as the suggestion counts it (unrounded). */
  const owedHere = (e: Party) => {
    if (!isCdf) return owedOf(e);
    const fc = owedFc(e);
    const dollars = owedOf(e).minus(fc.usd);
    return fc.native.plus(dollars.gt(0) && r.gt(0) ? dollars.times(r) : 0).toDecimalPlaces(0);
  };
  // More than is owed becomes an advance: "7 520 000" typed for 752 000 FC is said in words and confirmed
  // before paying. So does rounding francs up to the next 100 FC: there is no rounding line on a payment, the
  // few francs over are an advance like any other (no server option absorbs them).
  const excessOf = (e: Party) => {
    const a = d(amountOf(e));
    if (!typedNumberOk(amountOf(e)) || !a.gt(0)) return null;
    const owed = owedHere(e);
    return a.gt(owed) ? { paid: a, owed, excess: a.minus(owed) } : null;
  };
  /** Francs rounded up by less than 100 FC: said plainly, with a one-click way back to the exact net. */
  const roundedUp = (e: Party) => {
    const x = isCdf ? excessOf(e) : null;
    return x && x.owed.gt(0) && x.excess.lt(100) ? x : null;
  };
  const fmtPay = (x: Decimal) => (isCdf ? cdf(x.toFixed(0)) : usd(x.toFixed(2)));
  const overText = (e: Party) => {
    const x = excessOf(e);
    if (!x) return null;
    if (roundedUp(e)) {
      return t(
        `${e.name} is owed ${fmtPay(x.owed)}: the extra ${fmtPay(x.excess)} will become an advance to repay`,
        `On doit ${fmtPay(x.owed)} à ${e.name}\u00a0: les ${fmtPay(x.excess)} en plus deviendront une avance à rembourser`,
      );
    }
    return x.owed.gt(0)
      ? t(
          `${e.name} gets ${fmtPay(x.paid)}; they are owed ${fmtPay(x.owed)}: the extra ${fmtPay(x.excess)} becomes an advance`,
          `${e.name} reçoit ${fmtPay(x.paid)}\u00a0; on lui doit ${fmtPay(x.owed)}\u00a0: l'excédent de ${fmtPay(x.excess)} devient une avance`,
        )
      : t(`${e.name} gets ${fmtPay(x.paid)}; nothing is owed to them: all of it becomes an advance`, `${e.name} reçoit ${fmtPay(x.paid)}\u00a0; on ne lui doit rien\u00a0: tout devient une avance`);
  };
  /**
   * A franc amount not in 100 FC notes, said neutrally with what each nearest note amount does: the exact net is
   * the right default, so nothing here nudges toward rounding up (which makes an advance).
   */
  const notesText = (e: Party) => {
    const a = d(amountOf(e));
    if (!isCdf || !typedNumberOk(amountOf(e)) || !a.gt(0) || !a.isInteger() || a.mod(100).isZero() || excessOf(e)) return null;
    const owed = owedHere(e);
    const effect = (x: Decimal) =>
      x.gt(owed)
        ? t(`makes an advance of ${fmtPay(x.minus(owed))}`, `crée une avance de ${fmtPay(x.minus(owed))}`)
        : x.lt(owed)
          ? t(`leaves ${fmtPay(owed.minus(x))} owed`, `laisse ${fmtPay(owed.minus(x))} dus`)
          : t("pays what is owed", "solde ce qui est dû");
    const up = a.dividedBy(100).ceil().times(100);
    const down = a.dividedBy(100).floor().times(100);
    const parts = [`${fmtPay(up)} ${effect(up)}`, ...(down.gt(0) ? [`${fmtPay(down)} ${effect(down)}`] : [])].join(", ");
    return t(`Not payable exactly in notes: ${parts}.`, `Pas payable exactement en billets\u00a0: ${parts}.`);
  };
  const [confirmOver, setConfirmOver] = useState(false);

  /** Amount in the paying account's currency, and its dollar value. */
  const lines = rows
    .map((e) => {
      const amount = d(amountOf(e));
      return { e, amount, usdAmount: isCdf ? (r.gt(0) ? amount.dividedBy(r) : d(0)) : amount };
    })
    .filter((l) => l.amount.gt(0));
  const total = lines.reduce((s, l) => s.plus(l.amount), d(0));
  // An amount with centimes or unread makes no total to pay (the button says what to correct).
  const linesInvalid = rows.some((e) => !typedNumberOk(amountOf(e)) || (isCdf && !!francDecimalsError(t, "CDF", amountOf(e))));
  const frMonth = monthText(month, "fr");
  // The drawer's balance before and after, as on the vouchers form; a payment it cannot cover is stopped here.
  const { can } = useAuth();
  const balances = useAccounts("/api/accounts/balances", { enabled: can("manager", "partner") }).data;
  const drawer = account ? balances?.find((a) => a.id === account.id) : undefined;
  const drawerNow = drawer ? d(isCdf ? drawer.nativeBalance : drawer.balance) : null;
  const drawerAfter = drawerNow ? drawerNow.minus(total) : null;
  const balanceText = (x: Decimal) => money(x.toFixed(isCdf ? 0 : 2), account!.currency);
  const drawerShort = drawerNow && drawerAfter?.lt(0)
    ? t(`Not enough money: balance ${balanceText(drawerNow)} → after ${balanceText(drawerAfter)}`, `Fonds insuffisants\u00a0: solde ${balanceText(drawerNow)} → après ${balanceText(drawerAfter)}`)
    : null;

  // No toast: the dialog stays open and says the voucher is saved, where a toast would cover its title on a phone.
  const pay = useApiMutation<Record<string, unknown>, { id: number; total: string }>("POST", "/api/vouchers/payment", {
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
        amount: l.amount.toFixed(isCdf ? 0 : 2),
        memo: `Salaire ${frMonth}`,
      })),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(`Pay salaries · ${monthLabel(month)}`, `Payer les salaires · ${monthLabel(month)}`)}</DialogTitle>
          {saved && !doneId && (
            <p className="flex items-center gap-1 text-sm font-medium text-green-800 dark:text-green-400" role="status" data-testid="payroll-saved">
              <Check className="h-4 w-4 shrink-0" /> {t("Payroll saved. Now pay what each employee is owed.", "Paie enregistrée. Payez maintenant ce qui est dû à chaque employé.")}
            </p>
          )}
          <DialogDescription>
            {t(
              "Prefilled with what each employee is owed; advances already given are deducted. Amounts are in the currency of the account paid from.",
              "Prérempli avec ce qui est dû à chaque employé\u00a0; les avances déjà données sont déduites. Montants dans la monnaie du compte qui paie.",
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
              <Field
                label={t("Pay from", "Payer depuis")}
                className="sm:col-span-1"
                hint={drawerNow && drawerAfter ? `${t("Balance", "Solde")} ${balanceText(drawerNow)}${total.gt(0) && !linesInvalid ? ` → ${t("after", "après")} ${balanceText(drawerAfter)}` : ""}` : undefined}
                error={drawerShort}
                required
              >
                <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
              </Field>
              <Field label={t("Date", "Date")}>
                <Input type="date" aria-label={t("Payment date", "Date du paiement")} value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
              {isCdf && (
                <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} required>
                  <RateInput day={day} value={rate} onChange={setRate} />
                </Field>
              )}
            </div>
            {rows.length === 0 ? (
              <EmptyState title={t("Nobody is owed anything", "Personne n'a rien à recevoir")} />
            ) : (
              <div className="divide-y rounded-md border">
                {rows.map((e) => {
                  return (
                    <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{e.name}</p>
                        <p className="text-xs">{owedText(e) ?? <EmployeeBalance balance={e.balance} />}</p>
                      </div>
                      <div className="w-full text-right sm:w-auto">
                        <div className="flex items-center justify-end gap-1">
                          <Input className="w-full text-right sm:w-28" inputMode="decimal" usd={!isCdf} thousands={isCdf} aria-label={t(`Amount paid to ${e.name}`, `Montant payé à ${e.name}`)} aria-invalid={(isCdf && !!francDecimalsError(t, "CDF", amountOf(e))) || undefined} value={amountOf(e)} onChange={(ev) => setAmounts((p) => ({ ...p, [keyOf(e)]: ev.target.value }))} />
                          <span className="w-6 text-left text-xs text-muted-foreground">{isCdf ? "FC" : "$"}</span>
                        </div>
                        {overText(e) && <p role="alert" className="ml-auto mt-1 max-w-[18rem] text-right text-xs font-medium text-amber-800 dark:text-amber-400">{overText(e)}</p>}
                        {roundedUp(e) && (
                          <button type="button" className="mt-1 rounded border px-2 py-1 text-xs font-medium hover:bg-muted" onClick={() => setAmounts((p) => ({ ...p, [keyOf(e)]: roundedUp(e)!.owed.toFixed(0) }))}>
                            {t(`Pay exactly ${fmtPay(roundedUp(e)!.owed)}`, `Payer exactement ${fmtPay(roundedUp(e)!.owed)}`)}
                          </button>
                        )}
                        {isCdf && francDecimalsError(t, "CDF", amountOf(e)) ? (
                          <p className="mt-1 text-xs text-destructive">{t("No centimes in francs", "Pas de centimes en FC")}</p>
                        ) : notesText(e) && (
                          <p className="ml-auto mt-1 max-w-[18rem] text-right text-xs text-muted-foreground" data-testid="pay-notes">{notesText(e)}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between rounded-md bg-muted/50 p-3 text-sm">
              <span>{t("Total", "Total")} · {count(t, lines.length, ["employee", "employees"], ["employé", "employés"])}</span>
              <Num className="font-semibold">
                {linesInvalid ? "—" : isCdf ? cdf(total.toFixed(0)) : usd(total.toFixed(2))}
              </Num>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{doneId ? t("Close", "Fermer") : t("Cancel", "Annuler")}</Button>
          {!doneId && (
            <SubmitButton
              onClick={() => (rows.some((e) => excessOf(e)) ? setConfirmOver(true) : submit())}
              blocked={
                !account
                  ? t("Choose the account to pay from", "Choisissez le compte de paiement")
                  : isCdf && !r.gt(0)
                    ? t("Enter the exchange rate", "Saisissez le taux de change")
                  : isCdf && rateFar
                    ? rateFar
                    : rows.some((e) => !typedNumberOk(amountOf(e)))
                      ? t("Correct the amounts that cannot be read", "Corrigez les montants illisibles")
                      : isCdf && rows.some((e) => francDecimalsError(t, "CDF", amountOf(e)))
                        ? t("Remove the centimes from the franc amounts", "Retirez les centimes des montants en FC")
                      : lines.length === 0
                        ? t("Enter at least one amount above zero", "Saisissez au moins un montant supérieur à zéro")
                        : drawerShort
              }
              pending={pay.isPending}
            >
              {t("Pay", "Payer")}{linesInvalid ? "" : ` ${isCdf ? cdf(total.toFixed(0)) : usd(total.toFixed(2))}`}
            </SubmitButton>
          )}
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmOver} onOpenChange={setConfirmOver}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Pay more than is owed?", "Payer plus que ce qui est dû\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {rows.filter((e) => excessOf(e)).map((e) => <p key={e.id}>{overText(e)}.</p>)}
                <p>{t("The advance is deducted from their next salary. Check for an extra zero before paying.", "L'avance sera déduite de son prochain salaire. Vérifiez qu'il n'y a pas un zéro de trop avant de payer.")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOver(false);
                submit();
              }}
            >
              {t(`Pay ${isCdf ? cdf(total.toFixed(0)) : usd(total.toFixed(2))}`, `Payer ${isCdf ? cdf(total.toFixed(0)) : usd(total.toFixed(2))}`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const rateFar = useRateTooFar(day, rate);
  const [memo, setMemo] = useState("");
  const [doneId, setDoneId] = useState<number | null>(null);
  const isCdf = account?.currency === "CDF";
  const r = d(rate);
  const a = d(amount);
  const outstanding = employees.filter((e) => d(e.balance).gt(0));
  const outstandingTotal = outstanding.reduce((s, e) => s.plus(e.balance), d(0));
  const deducted = employees.filter((e) => e.advanceDeducted && d(e.advanceDeducted.usd).gt(0));
  const monthLabel = useMonthLabel();
  // "Imprimer la pièce" is for the advance just given: any change to the form starts a new one and hides it.
  const edit = <V,>(set: (v: V) => void) => (v: V) => {
    setDoneId(null);
    set(v);
  };

  // "50 000,5" FC is a slip the server refuses (said under the field), and "1.200" $ is not read as 1,20 $ (the
  // field asks itself): either stops the button, and nothing is previewed.
  const amountError = francDecimalsError(t, account?.currency, amount) ?? (typedNumberOk(amount) ? null : unclearAmount(t, amount, account?.currency ?? "USD") ?? t("Correct the amount", "Corrigez le montant"));
  const typedOk = a.gt(0) && !amountError;
  const amountUsd = typedOk ? (isCdf ? (r.gt(0) ? a.dividedBy(r) : null) : a) : null;
  // The paying account's balance before and after, as on the voucher forms; an advance it cannot cover is stopped here.
  const { can } = useAuth();
  const balances = useAccounts("/api/accounts/balances", { enabled: can("manager", "partner") }).data;
  const drawer = account ? balances?.find((x) => x.id === account.id) : undefined;
  const drawerNow = drawer ? d(isCdf ? drawer.nativeBalance : drawer.balance) : null;
  const drawerAfter = drawerNow && typedOk ? drawerNow.minus(a) : null;
  const balanceText = (x: Decimal) => money(x.toFixed(isCdf ? 0 : 2), account!.currency);
  const drawerShort = drawerNow && drawerAfter?.lt(0)
    ? t(`Not enough money: balance ${balanceText(drawerNow)} → after ${balanceText(drawerAfter)}`, `Fonds insuffisants\u00a0: solde ${balanceText(drawerNow)} → après ${balanceText(drawerAfter)}`)
    : null;
  // More than a month's salary at the day's rate is asked about before paying, never refused: an advance that
  // large can be meant, "5 000 000" typed for 500 000 FC rarely is.
  const employee = employees.find((e) => e.id === partyId) ?? null;
  const salary = employee?.monthlySalary && d(employee.monthlySalary).gt(0) ? d(employee.monthlySalary) : null;
  const unusual = salary && amountUsd?.gt(salary) ? { ratio: amountUsd.dividedBy(salary) } : null;
  const amountText = isCdf ? `${cdf(a.toFixed(0))} (≈ ${usd(amountUsd?.toFixed(2) ?? "0")})` : usd(a.toFixed(2));
  const unusualText = unusual && employee
    ? t(
        `An advance of ${amountText} to ${employee.name}, whose salary is ${usd(salary!.toFixed(2))} a month.${unusual.ratio.gte(5) ? " An extra zero?" : ""}`,
        `Une avance de ${amountText} à ${employee.name}, dont le salaire est de ${usd(salary!.toFixed(2))} par mois.${unusual.ratio.gte(5) ? " Un zéro de trop\u00a0?" : ""}`,
      )
    : null;
  const [confirmUnusual, setConfirmUnusual] = useState(false);

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
    // Stored in French like the server's own memos; systemText says it in English.
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
            <Field label={t("Employee", "Employé")} required>
              <PartySelect types={["employee"]} value={partyId} onChange={edit((id: number | null) => setPartyId(id))} allowCreate={false} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={t("Paid from", "Payé depuis")}
                hint={drawerNow ? `${t("Balance", "Solde")} ${balanceText(drawerNow)}${drawerAfter ? ` → ${t("after", "après")} ${balanceText(drawerAfter)}` : ""}` : undefined}
                error={drawerShort}
                required
              >
                <MoneyAccountSelect value={account?.id ?? null} onChange={(_, acc) => { setDoneId(null); setAccount(acc); }} />
              </Field>
              <Field label={t("Date", "Date")}>
                <Input type="date" aria-label={t("Payment date", "Date du paiement")} value={day} onChange={(e) => edit(setDay)(e.target.value)} />
              </Field>
              <Field
                label={`${t("Amount", "Montant")}${account ? ` (${curLabel(account.currency)})` : ""}`}
                hint={isCdf && amountUsd ? `≈ ${usd(amountUsd.toFixed(2))}` : undefined}
                error={francDecimalsError(t, account?.currency, amount)}
                required
              >
                <Input inputMode="decimal" usd={!isCdf} thousands={isCdf} aria-invalid={!!amountError || undefined} value={amount} onChange={(e) => edit(setAmount)(e.target.value)} placeholder="0" />
              </Field>
              {isCdf && (
                <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} required>
                  <RateInput day={day} value={rate} onChange={edit(setRate)} />
                </Field>
              )}
            </div>
            {unusualText && <p role="alert" className="text-sm font-medium text-amber-800 dark:text-amber-400">{unusualText}</p>}
            <Field label={t("Memo", "Libellé")}>
              <Input value={memo} onChange={(e) => edit(setMemo)(e.target.value)} placeholder={t("Salary advance", "Avance sur salaire")} />
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {doneId && (
                <Button variant="outline" asChild>
                  <Link href={`/vouchers/${doneId}`}><Printer className="mr-1 h-4 w-4" /> {t("Print voucher", "Imprimer la pièce")}</Link>
                </Button>
              )}
              <SubmitButton
                onClick={() => (unusualText ? setConfirmUnusual(true) : submit())}
                blocked={
                  !partyId
                    ? t("Choose an employee", "Choisissez un employé")
                    : !account
                      ? t("Choose the account to pay from", "Choisissez le compte de paiement")
                      : amountError
                        ? amountError
                        : !a.gt(0)
                          ? t("Enter an amount above zero", "Saisissez un montant supérieur à zéro")
                          : isCdf && !r.gt(0)
                            ? t("Enter the exchange rate", "Saisissez le taux de change")
                            : (isCdf && rateFar) || drawerShort
                }
                pending={give.isPending}
              >
                {t("Give the advance", "Donner l'avance")}
              </SubmitButton>
            </div>
          </CardContent>
          <AlertDialog open={confirmUnusual} onOpenChange={setConfirmUnusual}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("An unusual amount?", "Un montant inhabituel\u00a0?")}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2">
                    <p>{unusualText}</p>
                    <p>{t("The advance is deducted from their next salary. Check for an extra zero before paying.", "L'avance sera déduite de son prochain salaire. Vérifiez qu'il n'y a pas un zéro de trop avant de payer.")}</p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmUnusual(false);
                    submit();
                  }}
                >
                  {t(`Give ${isCdf ? cdf(a.toFixed(0)) : usd(a.toFixed(2))}`, `Donner ${isCdf ? cdf(a.toFixed(0)) : usd(a.toFixed(2))}`)}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
            <div className="p-4">
              <EmptyState title={t("No advance outstanding", "Aucune avance en cours")}>
                {deducted.length > 0 && t("Advances given since the payroll was saved are already deducted (below).", "Les avances données depuis la paie enregistrée sont déjà déduites (ci-dessous).")}
              </EmptyState>
            </div>
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
                    <TableCell className="text-right"><Num className="font-medium text-amber-800 dark:text-amber-400">{usd(e.balance)}</Num></TableCell>
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
          {/* Given after the month's payroll was saved: netted against the salary owed, not lost. */}
          {deducted.length > 0 && (
            <ul className="space-y-1 border-t p-4 text-sm text-muted-foreground" data-testid="advance-deducted">
              {deducted.map((e) => (
                <li key={e.id}>
                  <Link href={`/contacts/${e.id}`} className="font-medium text-foreground hover:underline">{e.name}</Link>
                  {t(
                    `: ${usd(e.advanceDeducted!.usd)} of advance already deducted from the ${monthLabel(e.advanceDeducted!.month)} salary`,
                    `\u00a0: ${usd(e.advanceDeducted!.usd)} d'avance déjà déduits du salaire ${deMonth(e.advanceDeducted!.month)}`,
                  )}
                </li>
              ))}
            </ul>
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
  if (sorted.length === 0) return <EmptyState title={t("No payroll booked yet", "Aucune paie enregistrée pour l'instant")} />;
  const grand = sorted.filter((r) => r.status !== "cancelled").reduce((s, r) => s.plus(r.totalUsd), d(0));
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
                    <TableCell className="font-medium">
                      {capitalize(monthLabel(r.month))}
                      {r.status === "cancelled" && <Badge variant="destructive" className="ml-2">{t("Cancelled", "Annulée")}</Badge>}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">{fmtDate(r.date)}</TableCell>
                    <TableCell className="text-right"><Num>{r.lines.length}</Num></TableCell>
                    <TableCell className="text-right"><Num className={cn("font-medium", r.status === "cancelled" && "text-muted-foreground line-through")}>{usd(r.totalUsd)}</Num></TableCell>
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
                        <RunLinesTable run={r} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>{t("Total", "Total")} · {count(t, sorted.filter((r) => r.status !== "cancelled").length, ["month", "months"], ["mois", "mois"])}</TableCell>
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
