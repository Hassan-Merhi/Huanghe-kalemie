import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Layers, LayoutList, MoreHorizontal, Plus, Printer, RotateCcw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { downloadCsv } from "@/lib/sheets";
import { cdf, d, date as fmtDate, todayLocal, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RangePicker, useRange } from "@/pages/Reports";
import { journalTypeLabel } from "@/pages/ContactDetail";

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
  sourceId: number | null;
  reversedByJournalId: number | null;
  reversesJournalId: number | null;
  createdByName: string | null;
  amount: string;
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
  if (r.sourceType === "expense") return "/expenses";
  return `/vouchers/${r.id}`;
}

function typeTone(type: string): string {
  if (type.startsWith("sale") || type === "customer_receipt" || type === "receipt") return "border-emerald-500/40 text-emerald-700 dark:text-emerald-400";
  if (type === "expense" || type === "payment" || type === "supplier_payment" || type === "payroll") return "border-orange-500/40 text-orange-700 dark:text-orange-400";
  if (type.startsWith("container")) return "border-sky-500/40 text-sky-700 dark:text-sky-400";
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
    </>
  );
}

/** Contacts named on the lines, for the memo column. */
function contactsOf(r: DaybookRow): string {
  return Array.from(new Set(r.lines.map((l) => l.partyName).filter(Boolean))).join(", ");
}

