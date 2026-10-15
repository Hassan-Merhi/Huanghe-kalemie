import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowLeft, ChevronRight, Printer, Search, Settings2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { useI18n, useT, type Lang, count } from "@/lib/i18n";
import { downloadCsv } from "@/lib/sheets";
import { cdf, compactUsd, d, date as fmtDate, num, todayLocal, usd } from "@/lib/format";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CsvButton, RangePicker, accountTypeLabel, useRange } from "@/pages/Reports";
import { WIDE_PRINT_CSS, journalTypeLabel } from "@/pages/ContactDetail";

type T = (en: string, fr: string) => string;
type AccountType = Account["type"];

const TYPE_ORDER: AccountType[] = ["asset", "liability", "equity", "income", "cost_of_sales", "expense"];

interface BalanceRow extends Account {
  debit: string;
  credit: string;
  balance: string;
  nativeBalance?: string;
}

interface LedgerRow { journalId: number; number: string; date: string; type: string; memo: string | null; lineMemo: string | null; debit: string; credit: string; nativeAmount: string | null; rate: string | null; partyName: string | null; balance: string; nativeBalance: string | null }
interface LedgerData { account: Account; from?: string; to?: string; openingBalance: string; openingNative: string | null; rows: LedgerRow[]; closingBalance: string; closingNative: string | null }
interface MonthlyData { account: Account; year: number; opening: string; months: { month: string; debit: string; credit: string; count: number; closing: string }[]; totalDebit: string; totalCredit: string; closing: string }

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function lastDay(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

function monthName(month: string, lang: Lang, style: "long" | "short" = "long") {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-US", { month: style, timeZone: "UTC" });
}

const CREDIT_NORMAL = new Set(["liability", "equity", "income"]);

/**
 * A debit-positive balance shown the way a shopkeeper reads it: from the account's normal side
 * (what we have, what we owe, what we earned or spent). A minus sign means the balance is the
 * other way round, such as a supplier we paid too much.
 */
function Side({ value, t, type, currency = "USD", className }: { value: unknown; t: T; type?: string; currency?: string; className?: string }) {
  const raw = num(value);
  if (Math.abs(raw) < 0.005) return <Num className={cn("text-muted-foreground", className)}>—</Num>;
  if (!type) {
    const amount = currency === "CDF" ? cdf(Math.abs(raw)) : usd(Math.abs(raw));
    return (
      <Num className={className}>
        {amount} <span className="text-xs font-medium text-muted-foreground">{raw > 0 ? t("debit", "débit") : t("credit", "crédit")}</span>
      </Num>
    );
  }
  const n = CREDIT_NORMAL.has(type) ? -raw : raw;
  const amount = currency === "CDF" ? cdf(n) : usd(n);
  return (
    <Num className={cn(n < 0 && "text-amber-800 dark:text-amber-400", className)}>
      <span title={n < 0 ? t("The balance is the other way round from usual for this account", "Le solde est à l'inverse de l'habitude pour ce compte") : undefined}>{amount}</span>
    </Num>
  );
}

export default function Accounts() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const accountId = Number(params.get("account")) || null;
  if (accountId) return <AccountView id={accountId} onBack={() => navigate("/accounts")} />;
  return <Chart onOpen={(id) => navigate(`/accounts?account=${id}`)} />;
}

// ---------------------------------------------------------------- Chart of accounts

