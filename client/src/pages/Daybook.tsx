import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Eye, EyeOff, FileText, Layers, LayoutList, Plus, Printer, RotateCcw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, KeepNumbers, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { downloadCsv } from "@/lib/sheets";
import { advanceText, cdf, curLabel, d, date as fmtDate, frenchPunctuation, money, qty, todayLocal, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RangePicker, useRange } from "@/pages/Reports";
import { journalTypeLabel } from "@/pages/ContactDetail";
import { useSystemText } from "@/lib/systemText";

type T = (en: string, fr: string) => string;

interface DaybookLine {
  id: number;
  accountId: number;
  accountName: string;
  accountCode: string;
  isMoney: boolean;
  partyName: string | null;
  debit: string;
  credit: string;
  currency?: string | null;
  nativeAmount: string | null;
  rate: string | null;
  memo: string | null;
}

interface DaybookRow {
  id: number;
  number: string;
  date: string;
  type: string;
  memo: string | null;
  sourceType: string | null;
  saleId?: number | null;
  saleFlags?: { zeroPrice: boolean; belowCost: boolean };
  sourceId: number | null;
  reversedByJournalId: number | null;
  reversesJournalId: number | null;
  createdByName: string | null;
  /** A pending voucher validated by someone else: createdByName prepared it, this person validated it. */
  validatedByName?: string | null;
  /** The document's own amount: a sale's total, a transfer's amount sent. */
  amount: string;
  /** Sales: money taken in and change handed back (both in dollars). */
  received?: string;
  changeGiven?: string;
  /** Transfers: the boxes the money left and reached. */
  transfer?: { from: string; to: string };
  /** Exchange difference beside the document (francs or yuan at their average cost): + a loss, − a gain. */
  fxDiff?: string;
  /** Franc rounding of the till or a refund ("Arrondi FC"), + a loss. */
  fxRounding?: string;
  /** Stock counts: value of the stock found and of the stock lost (the amount is the net). */
  stockAdded?: string;
  stockRemoved?: string;
  /** A payment that also applied an advance the contact held (not in the amount: no money moved for it). */
  advance?: { usd: string; cny?: string; cdf?: string };
  lines: DaybookLine[];
}

interface DaybookData {
  from: string;
  to: string;
  moneyIn: string;
  moneyOut: string;
  truncated: boolean;
  rows: DaybookRow[];
}

const JOURNAL_TYPES = [
  "opening", "manual", "sale", "sale_void", "sale_return", "customer_receipt", "supplier_payment",
  "container_expense", "container_finalize", "container_reversal", "expense", "transfer",
  "partner_contribution", "partner_withdrawal", "stock_adjustment", "payment", "receipt",
  "payroll", "revaluation", "period_close", "reversal",
];

/** Types the server lets the owner reverse from here; the others are undone from their own screens. */
const REVERSIBLE = new Set([
  "manual", "opening", "transfer", "customer_receipt", "supplier_payment",
  "partner_contribution", "partner_withdrawal", "payment", "receipt",
]);

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function shiftDay(day: string, by: number) {
  const [y, m, dd] = day.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd + by));
  return x.toISOString().slice(0, 10);
}

/** Where "Open" goes for a journal: its source screen when there is one, else the voucher view. */
function sourceHref(r: DaybookRow): string {
  if (r.saleId) return `/sales/${r.saleId}`;
  if (r.sourceType === "container" && r.sourceId) return `/containers/${r.sourceId}`;
  return `/vouchers/${r.id}`;
}

function typeTone(type: string): string {
  if (type.startsWith("sale") || type === "customer_receipt" || type === "receipt") return "border-emerald-500/40 text-emerald-800 dark:text-emerald-400";
  if (type === "expense" || type === "payment" || type === "supplier_payment" || type === "payroll") return "border-orange-500/40 text-orange-800 dark:text-orange-400";
  if (type.startsWith("container")) return "border-sky-500/40 text-sky-800 dark:text-sky-400";
  if (type === "reversal" || type === "sale_void") return "border-destructive/40 text-destructive";
  return "";
}

function TypeBadge({ type, t }: { type: string; t: T }) {
  return <Badge variant="outline" className={cn("whitespace-nowrap font-normal", typeTone(type))}>{journalTypeLabel(type, t)}</Badge>;
}