export default function Daybook() {
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
  const data = dq.data;
  const rows = data?.rows ?? [];
  const total = useMemo(() => rows.reduce((s, r) => s.plus(r.amount), d(0)), [rows]);

  const groups = useMemo(() => {
    const m = new Map<string, { type: string; count: number; total: ReturnType<typeof d> }>();
    for (const r of rows) {
      const g = m.get(r.type) ?? { type: r.type, count: 0, total: d(0) };
      g.count += 1;
      g.total = g.total.plus(r.amount);
      m.set(r.type, g);
    }
    return Array.from(m.values()).sort((a, b) => b.total.comparedTo(a.total));
  }, [rows]);

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
        [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Libellé"), t("Contacts", "Tiers"), t("Amount USD", "Montant USD"), t("Created by", "Créé par"), t("Status", "Statut")],
        ...rows.map((r) => [
          r.date, r.number, journalTypeLabel(r.type, t), r.memo ?? "", contactsOf(r), r.amount, r.createdByName ?? "",
          r.reversedByJournalId ? t("Reversed", "Annulée") : r.reversesJournalId ? t("Reversal entry", "Contre-passation") : "",
        ]),
      ]);
    } else {
      downloadCsv(name, [
        [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Libellé"), t("Account code", "Code compte"), t("Account", "Compte"), t("Contact", "Tiers"), t("Line memo", "Note de ligne"), t("Debit USD", "Débit USD"), t("Credit USD", "Crédit USD"), "CDF", t("Rate", "Taux")],
        ...rows.flatMap((r) =>
          r.lines.map((l) => [r.date, r.number, journalTypeLabel(r.type, t), r.memo ?? "", l.accountCode, l.accountName, l.partyName ?? "", l.memo ?? "", l.debit, l.credit, l.nativeAmount ?? "", l.rate ?? ""]),
        ),
      ]);
    }
  }

  const chips: { label: string; clear: () => void }[] = [];
  if (type !== "all") chips.push({ label: `${t("Type", "Type")} : ${journalTypeLabel(type, t)}`, clear: () => setType("all") });
  if (q) chips.push({ label: `${t("Search", "Recherche")} : « ${q} »`, clear: () => { setQInput(""); setQ(""); } });
  if (mode === "range") chips.push({ label: `${fmtDate(range.from)} → ${fmtDate(range.to)}`, clear: () => setMode("day") });

  const draftCount = draftsQ.data?.length ?? 0;

  return (
    <div>
      <PageHeader
        title={t("Day book", "Journal du jour")}
        description={t("Every entry posted, day by day: sales, payments, expenses, transfers…", "Toutes les écritures passées, jour par jour\u00a0: ventes, paiements, dépenses, transferts…")}
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
                <Button variant="outline" size="sm" disabled={!rows.length}>
                  <Download className="mr-1 h-4 w-4" /> CSV <ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => exportCsv("summary")}>{t("Summary (one line per voucher)", "Résumé (une ligne par pièce)")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportCsv("detailed")}>{t("Detailed (one line per entry line)", "Détaillé (une ligne par ligne d'écriture)")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" asChild>
              <Link href="/vouchers"><Plus className="mr-1 h-4 w-4" /> {t("New voucher", "Nouvelle pièce")}</Link>
            </Button>
          </>
        }
      />

      {/* Period and filters */}
      <Card className="mb-4">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex rounded-md border p-0.5">
              <Button size="sm" variant={mode === "day" ? "default" : "ghost"} className="h-8" onClick={() => setMode("day")}>{t("Day", "Jour")}</Button>
              <Button size="sm" variant={mode === "range" ? "default" : "ghost"} className="h-8" onClick={() => setMode("range")}>{t("Range", "Plage")}</Button>
            </div>
            {mode === "day" ? (
              <div className="flex items-end gap-1">
                <Button variant="outline" size="icon" aria-label={t("Previous day", "Jour précédent")} onClick={() => validDate(day) && setDay(shiftDay(day, -1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Input type="date" className="w-40" value={day} onChange={(e) => setDay(e.target.value)} />
                <Button variant="outline" size="icon" aria-label={t("Next day", "Jour suivant")} onClick={() => validDate(day) && setDay(shiftDay(day, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                {day !== todayLocal() && (
                  <Button variant="ghost" size="sm" onClick={() => setDay(todayLocal())}>{t("Today", "Aujourd'hui")}</Button>
                )}
              </div>
            ) : (
              <RangePicker range={range} />
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("Type", "Type")} className="w-full sm:w-56">
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All types", "Tous les types")}</SelectItem>
                  {JOURNAL_TYPES.map((x) => <SelectItem key={x} value={x}>{journalTypeLabel(x, t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("Search", "Recherche")} className="w-full sm:w-72">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t("Number, memo, contact…", "Numéro, libellé, tiers…")} />
              </div>
            </Field>
            <div className="ml-auto flex rounded-md border p-0.5">
              <Button size="sm" variant={view === "detailed" ? "secondary" : "ghost"} className="h-8" onClick={() => setView("detailed")}>
                <LayoutList className="mr-1 h-4 w-4" /> {t("Detailed", "Détaillé")}
              </Button>
              <Button size="sm" variant={view === "condensed" ? "secondary" : "ghost"} className="h-8" onClick={() => setView("condensed")}>
                <Layers className="mr-1 h-4 w-4" /> {t("By type", "Par type")}
              </Button>
            </div>
          </div>
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <Badge key={c.label} variant="secondary" className="gap-1 pr-1 font-normal">
                  {c.label}
                  <button type="button" onClick={c.clear} className="rounded-full p-0.5 hover:bg-muted-foreground/20" aria-label={t("Remove filter", "Retirer le filtre")}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("Vouchers", "Pièces")} value={rows.length} sub={mode === "day" ? fmtDate(day) : `${fmtDate(from)} → ${fmtDate(to)}`} />
        <StatCard label={t("Money in", "Entrées d'argent")} value={usd(data?.moneyIn ?? 0)} tone="good" sub={t("Cash, bank, mobile money", "Caisse, banque, mobile money")} />
        <StatCard label={t("Money out", "Sorties d'argent")} value={usd(data?.moneyOut ?? 0)} tone="bad" />
        <StatCard label={t("Total", "Total")} value={usd(total)} sub={t("Sum of voucher amounts", "Somme des montants des pièces")} />
      </div>

      <ErrorText error={dq.error} />
      {data?.truncated && (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {t("Only the latest 1,000 vouchers are shown. Narrow the period or the filters to see the rest.", "Seules les 1 000 dernières pièces sont affichées. Réduisez la période ou les filtres pour voir le reste.")}
        </p>
      )}
      {dq.isLoading && <Loading />}
      {data && !rows.length && (
        <EmptyState title={t("No vouchers for this period", "Aucune pièce pour cette période")}>
          {t("Change the date or the filters.", "Changez la date ou les filtres.")}
        </EmptyState>
      )}

      {rows.length > 0 && view === "condensed" && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Type", "Type")}</TableHead>
                  <TableHead className="text-right">{t("Count", "Nombre")}</TableHead>
                  <TableHead className="text-right">{t("Total", "Total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.type} className="cursor-pointer" onClick={() => { setType(g.type); setView("detailed"); }}>
                    <TableCell><TypeBadge type={g.type} t={t} /></TableCell>
                    <TableCell className="text-right"><Num>{g.count}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(g.total)}</Num></TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("Total", "Total")}</TableCell>
                  <TableCell className="text-right"><Num>{rows.length}</Num></TableCell>
                  <TableCell className="text-right"><Num>{usd(total)}</Num></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && view === "detailed" && (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto [contain:inline-size]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>{t("Date", "Date")}</TableHead>
                      <TableHead>{t("No.", "N°")}</TableHead>
                      <TableHead>{t("Type", "Type")}</TableHead>
                      <TableHead>{t("Details", "Libellé")}</TableHead>
                      <TableHead className="text-right">{t("Amount", "Montant")}</TableHead>
                      <TableHead>{t("By", "Par")}</TableHead>
                      <TableHead className="w-12"><span className="sr-only">{t("Actions", "Actions")}</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const expanded = open.has(r.id);
                      const contacts = contactsOf(r);
                      return (
                        <Fragment key={r.id}>
                          <TableRow className={cn("cursor-pointer", r.reversedByJournalId && "text-muted-foreground")} onClick={() => toggle(r.id)}>
                            <TableCell className="pr-0">
                              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                            <TableCell className="whitespace-nowrap font-mono text-xs">{r.number}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1"><TypeBadge type={r.type} t={t} /><StatusBadges r={r} t={t} /></div>
                            </TableCell>
                            <TableCell className="min-w-[200px]">
                              <span className={cn(r.reversedByJournalId && "line-through")}>{r.memo || "—"}</span>
                              {contacts && <span className="block text-xs text-muted-foreground">{contacts}</span>}
                            </TableCell>
                            <TableCell className="text-right font-medium"><Num>{usd(r.amount)}</Num></TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.createdByName ?? ""}</TableCell>
                            <TableCell className="w-12 pl-0 text-right" onClick={(e) => e.stopPropagation()}>
                              <RowActionsMenu r={r} t={t} isOwner={isOwner} onReverse={() => setReversing(r)} />
                            </TableCell>
                          </TableRow>
                          {expanded && (
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableCell />
                              <TableCell colSpan={7} className="py-2">
                                <LinesTable lines={r.lines} t={t} />
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Mobile: two-line rows */}
          <Card className="md:hidden">
            <CardContent className="divide-y p-0">
              {rows.map((r) => {
                const expanded = open.has(r.id);
                const contacts = contactsOf(r);
                return (
                  <div key={r.id} className="p-3">
                    <button type="button" className="w-full text-left" onClick={() => toggle(r.id)}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className={cn("truncate font-medium", r.reversedByJournalId && "line-through text-muted-foreground")}>{r.memo || contacts || journalTypeLabel(r.type, t)}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {fmtDate(r.date)} · <span className="font-mono">{r.number}</span>{contacts && r.memo ? ` · ${contacts}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <Num className="font-medium">{usd(r.amount)}</Num>
                          <div className="mt-1 flex flex-wrap justify-end gap-1"><TypeBadge type={r.type} t={t} /><StatusBadges r={r} t={t} /></div>
                        </div>
                      </div>
                    </button>
                    {expanded && (
                      <div className="mt-2 space-y-2">
                        <LinesList lines={r.lines} t={t} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">{r.createdByName ? `${t("By", "Par")} ${r.createdByName}` : ""}</span>
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

/** Desktop table: one "…" menu per row, so every row's action cell has the same width. */
function RowActionsMenu({ r, t, isOwner, onReverse }: { r: DaybookRow; t: T; isOwner: boolean; onReverse: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t(`Actions for ${r.number}`, `Actions pour ${r.number}`)}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={sourceHref(r)}><ExternalLink className="mr-2 h-4 w-4" /> {t("Open", "Ouvrir")}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/vouchers/${r.id}`}><Printer className="mr-2 h-4 w-4" /> {t("Print", "Imprimer")}</Link>
        </DropdownMenuItem>
        {canReverseRow(r, isOwner) && (
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onReverse}>
            <RotateCcw className="mr-2 h-4 w-4" /> {t("Reverse", "Annuler")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
                  <span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {l.accountName}
                </Link>
                {l.memo && l.memo !== l.partyName && <span className="block text-xs text-muted-foreground">{l.memo}</span>}
              </td>
              <td className="py-1 pr-3">{l.partyName ?? ""}</td>
              <td className="py-1 pr-3 text-right"><Num>{d(l.debit).isZero() ? "" : usd(l.debit)}</Num></td>
              <td className="py-1 pr-3 text-right"><Num>{d(l.credit).isZero() ? "" : usd(l.credit)}</Num></td>
              <td className="py-1 text-right text-xs">
                <Num>{l.nativeAmount != null ? cdf(l.nativeAmount) : ""}</Num>
                {l.nativeAmount != null && l.rate && <span className="block text-muted-foreground">@ {l.rate}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinesList({ lines, t }: { lines: DaybookLine[]; t: T }) {
  return (
    <div className="rounded-md border bg-muted/30 text-sm">
      {lines.map((l) => (
        <div key={l.id} className="flex items-start justify-between gap-2 border-b px-2 py-1.5 last:border-b-0">
          <div className="min-w-0">
            <p className="truncate"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {l.accountName}</p>
            {(l.partyName || l.memo) && <p className="truncate text-xs text-muted-foreground">{[l.partyName, l.memo].filter(Boolean).join(" · ")}</p>}
          </div>
          <div className="shrink-0 text-right text-xs">
            {!d(l.debit).isZero() && <Num>{t("Dr", "D")} {usd(l.debit)}</Num>}
            {!d(l.credit).isZero() && <Num>{t("Cr", "C")} {usd(l.credit)}</Num>}
            {l.nativeAmount != null && <span className="block text-muted-foreground">{cdf(l.nativeAmount)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReverseDialog({ row, t, onClose }: { row: DaybookRow; t: T; onClose: () => void }) {
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
              "Une contre-passation avec les débits et crédits inversés sera passée. La pièce d'origine reste dans les livres, marquée comme annulée.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border p-3 text-sm">
            <p className="font-mono text-xs text-muted-foreground">{row.number} · {fmtDate(row.date)}</p>
            <p className="font-medium">{row.memo || journalTypeLabel(row.type, t)}</p>
            <p><Num>{usd(row.amount)}</Num></p>
          </div>
          <Field label={t("Reversal date", "Date de l'annulation")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>{t("Keep it", "Garder")}</Button>
          <Button variant="destructive" disabled={!validDate(day) || m.isPending} onClick={() => m.mutate({ date: day })}>
            <RotateCcw className="mr-1 h-4 w-4" /> {t("Reverse", "Annuler la pièce")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