function Chart({ onOpen }: { onOpen: (id: number) => void }) {
  const t = useT();
  const { can } = useAuth();
  const [, navigate] = useLocation();
  const [asOf, setAsOf] = useState(todayLocal());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<AccountType | "all">("all");
  const [hideZero, setHideZero] = useState(false);
  const [voucherQ, setVoucherQ] = useState("");
  const q = useQuery<BalanceRow[]>({ queryKey: ["/api/accounts/balances", { asOf: validDate(asOf) ? asOf : undefined }] });

  const groups = useMemo(() => {
    const s = query.trim().toLowerCase();
    const list = (q.data ?? []).filter((a) => {
      if (typeFilter !== "all" && a.type !== typeFilter) return false;
      if (hideZero && Math.abs(num(a.balance)) < 0.005 && Math.abs(num(a.nativeBalance)) < 0.5) return false;
      if (s && !`${a.code} ${a.name}`.toLowerCase().includes(s)) return false;
      return true;
    });
    return TYPE_ORDER.map((type) => {
      const accounts = list.filter((a) => a.type === type).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
      return { type, accounts, total: accounts.reduce((sum, a) => sum.plus(a.balance), d(0)) };
    }).filter((g) => g.accounts.length);
  }, [q.data, query, typeFilter, hideZero]);

  function findVoucher() {
    const v = voucherQ.trim();
    if (v) navigate(`/daybook?q=${encodeURIComponent(v)}`);
  }

  return (
    <div>
      <PageHeader
        title={t("Accounts", "Comptes")}
        description={t("Chart of accounts with balances. Open an account for its statement.", "Plan comptable avec les soldes. Ouvrez un compte pour voir son relevé.")}
        actions={
          can() ? (
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings"><Settings2 className="mr-1 h-4 w-4" /> {t("Manage chart of accounts", "Gérer le plan comptable")}</Link>
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("As of", "Au")}>
              <Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </Field>
            <Field label={t("Account", "Compte")} className="w-full sm:w-64">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Code or name…", "Code ou nom…")} />
              </div>
            </Field>
            <div className="flex items-center gap-2 pb-2">
              <Switch id="hide-zero" checked={hideZero} onCheckedChange={setHideZero} />
              <Label htmlFor="hide-zero" className="cursor-pointer">{t("Hide zero balances", "Masquer les soldes nuls")}</Label>
            </div>
            <form className="flex w-full items-end gap-1 sm:ml-auto sm:w-auto" onSubmit={(e) => { e.preventDefault(); findVoucher(); }}>
              <Field label={t("Find a voucher", "Chercher une pièce")} className="flex-1 sm:w-56">
                <Input value={voucherQ} onChange={(e) => setVoucherQ(e.target.value)} placeholder={t("Number, memo, contact…", "Numéro, libellé, tiers…")} />
              </Field>
              <Button type="submit" variant="outline" size="icon" aria-label={t("Search the day book", "Chercher dans le journal")} disabled={!voucherQ.trim()}>
                <Search className="h-4 w-4" />
              </Button>
            </form>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant={typeFilter === "all" ? "default" : "outline"} className="h-7 rounded-full" onClick={() => setTypeFilter("all")}>
              {t("All", "Tous")}
            </Button>
            {TYPE_ORDER.map((type) => (
              <Button key={type} size="sm" variant={typeFilter === type ? "default" : "outline"} className="h-7 rounded-full" onClick={() => setTypeFilter(type)}>
                {accountTypeLabel(type, t, true)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {q.data && !groups.length && <EmptyState title={t("No accounts match", "Aucun compte ne correspond")} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.type}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">{accountTypeLabel(g.type, t, true)}</CardTitle>
              <span className="text-sm font-semibold"><Side value={g.total} t={t} type={g.type} /></span>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y border-t">
                {g.accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => a.id > 0 && onOpen(a.id)}
                    className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50", !a.active && "opacity-60")}
                  >
                    <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{a.code}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm">{a.name}</span>
                      <span className="flex flex-wrap gap-1">
                        {a.isMoney && <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">{a.currency === "CDF" ? "FC" : a.currency}</Badge>}
                        {!a.active && <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">{t("Inactive", "Inactif")}</Badge>}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm">
                      <Side value={a.balance} t={t} type={a.type} />
                      {a.currency === "CDF" && a.isMoney && a.nativeBalance != null && (
                        <span className="block text-xs text-muted-foreground"><Num>{cdf(a.nativeBalance)}</Num></span>
                      )}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between border-t bg-muted/40 px-4 py-2 text-sm font-medium">
                <span>{t("Total", "Total")} · {count(t, g.accounts.length, ["account", "accounts"], ["compte", "comptes"])}</span>
                <Side value={g.total} t={t} type={g.type} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {q.data && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t(
            "Balances in USD, each read the usual way: what the shop has (assets), what it owes (debts), what belongs to the partners, what it earned and what it spent. A minus sign means the balance is the other way round.",
            "Soldes en dollars, chacun lu dans son sens habituel\u00a0: ce que la boutique a (actifs), ce qu'elle doit (dettes), ce qui revient aux associés, ce qu'elle a gagné et ce qu'elle a dépensé. Un signe moins veut dire que le solde est à l'inverse.",
          )}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- One account

function AccountView({ id, onBack }: { id: number; onBack: () => void }) {
  const t = useT();
  const range = useRange();
  const [tab, setTab] = useState<"statement" | "monthly">("statement");
  const [year, setYear] = useState(Number(todayLocal().slice(0, 4)));
  const balQ = useQuery<BalanceRow[]>({ queryKey: ["/api/accounts/balances", { asOf: undefined }] });
  const acc = balQ.data?.find((a) => a.id === id);

  function openMonth(month: string) {
    range.setFrom(`${month}-01`);
    range.setTo(lastDay(month));
    setTab("statement");
  }

  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t("Chart of accounts", "Plan comptable")}
      </button>
      <PageHeader
        title={acc ? `${acc.code} · ${acc.name}` : t("Account", "Compte")}
        description={acc ? [accountTypeLabel(acc.type, t), acc.isMoney ? (acc.currency === "CDF" ? "FC" : acc.currency) : null, !acc.active ? t("Inactive", "Inactif") : null].filter(Boolean).join(" · ") : undefined}
        actions={
          acc && (
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("Balance today", "Solde aujourd'hui")}</p>
              <p className="text-xl font-semibold"><Side value={acc.balance} t={t} type={acc?.type} /></p>
              {acc.isMoney && acc.currency === "CDF" && acc.nativeBalance != null && <p className="text-sm text-muted-foreground"><Num>{cdf(acc.nativeBalance)}</Num></p>}
            </div>
          )
        }
      />
      <ErrorText error={balQ.error} />
      {balQ.data && !acc && <EmptyState title={t("Account not found", "Compte introuvable")} />}
      <Tabs value={tab} onValueChange={(v) => setTab(v as "statement" | "monthly")}>
        <TabsList className="mb-3">
          <TabsTrigger value="statement">{t("Statement", "Relevé")}</TabsTrigger>
          <TabsTrigger value="monthly">{t("By month", "Par mois")}</TabsTrigger>
        </TabsList>
        <TabsContent value="statement">
          <Statement id={id} range={range} type={acc?.type} />
        </TabsContent>
        <TabsContent value="monthly">
          <Monthly id={id} type={acc?.type} year={year} setYear={setYear} onMonth={openMonth} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Statement({ id, range, type }: { id: number; range: ReturnType<typeof useRange>; type?: string }) {
  const t = useT();
  const ok = validDate(range.from) && validDate(range.to);
  const q = useQuery<LedgerData>({ queryKey: [`/api/accounts/${id}/ledger`, { from: range.from, to: range.to }], enabled: ok });
  const L = q.data;
  const cdfAcc = L?.account.currency === "CDF" && L.account.isMoney;
  const totals = useMemo(
    () => ({
      debit: (L?.rows ?? []).reduce((s, r) => s.plus(r.debit), d(0)),
      credit: (L?.rows ?? []).reduce((s, r) => s.plus(r.credit), d(0)),
    }),
    [L],
  );

  function exportCsv() {
    if (!L) return;
    const head = [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Libellé"), t("Contact", "Tiers"), t("Debit ($)", "Débit ($)"), t("Credit ($)", "Crédit ($)"), t("Balance ($)", "Solde ($)"), t("Side", "Sens")];
    if (cdfAcc) head.push("CDF", t("CDF balance", "Solde en FC"));
    const side = (v: string) => (num(v) > 0 ? t("Dr", "D") : num(v) < 0 ? t("Cr", "C") : "");
    downloadCsv(`releve_${L.account.code}_${range.from}_${range.to}.csv`, [
      [`${L.account.code} · ${L.account.name}`, `${range.from} → ${range.to}`],
      head,
      [range.from, "", "", t("Opening balance", "Solde d'ouverture"), "", "", "", L.openingBalance, side(L.openingBalance), ...(cdfAcc ? ["", L.openingNative ?? ""] : [])],
      ...L.rows.map((r) => [r.date, r.number, journalTypeLabel(r.type, t), r.lineMemo || r.memo || "", r.partyName ?? "", r.debit, r.credit, r.balance, side(r.balance), ...(cdfAcc ? [r.nativeAmount ?? "", r.nativeBalance ?? ""] : [])]),
      ["", "", "", t("Totals", "Totaux"), "", totals.debit.toFixed(2), totals.credit.toFixed(2), "", ""],
      [range.to, "", "", t("Closing balance", "Solde de clôture"), "", "", "", L.closingBalance, side(L.closingBalance), ...(cdfAcc ? ["", L.closingNative ?? ""] : [])],
    ]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangePicker range={range} />
        <div className="flex gap-2">
          <CsvButton onClick={exportCsv} disabled={!L} />
          <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!L}>
            <Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}
          </Button>
        </div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {L && (
        <Card className="print-area print-wide">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("Statement", "Relevé")} · {L.account.code} {L.account.name}</CardTitle>
            <p className="text-sm text-muted-foreground">{fmtDate(range.from)} → {fmtDate(range.to)} · {count(t, L.rows.length, ["line", "lines"], ["ligne", "lignes"])}</p>
          </CardHeader>
          <CardContent className="p-0">
            {/* Desktop / print table */}
            <div className={cn("overflow-x-auto", "hidden md:block print:block")}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date", "Date")}</TableHead>
                    <TableHead>{t("No.", "N°")}</TableHead>
                    <TableHead>{t("Details", "Libellé")}</TableHead>
                    <TableHead className="text-right">{t("Debit", "Débit")}</TableHead>
                    <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                    <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                    {cdfAcc && <TableHead className="text-right">CDF</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="bg-muted/40">
                    <TableCell className="whitespace-nowrap">{fmtDate(range.from)}</TableCell>
                    <TableCell colSpan={4} className="font-medium">{t("Opening balance", "Solde d'ouverture")}</TableCell>
                    <TableCell className="text-right font-medium"><Side value={L.openingBalance} t={t} type={type} /></TableCell>
                    {cdfAcc && <TableCell className="text-right"><Num>{cdf(L.openingNative)}</Num></TableCell>}
                  </TableRow>
                  {L.rows.map((r, i) => (
                    <TableRow key={`${r.journalId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        <Link href={`/vouchers/${r.journalId}`} className="text-primary hover:underline">{r.number}</Link>
                      </TableCell>
                      <TableCell className="min-w-[200px]">
                        {r.lineMemo || r.memo || "—"}
                        <span className="block text-xs text-muted-foreground">{[journalTypeLabel(r.type, t), r.partyName].filter(Boolean).join(" · ")}</span>
                      </TableCell>
                      <TableCell className="text-right"><Num>{d(r.debit).isZero() ? "" : usd(r.debit)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{d(r.credit).isZero() ? "" : usd(r.credit)}</Num></TableCell>
                      <TableCell className="text-right"><Side value={r.balance} t={t} type={type} /></TableCell>
                      {cdfAcc && (
                        <TableCell className="text-right text-xs">
                          <Num>{r.nativeAmount != null ? cdf(r.nativeAmount) : ""}</Num>
                          <span className="block text-muted-foreground"><Num>{r.nativeBalance != null ? cdf(r.nativeBalance) : ""}</Num></span>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={3}>{t("Totals for the period", "Totaux de la période")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(totals.debit)}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(totals.credit)}</Num></TableCell>
                    <TableCell />
                    {cdfAcc && <TableCell />}
                  </TableRow>
                  <TableRow>
                    <TableCell className="whitespace-nowrap">{fmtDate(range.to)}</TableCell>
                    <TableCell colSpan={4}>{t("Closing balance", "Solde de clôture")}</TableCell>
                    <TableCell className="text-right"><Side value={L.closingBalance} t={t} type={type} /></TableCell>
                    {cdfAcc && <TableCell className="text-right"><Num>{cdf(L.closingNative)}</Num></TableCell>}
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            {/* Mobile: two-line rows */}
            <div className="divide-y border-t md:hidden print:hidden">
              <div className="flex justify-between bg-muted/40 px-4 py-2 text-sm font-medium">
                <span>{t("Opening balance", "Solde d'ouverture")}</span>
                <span className="text-right"><Side value={L.openingBalance} t={t} type={type} />{cdfAcc && <span className="block text-xs text-muted-foreground">{cdf(L.openingNative)}</span>}</span>
              </div>
              {L.rows.map((r, i) => (
                <div key={`${r.journalId}-${i}`} className="flex items-start justify-between gap-2 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="break-words">{r.lineMemo || r.memo || journalTypeLabel(r.type, t)}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {fmtDate(r.date)} · <Link href={`/vouchers/${r.journalId}`} className="font-mono text-primary">{r.number}</Link>
                      {r.partyName ? ` · ${r.partyName}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {!d(r.debit).isZero() && <Num className="block text-sky-700 dark:text-sky-400">+{usd(r.debit)}</Num>}
                    {!d(r.credit).isZero() && <Num className="block text-orange-700 dark:text-orange-400">−{usd(r.credit)}</Num>}
                    <span className="block text-xs text-muted-foreground"><Side value={r.balance} t={t} type={type} /></span>
                    {cdfAcc && r.nativeBalance != null && <span className="block text-xs text-muted-foreground">{cdf(r.nativeBalance)}</span>}
                  </div>
                </div>
              ))}
              <div className="space-y-1 bg-muted/40 px-4 py-2 text-sm font-medium">
                <div className="flex justify-between"><span>{t("Debit", "Débit")}</span><Num>{usd(totals.debit)}</Num></div>
                <div className="flex justify-between"><span>{t("Credit", "Crédit")}</span><Num>{usd(totals.credit)}</Num></div>
                <div className="flex justify-between">
                  <span>{t("Closing balance", "Solde de clôture")}</span>
                  <span className="text-right"><Side value={L.closingBalance} t={t} type={type} />{cdfAcc && <span className="block text-xs text-muted-foreground">{cdf(L.closingNative)}</span>}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Monthly({ id, year, setYear, onMonth, type }: { id: number; year: number; setYear: (y: number) => void; onMonth: (month: string) => void; type?: string }) {
  const t = useT();
  const { lang } = useI18n();
  const thisYear = Number(todayLocal().slice(0, 4));
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);
  const q = useQuery<MonthlyData>({ queryKey: [`/api/accounts/${id}/monthly`, { year }] });
  const M = q.data;
  const chart = (M?.months ?? []).map((m) => ({ name: monthName(m.month, lang, "short"), debit: num(m.debit), credit: num(m.credit) }));

  function exportCsv() {
    if (!M) return;
    downloadCsv(`mensuel_${M.account.code}_${year}.csv`, [
      [`${M.account.code} · ${M.account.name}`, String(year)],
      [t("Month", "Mois"), t("Debit ($)", "Débit ($)"), t("Credit ($)", "Crédit ($)"), t("Lines", "Lignes"), t("Closing ($)", "Solde de clôture ($)")],
      [t("Opening balance", "Solde d'ouverture"), "", "", "", M.opening],
      ...M.months.map((m) => [m.month, m.debit, m.credit, m.count, m.closing]),
      [t("Total", "Total"), M.totalDebit, M.totalCredit, M.months.reduce((s, m) => s + m.count, 0), M.closing],
    ]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t("Year", "Année")}>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <CsvButton onClick={exportCsv} disabled={!M} />
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {M && (
        <>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Month", "Mois")}</TableHead>
                      <TableHead className="text-right">{t("Debit", "Débit")}</TableHead>
                      <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">{t("Lines", "Lignes")}</TableHead>
                      <TableHead className="text-right">{t("Closing", "Solde")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow className="bg-muted/40">
                      <TableCell colSpan={3} className="font-medium">{t("Opening balance", "Solde d'ouverture")} · 01/01/{year}</TableCell>
                      <TableCell className="hidden sm:table-cell" />
                      <TableCell className="text-right font-medium"><Side value={M.opening} t={t} type={type} /></TableCell>
                    </TableRow>
                    {M.months.map((m) => (
                      <TableRow key={m.month} className={cn("cursor-pointer", !m.count && "text-muted-foreground")} onClick={() => onMonth(m.month)}>
                        <TableCell className="capitalize">
                          <span className="inline-flex items-center gap-1">{monthName(m.month, lang)} <ChevronRight className="h-3 w-3 text-muted-foreground" /></span>
                        </TableCell>
                        <TableCell className="text-right"><Num>{d(m.debit).isZero() ? "" : usd(m.debit)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{d(m.credit).isZero() ? "" : usd(m.credit)}</Num></TableCell>
                        <TableCell className="hidden text-right sm:table-cell"><Num>{m.count || ""}</Num></TableCell>
                        <TableCell className="text-right"><Side value={m.closing} t={t} type={type} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>{t("Total", "Total")} {year}</TableCell>
                      <TableCell className="text-right"><Num>{usd(M.totalDebit)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(M.totalCredit)}</Num></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Num>{M.months.reduce((s, m) => s + m.count, 0)}</Num></TableCell>
                      <TableCell className="text-right"><Side value={M.closing} t={t} type={type} /></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">{t("Click a month to see its statement.", "Cliquez sur un mois pour voir son relevé.")}</p>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t("Debit and credit by month", "Débit et crédit par mois")}</CardTitle>
            </CardHeader>
            <CardContent className="h-64 pl-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => compactUsd(v)} />
                  <Tooltip
                    formatter={(v: number) => usd(v)}
                    cursor={{ fill: "hsl(var(--muted))" }}
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, color: "hsl(var(--card-foreground))" }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="debit" name={t("Debit", "Débit")} fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="credit" name={t("Credit", "Crédit")} fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