function StatusBadges({ r, t }: { r: DaybookRow; t: T }) {
  return (
    <>
      {r.reversedByJournalId && <Badge variant="destructive" className="whitespace-nowrap">{t("Reversed", "Annulée")}</Badge>}
      {r.reversesJournalId && <Badge variant="secondary" className="whitespace-nowrap">{t("Reversal entry", "Contre-passation")}</Badge>}
      {r.saleFlags?.zeroPrice && <Badge variant="destructive" className="whitespace-nowrap">{t("Price 0", "Prix nul")}</Badge>}
      {r.saleFlags?.belowCost && <Badge variant="outline" className="whitespace-nowrap border-amber-600 text-amber-800 dark:border-amber-400 dark:text-amber-300">{t("Below cost", "Vente à perte")}</Badge>}
    </>
  );
}

/** Contacts named on the lines, for the memo column. */
function contactsOf(r: DaybookRow): string {
  if (r.transfer?.from && r.transfer.to) return `${r.transfer.from} → ${r.transfer.to}`;
  return Array.from(new Set(r.lines.map((l) => l.partyName).filter(Boolean))).join(", ");
}

/**
 * The second line under an amount: "reçu 35,61 $ · rendu 23,11 $" under a sale paid with more than its total,
 * "trouvé 32,90 $ · perdu 57,26 $" under a stock count, and any exchange difference kept apart from the document.
 */
function cashDetail(r: DaybookRow, t: T): string | null {
  const parts: string[] = [];
  if (r.received && d(r.changeGiven).gt(0)) parts.push(`${t("received", "reçu")} ${usd(r.received)} · ${t("change", "rendu")} ${usd(r.changeGiven)}`);
  if (r.stockAdded && r.stockRemoved && d(r.stockAdded).gt(0) && d(r.stockRemoved).gt(0)) {
    parts.push(`${t("found", "trouvé")} ${usd(r.stockAdded)} · ${t("lost", "perdu")} ${usd(r.stockRemoved)}`);
  }
  if (r.advance) parts.push(`${t("advance applied", "avance imputée")} ${advanceText(r.advance)}`);
  if (r.fxDiff && !d(r.fxDiff).isZero()) {
    const fx = d(r.fxDiff);
    parts.push(`${t("exchange", "écart de change")} ${usd(fx.abs().toFixed(2))} (${fx.gt(0) ? t("loss", "perte") : t("gain", "gain")})`);
  }
  if (r.fxRounding && !d(r.fxRounding).isZero()) {
    const fx = d(r.fxRounding);
    parts.push(`${t("FC rounding", "Arrondi FC")} ${usd(fx.abs().toFixed(2))} (${fx.gt(0) ? t("loss", "perte") : t("gain", "gain")})`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export default function Daybook() {
  const sys = useSystemText();
  const t = useT();
  const { can } = useAuth();
  const isOwner = can();
  const search = useSearch();

  // Initial state from the URL (?q=…&date=…), e.g. from Accounts → "Find a voucher".
  const initial = useMemo(() => {
    const p = new URLSearchParams(search);
    const day = p.get("date");
    return { q: p.get("q") ?? "", date: day && validDate(day) ? day : todayLocal() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [mode, setMode] = useState<"day" | "range">(initial.q && !new URLSearchParams(search).get("date") ? "range" : "day");
  const [day, setDay] = useState(initial.date);
  const range = useRange();
  useEffect(() => {
    // A search from another page without a date looks back over the whole year.
    if (initial.q && mode === "range") range.setFrom(`${todayLocal().slice(0, 4)}-01-01`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<"transactions" | "activity">("transactions");
  const [showReversed, setShowReversed] = useState(true);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [qInput, setQInput] = useState(initial.q);
  const [q, setQ] = useState(initial.q);
  useEffect(() => {
    const h = setTimeout(() => setQ(qInput.trim()), 350);
    return () => clearTimeout(h);
  }, [qInput]);
  const [view, setView] = useState<"detailed" | "condensed">("detailed");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [reversing, setReversing] = useState<DaybookRow | null>(null);

  const from = mode === "day" ? day : range.from;
  const to = mode === "day" ? day : range.to;
  const ok = validDate(from) && validDate(to);
  const dq = useQuery<DaybookData>({
    queryKey: ["/api/daybook", { from, to, type: type === "all" ? undefined : type, q: q || undefined }],
    enabled: ok,
  });
  const draftsQ = useQuery<{ id: number }[]>({ queryKey: ["/api/voucher-drafts"] });
  const lastActive = useQuery<{ date: string | null }>({ queryKey: ["/api/daybook/active-day", { date: day }], enabled: mode === "day" && validDate(day) });
  const data = dq.data;
  const rows = data?.rows ?? [];

  // Account and status filters are client-side because the daybook API returns journal lines
  // and reversal links, not a separate cost-center field or audit-log feed.
  const accountOptions = useMemo(() => {
    const accounts = new Map<number, { id: number; code: string; name: string }>();
    for (const row of rows) {
      for (const line of row.lines) accounts.set(line.accountId, { id: line.accountId, code: line.accountCode, name: line.accountName });
    }
    return Array.from(accounts.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    const reversed = Boolean(row.reversedByJournalId);
    const reversal = Boolean(row.reversesJournalId);
    if (!showReversed && (reversed || reversal)) return false;
    if (status === "active" && (reversed || reversal)) return false;
    if (status === "reversed" && !reversed) return false;
    if (status === "reversal" && !reversal) return false;
    if (accountFilter !== "all" && !row.lines.some((line) => String(line.accountId) === accountFilter)) return false;
    return true;
  }), [rows, status, accountFilter, showReversed]);

  // The activity tab shows statuses that are actually present on journal records.
  // It does not pretend that the API provides a history of field edits.
  const visibleRows = useMemo(() => activeTab === "transactions" ? filteredRows :
    filteredRows.filter((row) => row.reversedByJournalId || row.reversesJournalId || row.validatedByName),
  [activeTab, filteredRows]);

  const datedRows = useMemo(() => {
    const byDate = new Map<string, DaybookRow[]>();
    for (const row of visibleRows) {
      const group = byDate.get(row.date) ?? [];
      group.push(row);
      byDate.set(row.date, group);
    }
    return Array.from(byDate.entries());
  }, [visibleRows]);

  const groups = useMemo(() => {
    const m = new Map<string, { type: string; count: number; total: ReturnType<typeof d> }>();
    for (const r of filteredRows) {
      const g = m.get(r.type) ?? { type: r.type, count: 0, total: d(0) };
      g.count += 1;
      g.total = g.total.plus(r.amount);
      m.set(r.type, g);
    }
    return Array.from(m.values()).sort((a, b) => b.total.comparedTo(a.total));
  }, [filteredRows]);

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportCsv(kind: "summary" | "detailed") {
    if (!data) return;
    const name = `journal_${from}${from !== to ? `_${to}` : ""}${kind === "detailed" ? "_detail" : ""}.csv`;
    if (kind === "summary") {
      downloadCsv(name, [
        [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Libellé"), t("Contacts", "Tiers"), t("Amount ($)", "Montant ($)"), t("Created by", "Créé par"), t("Status", "Statut")],
        ...filteredRows.map((r) => [
          r.date, r.number, journalTypeLabel(r.type, t), r.memo ?? "", contactsOf(r), r.amount, [r.createdByName ?? "", r.validatedByName ? t(`validated by ${r.validatedByName}`, `validé par ${r.validatedByName}`) : ""].filter(Boolean).join(" ; "),
          r.reversedByJournalId ? t("Reversed", "Annulée") : r.reversesJournalId ? t("Reversal entry", "Contre-passation") : "",
        ]),
      ]);
    } else {
      downloadCsv(name, [
        [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Libellé"), t("Account code", "Code compte"), t("Account", "Compte"), t("Contact", "Tiers"), t("Line memo", "Note de ligne"), t("Debit ($)", "Débit ($)"), t("Credit ($)", "Crédit ($)"), "FC", t("Rate", "Taux")],
        ...filteredRows.flatMap((r) =>
          r.lines.map((l) => [r.date, r.number, journalTypeLabel(r.type, t), r.memo ?? "", l.accountCode, l.accountName, l.partyName ?? "", l.memo ?? "", l.debit, l.credit, l.nativeAmount ?? "", l.rate ?? ""]),
        ),
      ]);
    }
  }

  const chips: { label: string; clear: () => void }[] = [];
  if (type !== "all") chips.push({ label: journalTypeLabel(type, t), clear: () => setType("all") });
  if (status !== "all") chips.push({ label: status === "active" ? t("Active", "Actives") : status === "reversed" ? t("Reversed", "Annulées") : t("Reversal entries", "Contre-passations"), clear: () => setStatus("all") });
  if (accountFilter !== "all") {
    const account = accountOptions.find((a) => String(a.id) === accountFilter);
    chips.push({ label: account ? account.code + " · " + sys.account(account.name) : t("Account", "Compte"), clear: () => setAccountFilter("all") });
  }
  if (q) chips.push({ label: t("Search", "Recherche") + " : " + q, clear: () => { setQInput(""); setQ(""); } });
  if (mode === "range") chips.push({ label: fmtDate(range.from) + " → " + fmtDate(range.to), clear: () => setMode("day") });
  if (!showReversed) chips.push({ label: t("Reversals hidden", "Annulations masquées"), clear: () => setShowReversed(true) });

  function resetFilters() {
    setType("all");
    setStatus("all");
    setAccountFilter("all");
    setQInput("");
    setQ("");
    setMode("day");
    setDay(todayLocal());
    setShowReversed(true);
  }

  const draftCount = draftsQ.data?.length ?? 0;

  return (
    <div className="min-w-0">
      <div className="border-l-[3px] border-primary pl-3">
        <PageHeader
          title={t("Daybook", "Journal du jour")}
          description={t("View all accounting transactions chronologically", "Consultez toutes les écritures comptables dans l'ordre chronologique")}
          actions={
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href="/optional-vouchers">
                  <FileText className="mr-1 h-4 w-4" /> {t("Optional vouchers", "Pièces en attente")}
                  {draftCount > 0 && <Badge className="ml-2 h-5 px-1.5">{draftCount}</Badge>}
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={!filteredRows.length}>
                    <Download className="mr-1 h-4 w-4" /> {t("Export", "Exporter")} <ChevronDown className="ml-1 h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => exportCsv("summary")}>{t("Summary CSV", "CSV récapitulatif")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportCsv("detailed")}>{t("Detailed CSV", "CSV détaillé")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" asChild>
                <Link href="/vouchers"><Plus className="mr-1 h-4 w-4" /> {t("New voucher", "Nouvelle pièce")}</Link>
              </Button>
            </>
          }
        />
      </div>

      {/* Tab strip and filter toolbar follow the transaction-led layout of the reference. */}
      <div className="mb-1 flex w-fit items-center gap-1 rounded-full border bg-card/70 p-1" role="tablist" aria-label={t("Daybook sections", "Sections du journal")}>
        <button type="button" role="tab" aria-selected={activeTab === "transactions"}
          onClick={() => setActiveTab("transactions")}
          className={cn("rounded-full px-4 py-2 text-sm font-medium transition-colors", activeTab === "transactions" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {t("Transactions", "Transactions")}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "activity"}
          onClick={() => setActiveTab("activity")}
          className={cn("rounded-full px-4 py-2 text-sm font-medium transition-colors", activeTab === "activity" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {t("Edits & Activity", "Modifications et activité")}
        </button>
      </div>

      <Card className="mb-2 bg-card/70">
        <CardContent className="p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(170px,.9fr)_minmax(140px,1fr)_minmax(140px,1fr)_minmax(160px,1fr)_minmax(210px,1.15fr)]">
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-10 w-full justify-start gap-2 overflow-hidden font-normal">
                  <CalendarDays className="h-4 w-4 shrink-0" />
                  <span className="truncate">{mode === "day" ? (validDate(day) ? fmtDate(day) : t("Choose date", "Choisir une date")) : fmtDate(from) + " – " + fmtDate(to)}</span>
                  <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[min(92vw,420px)] space-y-3 p-4">
                <div className="flex w-fit rounded-md border p-0.5">
                  <Button size="sm" variant={mode === "day" ? "default" : "ghost"} onClick={() => setMode("day")}>{t("Day", "Jour")}</Button>
                  <Button size="sm" variant={mode === "range" ? "default" : "ghost"} onClick={() => setMode("range")}>{t("Range", "Plage")}</Button>
                </div>
                {mode === "day" ? (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" aria-label={t("Previous day", "Jour précédent")} onClick={() => validDate(day) && setDay(shiftDay(day, -1))}><ChevronLeft className="h-4 w-4" /></Button>
                    <Input type="date" className="min-w-0 flex-1" aria-label={t("Day", "Jour")} value={day} onChange={(e) => setDay(e.target.value)} />
                    <Button variant="outline" size="icon" aria-label={t("Next day", "Jour suivant")} onClick={() => validDate(day) && setDay(shiftDay(day, 1))}><ChevronRight className="h-4 w-4" /></Button>
                  </div>
                ) : <RangePicker range={range} />}
                <div className="flex items-center justify-between">
                  <Button size="sm" variant="ghost" onClick={() => { setMode("day"); setDay(todayLocal()); }}>{t("Today", "Aujourd'hui")}</Button>
                  <Button size="sm" onClick={() => setDatePickerOpen(false)}>{t("Apply", "Appliquer")}</Button>
                </div>
              </PopoverContent>
            </Popover>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-10"><SelectValue placeholder={t("All types", "Tous les types")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All types", "Tous les types")}</SelectItem>
                {JOURNAL_TYPES.map((x) => <SelectItem key={x} value={x}>{journalTypeLabel(x, t)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-10"><SelectValue placeholder={t("All statuses", "Tous les statuts")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All statuses", "Tous les statuts")}</SelectItem>
                <SelectItem value="active">{t("Active", "Actives")}</SelectItem>
                <SelectItem value="reversed">{t("Reversed", "Annulées")}</SelectItem>
                <SelectItem value="reversal">{t("Reversal entries", "Contre-passations")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={accountFilter} onValueChange={setAccountFilter}>
              <SelectTrigger className="h-10"><SelectValue placeholder={t("All accounts", "Tous les comptes")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All accounts", "Tous les comptes")}</SelectItem>
                {accountOptions.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.code} · {sys.account(a.name)}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input className="h-10 pl-9" value={qInput} onChange={(e) => setQInput(e.target.value)}
                placeholder={t("Voucher # or description…", "N° de pièce ou libellé…")} aria-label={t("Search vouchers", "Rechercher des pièces")} />
              {qInput && <button type="button" className="absolute right-2.5 top-3 text-muted-foreground hover:text-foreground" aria-label={t("Clear search", "Effacer la recherche")} onClick={() => { setQInput(""); setQ(""); }}><X className="h-4 w-4" /></button>}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-6 flex min-h-7 flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
        <span>{t("Active:", "Actifs :")}</span>
        {chips.map((chip) => (
          <Badge key={chip.label} variant="secondary" className="gap-1 py-1 font-normal">
            {chip.label}
            <button type="button" onClick={chip.clear} aria-label={t("Remove filter", "Retirer le filtre")} className="rounded p-0.5 hover:bg-muted-foreground/20"><X className="h-3 w-3" /></button>
          </Badge>
        ))}
        <button type="button" onClick={resetFilters} className="ml-1 inline-flex items-center gap-1 font-medium text-foreground hover:underline"><X className="h-3 w-3" /> {t("Reset filters", "Réinitialiser les filtres")}</button>
      </div>

      <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-base font-semibold">
            {activeTab === "transactions" ? t("Transactions", "Transactions") : t("Edits & Activity", "Modifications et activité")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {activeTab === "transactions"
              ? t("All accounting vouchers and transactions", "Toutes les pièces et écritures comptables")
              : t("Voucher reversals and validations recorded in the journal (not a full edit audit log)", "Annulations et validations enregistrées dans le journal (pas un historique complet des modifications)")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground" onClick={() => setShowReversed(!showReversed)}>
            {showReversed ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {showReversed ? t("Hide reversed", "Masquer les annulations") : t("Show reversed", "Afficher les annulations")}
          </Button>
          {activeTab === "transactions" && (
            <div className="inline-flex rounded-md border p-0.5">
              <Button size="sm" variant={view === "detailed" ? "secondary" : "ghost"} className="h-8 gap-1" onClick={() => setView("detailed")}><LayoutList className="h-4 w-4" /> {t("Detailed", "Détaillé")}</Button>
              <Button size="sm" variant={view === "condensed" ? "secondary" : "ghost"} className="h-8 gap-1" onClick={() => setView("condensed")}><Layers className="h-4 w-4" /> {t("Condensed", "Condensé")}</Button>
            </div>
          )}
        </div>
      </div>

      <ErrorText error={dq.error} />
      {data?.truncated && (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {t("Only the latest 1,000 vouchers are shown. Narrow the period or the filters to see the rest.", "Seules les 1 000 dernières pièces sont affichées. Réduisez la période ou les filtres pour voir le reste.")}
        </p>
      )}
      {dq.isLoading && <Loading />}
      {data && visibleRows.length === 0 && (
        <EmptyState title={activeTab === "activity" ? t("No recorded reversals or validations for this selection", "Aucune annulation ou validation pour cette sélection") : t("No matching transactions", "Aucune transaction correspondante")}>
          {mode === "day" && lastActive.data?.date && activeTab === "transactions" && chips.length === 0 ? (
            <Button variant="outline" className="mt-1" onClick={() => setDay(lastActive.data!.date!)}>
              <ChevronLeft className="mr-1 h-4 w-4" /> {t("Last active day: ", "Dernier jour actif : ")}{fmtDate(lastActive.data.date)}
            </Button>
          ) : t("Try another date or clear your filters.", "Essayez une autre date ou effacez les filtres.")}
        </EmptyState>
      )}

      {data && visibleRows.length > 0 && view === "condensed" && activeTab === "transactions" && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>{t("Type", "Type")}</TableHead>
                  <TableHead className="text-right">{t("Transactions", "Transactions")}</TableHead>
                  <TableHead className="text-right">{t("Total amount", "Montant total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.type} className="cursor-pointer hover:bg-muted/40" onClick={() => { setType(g.type); setView("detailed"); }}>
                    <TableCell><TypeBadge type={g.type} t={t} /></TableCell>
                    <TableCell className="text-right"><Num>{g.count}</Num></TableCell>
                    <TableCell className="text-right font-medium"><Num>{usd(g.total)}</Num></TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("Total", "Total")}</TableCell>
                  <TableCell className="text-right"><Num>{filteredRows.length}</Num></TableCell>
                  <TableCell className="text-right"><Num>{usd(filteredRows.reduce((sum, r) => sum.plus(r.amount), d(0)))}</Num></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      {data && visibleRows.length > 0 && (view === "detailed" || activeTab === "activity") && (
        <>
          <Card className="hidden overflow-hidden md:block">
            <CardContent className="p-0">
              <div className="max-h-[min(72vh,850px)] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted/60 shadow-[0_1px_0_hsl(var(--border))]">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[142px] text-xs uppercase tracking-wide">{t("Date / No.", "Date / N°")}</TableHead>
                      <TableHead className="w-[150px] text-xs uppercase tracking-wide">{t("Type", "Type")}</TableHead>
                      <TableHead className="min-w-[250px] text-xs uppercase tracking-wide">{t("Description", "Description")}</TableHead>
                      <TableHead className="w-[165px] text-right text-xs uppercase tracking-wide">{t("Amount", "Montant")}</TableHead>
                      <TableHead className="w-[132px] text-right text-xs uppercase tracking-wide">{t("Actions", "Actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {datedRows.map(([date, entries]) => (
                      <Fragment key={date}>
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell colSpan={3} className="py-1.5 text-xs font-medium">
                            {fmtDate(date)} <span className="ml-2 font-normal text-muted-foreground">({entries.length} {t("entries", "écritures")})</span>
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-semibold"><Num>{usd(entries.reduce((total, entry) => total.plus(entry.amount), d(0)))}</Num></TableCell>
                          <TableCell />
                        </TableRow>
                        {entries.map((r) => {
                          const expanded = open.has(r.id);
                          const contacts = contactsOf(r);
                          const activity = r.reversesJournalId ? t("Reversal posted", "Contre-passation effectuée") : r.reversedByJournalId ? t("Voucher reversed", "Pièce annulée") : t("Voucher validated", "Pièce validée");
                          return (
                            <Fragment key={r.id}>
                              <TableRow className={cn("cursor-pointer border-border/50 hover:bg-muted/30", r.reversedByJournalId && "text-muted-foreground")} onClick={() => toggle(r.id)}>
                                <TableCell className="whitespace-nowrap">
                                  <span className="block text-xs font-medium">{fmtDate(r.date)}</span>
                                  <span className="block font-mono text-[11px] text-muted-foreground">{r.number}</span>
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1">
                                    {activeTab === "activity" ? <Badge variant="outline">{activity}</Badge> : <TypeBadge type={r.type} t={t} />}
                                    <StatusBadges r={r} t={t} />
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                                    <div className="min-w-0">
                                      <span className={cn("block break-words text-sm font-medium", r.reversedByJournalId && "line-through")}>{r.memo ? frenchPunctuation(sys.memo(r.memo)) : contacts || r.number}</span>
                                      {contacts && contacts !== r.memo && <span className="block break-words text-xs text-muted-foreground">{contacts}</span>}
                                      {activeTab === "activity" && r.validatedByName && <span className="block text-xs text-muted-foreground">{t("Validated by", "Validée par")} {r.validatedByName}</span>}
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right font-semibold">
                                  <Num>{usd(r.amount)}</Num>
                                  {cashDetail(r, t) && <span className="ml-auto block max-w-56 text-xs font-normal text-muted-foreground">{cashDetail(r, t)}</span>}
                                </TableCell>
                                <TableCell onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center justify-end gap-0.5">
                                    <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                                      <Link href={sourceHref(r)} title={t("Open voucher", "Ouvrir la pièce")} aria-label={t("Open voucher", "Ouvrir la pièce")}><Eye className="h-4 w-4" /></Link>
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                                      <Link href={"/vouchers/" + r.id} title={t("Print voucher", "Imprimer la pièce")} aria-label={t("Print voucher", "Imprimer la pièce")}><Printer className="h-4 w-4" /></Link>
                                    </Button>
                                    {canReverseRow(r, isOwner) && (
                                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                                        title={t("Reverse voucher", "Annuler la pièce")} aria-label={t("Reverse voucher", "Annuler la pièce")}
                                        onClick={() => setReversing(r)}><RotateCcw className="h-4 w-4" /></Button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                              {expanded && (
                                <TableRow className="bg-muted/20 hover:bg-muted/20">
                                  <TableCell colSpan={5} className="px-5 py-3">
                                    <div className="mb-2 text-xs text-muted-foreground">{t("Created by", "Créé par")} {r.createdByName || "—"}{r.validatedByName ? " · " + t("Validated by", "Validé par") + " " + r.validatedByName : ""}</div>
                                    <LinesTable lines={r.lines} t={t} />
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* The same records and actions in a touch-friendly stacked layout. */}
          <Card className="md:hidden">
            <CardContent className="divide-y p-0">
              {visibleRows.map((r) => {
                const expanded = open.has(r.id);
                const contacts = contactsOf(r);
                return (
                  <div key={r.id} className="p-3">
                    <button type="button" className="w-full text-left" aria-expanded={expanded} onClick={() => toggle(r.id)}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className={cn("break-words font-medium", r.reversedByJournalId && "line-through text-muted-foreground")}>
                            <KeepNumbers text={(r.memo && frenchPunctuation(sys.memo(r.memo))) || contacts || journalTypeLabel(r.type, t)} />
                          </p>
                          <p className="break-words text-xs text-muted-foreground">{fmtDate(r.date)} · <span className="whitespace-nowrap font-mono">{r.number}</span></p>
                        </div>
                        <div className="shrink-0 text-right font-medium"><Num>{usd(r.amount)}</Num></div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <TypeBadge type={r.type} t={t} /><StatusBadges r={r} t={t} />
                        {activeTab === "activity" && r.validatedByName && <span className="text-xs text-muted-foreground">{t("Validated by", "Validé par")} {r.validatedByName}</span>}
                      </div>
                      {cashDetail(r, t) && <p className="mt-1 text-xs text-muted-foreground">{cashDetail(r, t)}</p>}
                    </button>
                    {expanded && (
                      <div className="mt-3 space-y-2">
                        <LinesList lines={r.lines} t={t} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">{r.createdByName ? t("By", "Par") + " " + r.createdByName : ""}</span>
                          <RowActions r={r} t={t} isOwner={isOwner} onReverse={() => setReversing(r)} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      {reversing && <ReverseDialog row={reversing} t={t} onClose={() => setReversing(null)} />}
    </div>
  );
}

const canReverseRow = (r: DaybookRow, isOwner: boolean) => isOwner && REVERSIBLE.has(r.type) && !r.reversedByJournalId && !r.reversesJournalId;

function RowActions({ r, t, isOwner, onReverse }: { r: DaybookRow; t: T; isOwner: boolean; onReverse: () => void }) {
  const canReverse = canReverseRow(r, isOwner);
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="sm" className="h-8 px-2" asChild>
        <Link href={sourceHref(r)}><ExternalLink className="mr-1 h-3.5 w-3.5" /> {t("Open", "Ouvrir")}</Link>
      </Button>
      <Button variant="ghost" size="sm" className="h-8 px-2" asChild>
        <Link href={`/vouchers/${r.id}`}><Printer className="mr-1 h-3.5 w-3.5" /> {t("Print", "Imprimer")}</Link>
      </Button>
      {canReverse && (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-destructive hover:text-destructive" onClick={onReverse}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> {t("Reverse", "Annuler")}
        </Button>
      )}
    </div>
  );
}

function LinesTable({ lines, t }: { lines: DaybookLine[]; t: T }) {
  const sys = useSystemText();
  return (
    <div className="overflow-x-auto [contain:inline-size]">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="py-1 pr-3 text-left font-medium">{t("Account", "Compte")}</th>
            <th className="py-1 pr-3 text-left font-medium">{t("Contact", "Tiers")}</th>
            <th className="py-1 pr-3 text-right font-medium">{t("Debit", "Débit")}</th>
            <th className="py-1 pr-3 text-right font-medium">{t("Credit", "Crédit")}</th>
            <th className="py-1 text-right font-medium">CDF</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-border/60">
              <td className="py-1 pr-3">
                <Link href={`/accounts?account=${l.accountId}`} className="hover:underline">
                  <span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {sys.account(l.accountName)}
                </Link>
                {l.memo && l.memo !== l.partyName && <span className="block text-xs text-muted-foreground">{sys.memo(l.memo)}</span>}
              </td>
              <td className="py-1 pr-3">{l.partyName ?? ""}</td>
              <td className="py-1 pr-3 text-right"><Num>{d(l.debit).isZero() ? "" : usd(l.debit)}</Num></td>
              <td className="py-1 pr-3 text-right"><Num>{d(l.credit).isZero() ? "" : usd(l.credit)}</Num></td>
              <td className="py-1 text-right text-xs">
                <Num>{l.nativeAmount != null ? money(l.nativeAmount, l.currency ?? "CDF") : ""}</Num>
                {l.nativeAmount != null && l.rate && <span className="block text-muted-foreground">{t("rate", "taux")} {qty(l.rate)}{"\u00a0"}{curLabel(l.currency ?? "CDF")}/$</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinesList({ lines, t }: { lines: DaybookLine[]; t: T }) {
  const sys = useSystemText();
  return (
    <div className="rounded-md border bg-muted/30 text-sm">
      {lines.map((l) => (
        <div key={l.id} className="flex items-start justify-between gap-2 border-b px-2 py-1.5 last:border-b-0">
          <div className="min-w-0">
            <p className="break-words"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {sys.account(l.accountName)}</p>
            {(l.partyName || l.memo) && <p className="break-words text-xs text-muted-foreground">{[l.partyName, sys.memo(l.memo)].filter(Boolean).join(" · ")}</p>}
          </div>
          <div className="shrink-0 text-right text-xs">
            {!d(l.debit).isZero() && <Num>{t("Dr", "D")} {usd(l.debit)}</Num>}
            {!d(l.credit).isZero() && <Num>{t("Cr", "C")} {usd(l.credit)}</Num>}
            {l.nativeAmount != null && <span className="block text-muted-foreground">{money(l.nativeAmount, l.currency ?? "CDF")}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReverseDialog({ row, t, onClose }: { row: DaybookRow; t: T; onClose: () => void }) {
  const sys = useSystemText();
  const [day, setDay] = useState(todayLocal());
  const m = useApiMutation<{ date: string }>("POST", `/api/journals/${row.id}/reverse`, {
    success: t("Voucher reversed", "Pièce annulée"),
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Reverse this voucher?", "Annuler cette pièce\u00a0?")}</DialogTitle>
          <DialogDescription>
            {t(
              "A reversal entry with the opposite debits and credits will be posted. The original stays in the books, marked as reversed.",
              "Une écriture inverse (débits et crédits échangés) sera passée. La pièce d'origine reste dans les livres, marquée comme annulée.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border p-3 text-sm">
            <p className="font-mono text-xs text-muted-foreground">{row.number} · {fmtDate(row.date)}</p>
            <p className="font-medium">{sys.memo(row.memo) || journalTypeLabel(row.type, t)}</p>
            <p><Num>{usd(row.amount)}</Num></p>
          </div>
          <Field label={t("Reversal date", "Date de l'annulation")} required>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>{t("Keep it", "Garder")}</Button>
          <SubmitButton variant="destructive" blocked={!validDate(day) && t("Choose a valid date", "Choisissez une date valide")} pending={m.isPending} onClick={() => m.mutate({ date: day })}>
            <RotateCcw className="mr-1 h-4 w-4" /> {t("Reverse", "Annuler la pièce")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
