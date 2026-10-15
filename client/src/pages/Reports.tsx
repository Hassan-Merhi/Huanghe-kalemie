import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Plus, Printer, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { AccountSelect, PartySelect } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { downloadCsv } from "@/lib/sheets";
import { useT } from "@/lib/i18n";
import { cdf, d, date as fmtDate, money, monthStart, previousMonth, qty, todayLocal, usd, variantText } from "@/lib/format";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WIDE_PRINT_CSS, journalTypeLabel } from "@/pages/ContactDetail";

type T = (en: string, fr: string) => string;

/** Name of an account type: singular for one account, `plural` for a group heading or filter ("Charges de fonctionnement"). */
export function accountTypeLabel(type: string, t: T, plural = false): string {
  const map: Record<string, [string, string, string, string]> = {
    asset: ["Asset", "Actif", "Assets", "Actifs"],
    liability: ["Liability", "Passif", "Liabilities", "Passifs"],
    equity: ["Equity", "Capitaux propres", "Equity", "Capitaux propres"],
    income: ["Income", "Produit", "Income", "Produits"],
    cost_of_sales: ["Cost of sales", "Coût des ventes", "Cost of sales", "Coût des ventes"],
    expense: ["Running cost", "Charge de fonctionnement", "Running costs", "Charges de fonctionnement"],
  };
  const m = map[type];
  if (!m) return type;
  return plural ? t(m[2], m[3]) : t(m[0], m[1]);
}

// ---------------------------------------------------------------- CSV

export function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Download className="mr-1 h-4 w-4" /> CSV
    </Button>
  );
}

// ---------------------------------------------------------------- Date range

function lastDay(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function useRange() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  return { from, to, setFrom, setTo };
}

export function RangePicker({ range }: { range: ReturnType<typeof useRange> }) {
  const t = useT();
  const today = todayLocal();
  const pm = previousMonth();
  const presets: [string, string, string][] = [
    [t("This month", "Ce mois"), monthStart(today), today],
    [t("Last month", "Mois dernier"), `${pm}-01`, lastDay(pm)],
    [t("This year", "Cette année"), `${today.slice(0, 4)}-01-01`, today],
  ];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t("From", "Du")}>
        <Input type="date" className="w-40" value={range.from} onChange={(e) => range.setFrom(e.target.value)} />
      </Field>
      <Field label={t("To", "Au")}>
        <Input type="date" className="w-40" value={range.to} onChange={(e) => range.setTo(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-1">
        {presets.map(([label, f, to]) => (
          <Button
            key={label}
            size="sm"
            variant={range.from === f && range.to === to ? "default" : "outline"}
            onClick={() => { range.setFrom(f); range.setTo(to); }}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------------------------------------------------------------- Page

export default function Reports() {
  const t = useT();
  const [tab, setTab] = useState("pnl");
  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <PageHeader title={t("Reports", "Rapports")} description={t("Profit, sales, cash and the books.", "Bénéfice, ventes, caisse et comptabilité.")} />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="pnl">{t("Profit & loss", "Résultat")}</TabsTrigger>
            <TabsTrigger value="items">{t("Sales by item", "Ventes par article")}</TabsTrigger>
            <TabsTrigger value="daily">{t("Daily cash", "Caisse du jour")}</TabsTrigger>
            <TabsTrigger value="tb">{t("Trial balance", "Balance")}</TabsTrigger>
            <TabsTrigger value="journal">{t("Journal", "Journal")}</TabsTrigger>
            <TabsTrigger value="ledger">{t("Account ledger", "Grand livre")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="pnl"><ProfitLoss /></TabsContent>
        <TabsContent value="items"><SalesByItem /></TabsContent>
        <TabsContent value="daily"><DailyCash /></TabsContent>
        <TabsContent value="tb"><TrialBalance /></TabsContent>
        <TabsContent value="journal"><Journals /></TabsContent>
        <TabsContent value="ledger"><Ledger /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- (1) Profit & loss

interface PnlRow { accountId: number; code: string; name: string; type: "income" | "cost_of_sales" | "expense"; amount: string }
interface Pnl {
  from: string;
  to: string;
  accounts: PnlRow[];
  totals: { income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string };
}

function ProfitLoss() {
  const t = useT();
  const range = useRange();
  const ok = validDate(range.from) && validDate(range.to);
  const q = useQuery<Pnl>({ queryKey: ["/api/reports/profit-loss", { from: range.from, to: range.to }], enabled: ok });
  const p = q.data;
  const groups: [PnlRow["type"], string, keyof Pnl["totals"]][] = [
    ["income", t("Income", "Recettes"), "income"],
    ["cost_of_sales", t("Cost of sales (items sold, stock losses)", "Coût des ventes (articles vendus, pertes de stock)"), "costOfSales"],
    ["expense", t("Running costs", "Frais de fonctionnement"), "operatingExpenses"],
  ];

  function exportCsv() {
    if (!p) return;
    const rows: unknown[][] = [[t("Group", "Groupe"), t("Code", "Code"), t("Account", "Compte"), t("Amount USD", "Montant USD")]];
    for (const [type, label, key] of groups) {
      for (const a of p.accounts.filter((x) => x.type === type)) rows.push([label, a.code, a.name, a.amount]);
      rows.push([label, "", t("Total", "Total"), p.totals[key]]);
    }
    rows.push(["", "", t("Gross profit", "Marge brute"), p.totals.grossProfit]);
    rows.push(["", "", t("Net profit", "Bénéfice net"), p.totals.netProfit]);
    downloadCsv(`profit-loss_${p.from}_${p.to}.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangePicker range={range} />
        <CsvButton onClick={exportCsv} disabled={!p} />
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {p && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t("Income", "Recettes")} value={usd(p.totals.income)} />
            <StatCard label={t("Gross profit", "Marge brute")} value={usd(p.totals.grossProfit)} tone={d(p.totals.grossProfit).isNegative() ? "bad" : "good"} />
            <StatCard label={t("Running costs", "Frais de fonctionnement")} value={usd(p.totals.operatingExpenses)} />
            <StatCard label={t("Net profit", "Bénéfice net")} value={usd(p.totals.netProfit)} tone={d(p.totals.netProfit).isNegative() ? "bad" : "good"} />
          </div>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableBody>
                    {groups.map(([type, label, key]) => (
                      <Fragment key={type}>
                        <TableRow className="bg-muted/50 hover:bg-muted/50">
                          <TableCell colSpan={2} className="font-semibold">{label}</TableCell>
                        </TableRow>
                        {p.accounts.filter((a) => a.type === type).map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="pl-6"><span className="mr-2 font-mono text-xs text-muted-foreground">{a.code}</span>{a.name}</TableCell>
                            <TableCell className="text-right"><Num>{usd(a.amount)}</Num></TableCell>
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell className="pl-6 font-medium">{t("Total", "Total")} · {label}</TableCell>
                          <TableCell className="text-right font-medium"><Num>{usd(p.totals[key])}</Num></TableCell>
                        </TableRow>
                        {type === "cost_of_sales" && (
                          <TableRow className="border-t-2">
                            <TableCell className="font-semibold">{t("Gross profit (income − cost of sales)", "Marge brute (recettes − coût des ventes)")}</TableCell>
                            <TableCell className="text-right font-semibold"><Num className={cn(d(p.totals.grossProfit).isNegative() && "text-destructive")}>{usd(p.totals.grossProfit)}</Num></TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">{t("Net profit (gross profit − running costs)", "Bénéfice net (marge brute − frais)")}</TableCell>
                      <TableCell className="text-right font-semibold"><Num className={cn(d(p.totals.netProfit).isNegative() && "text-destructive")}>{usd(p.totals.netProfit)}</Num></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            {t("Month-close entries are left out, so closed months still show their real result.", "Les écritures de clôture sont exclues\u00a0: les mois clôturés montrent leur vrai résultat.")}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- (2) Sales by item

interface ItemRow { variantId: number; sku: string; attributes: Record<string, string>; productName: string; categoryName: string | null; qty: string; revenue: string; cogs: string; profit: string }

function margin(r: ItemRow): string | null {
  const rev = d(r.revenue);
  return rev.isZero() ? null : d(r.profit).dividedBy(rev).times(100).toFixed(1);
}

function SalesByItem() {
  const t = useT();
  const range = useRange();
  const [sort, setSort] = useState<"profit" | "revenue">("profit");
  const ok = validDate(range.from) && validDate(range.to);
  const q = useQuery<ItemRow[]>({ queryKey: ["/api/reports/sales-by-product", { from: range.from, to: range.to }], enabled: ok });
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => d(b[sort]).comparedTo(d(a[sort]))), [q.data, sort]);
  const tot = rows.reduce((s, r) => ({ revenue: s.revenue.plus(r.revenue), cogs: s.cogs.plus(r.cogs), profit: s.profit.plus(r.profit) }), { revenue: d(0), cogs: d(0), profit: d(0) });
  const totMargin = tot.revenue.isZero() ? null : tot.profit.dividedBy(tot.revenue).times(100).toFixed(1);

  function exportCsv() {
    downloadCsv(`sales-by-item_${range.from}_${range.to}.csv`, [
      [t("Item", "Article"), t("Size / variant", "Taille / variante"), "SKU", t("Category", "Catégorie"), t("Qty", "Qté"), t("Revenue", "Ventes"), t("Cost", "Coût"), t("Profit", "Bénéfice"), t("Margin %", "Marge %")],
      ...rows.map((r) => [r.productName, variantText(r.attributes), r.sku, r.categoryName ?? "", r.qty, r.revenue, r.cogs, r.profit, margin(r) ?? ""]),
      [t("Total", "Total"), "", "", "", "", tot.revenue.toFixed(2), tot.cogs.toFixed(2), tot.profit.toFixed(2), totMargin ?? ""],
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangePicker range={range} />
        <div className="flex items-end gap-2">
          <Field label={t("Sort by", "Trier par")}>
            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="profit">{t("Profit", "Bénéfice")}</SelectItem>
                <SelectItem value="revenue">{t("Revenue", "Ventes")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <CsvButton onClick={exportCsv} disabled={!rows.length} />
        </div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No sales in this period", "Aucune vente sur cette période")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className={cn("cursor-pointer text-right", sort === "revenue" && "text-foreground")} onClick={() => setSort("revenue")}>{t("Revenue", "Ventes")}{sort === "revenue" ? " ↓" : ""}</TableHead>
                    <TableHead className="text-right">{t("Cost", "Coût")}</TableHead>
                    <TableHead className={cn("cursor-pointer text-right", sort === "profit" && "text-foreground")} onClick={() => setSort("profit")}>{t("Profit", "Bénéfice")}{sort === "profit" ? " ↓" : ""}</TableHead>
                    <TableHead className="text-right">{t("Margin", "Marge")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.variantId}>
                      <TableCell className="min-w-[180px]">
                        <span className="font-medium">{r.productName}</span>
                        <span className="block text-xs text-muted-foreground">{[variantText(r.attributes), r.sku, r.categoryName].filter(Boolean).join(" · ")}</span>
                      </TableCell>
                      <TableCell className="text-right"><Num>{qty(r.qty)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(r.revenue)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(r.cogs)}</Num></TableCell>
                      <TableCell className="text-right"><Num className={cn("font-medium", d(r.profit).isNegative() && "text-destructive")}>{usd(r.profit)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{margin(r) != null ? `${margin(r)}%` : "—"}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{t("Total", "Total")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(tot.revenue.toFixed(2))}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(tot.cogs.toFixed(2))}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(tot.profit.toFixed(2))}</Num></TableCell>
                    <TableCell className="text-right"><Num>{totMargin != null ? `${totMargin}%` : "—"}</Num></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- (3) Daily cash

interface DrawerRow { accountId: number; name: string; currency: string; opening: string; totalIn: string; totalOut: string; closing: string; byType: { type: string; in: string; out: string }[] }
interface Daily { date: string; count: number; total: string; credit: string; returnsCount: number; returnsTotal: string; byAccount: { account_id: number; name: string; currency: string; usd: string; native: string }[]; drawer?: DrawerRow[] }

function DailyCash() {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const q = useQuery<Daily>({ queryKey: ["/api/reports/daily", { date: day }], enabled: validDate(day) });
  const r = q.data;
  const paidUsd = (r?.byAccount ?? []).reduce((s, a) => s.plus(a.usd), d(0));

  function exportCsv() {
    if (!r) return;
    const rows: unknown[][] = [
      [t("Daily cash report", "Rapport de caisse du jour"), r.date],
      [t("Sales", "Ventes"), r.count],
      [t("Total sold USD", "Total vendu USD"), r.total],
      [t("Returns", "Retours"), r.returnsCount, r.returnsTotal],
      [t("Sold on credit USD", "Vendu à crédit USD"), r.credit],
      [],
      [t("Received into", "Reçu dans"), t("Currency", "Devise"), t("Amount (account currency)", "Montant (devise du compte)"), t("USD value", "Valeur USD")],
      ...r.byAccount.map((a) => [a.name, a.currency, a.native, a.usd]),
      [t("Total received", "Total reçu"), "USD", "", paidUsd.toFixed(2)],
    ];
    if (r.drawer) {
      rows.push([]);
      rows.push([t("Drawer count", "Comptage de caisse")]);
      rows.push([t("Box or account", "Caisse ou compte"), t("Currency", "Devise"), t("Opening", "Ouverture"), t("In", "Entrées"), t("Out", "Sorties"), t("Expected at closing", "Attendu à la fermeture")]);
      for (const a of r.drawer) {
        rows.push([a.name, a.currency, a.opening, a.totalIn, a.totalOut, a.closing]);
        for (const b of a.byType) rows.push([`  ${journalTypeLabel(b.type, t)}`, a.currency, "", b.in, b.out, ""]);
      }
    }
    downloadCsv(`daily-cash_${r.date}.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t("Day", "Jour")}>
          <Input type="date" className="w-44" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <CsvButton onClick={exportCsv} disabled={!r} />
          <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!r}>
            <Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}
          </Button>
        </div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {r && (
        <Card className="print-area print-wide">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("Daily cash report", "Rapport de caisse du jour")} · {fmtDate(r.date)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label={t("Sales", "Ventes")} value={r.count} />
              <StatCard label={t("Total sold", "Total vendu")} value={usd(r.total)} />
              <StatCard label={t("Returns", "Retours")} value={`− ${usd(r.returnsTotal)}`} sub={t(`${r.returnsCount} return(s)`, `${r.returnsCount} retour(s)`)} />
              <StatCard label={t("Sold on credit", "Vendu à crédit")} value={usd(r.credit)} />
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Received into", "Reçu dans")}</TableHead>
                    <TableHead className="text-right">{t("Amount (account currency)", "Montant (devise du compte)")}</TableHead>
                    <TableHead className="text-right">{t("USD value", "Valeur USD")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byAccount.length === 0 && (
                    <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">{t("No payments", "Aucun paiement")}</TableCell></TableRow>
                  )}
                  {r.byAccount.map((a) => (
                    <TableRow key={a.account_id}>
                      <TableCell className="font-medium">{a.name}</TableCell>
                      <TableCell className="text-right"><Num>{money(a.native, a.currency)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(a.usd)}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{t("Total received", "Total reçu")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(paidUsd.toFixed(2))}</Num></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Sales payments only. The drawer count below includes everything else.", "Paiements des ventes seulement. Le comptage de caisse ci-dessous inclut tout le reste.")}
            </p>
            {r.drawer && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t("Drawer count", "Comptage de caisse")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Opening balance, everything in and out that day (sales, refunds, debt payments, expenses, transfers…) and what should be in each box at closing. Count the cash and compare.",
                    "Solde d'ouverture, tout ce qui est entré et sorti ce jour-là (ventes, remboursements, paiements de dettes, dépenses, transferts…) et ce qui doit se trouver dans chaque caisse à la fermeture. Comptez l'argent et comparez.",
                  )}
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Box or account", "Caisse ou compte")}</TableHead>
                        <TableHead className="text-right">{t("Opening", "Ouverture")}</TableHead>
                        <TableHead className="text-right">{t("In", "Entrées")}</TableHead>
                        <TableHead className="text-right">{t("Out", "Sorties")}</TableHead>
                        <TableHead className="text-right">{t("Expected at closing", "Attendu à la fermeture")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.drawer.map((a) => (
                        <TableRow key={a.accountId}>
                          <TableCell>
                            <span className="font-medium">{a.name}</span>
                            {a.byType.length > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {a.byType.map((b) => `${journalTypeLabel(b.type, t)}: ${d(b.in).gt(0) ? `+${money(b.in, a.currency)}` : ""}${d(b.in).gt(0) && d(b.out).gt(0) ? " " : ""}${d(b.out).gt(0) ? `−${money(b.out, a.currency)}` : ""}`).join(" · ")}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right"><Num>{money(a.opening, a.currency)}</Num></TableCell>
                          <TableCell className="text-right"><Num>{money(a.totalIn, a.currency)}</Num></TableCell>
                          <TableCell className="text-right"><Num>{money(a.totalOut, a.currency)}</Num></TableCell>
                          <TableCell className="text-right font-semibold"><Num>{money(a.closing, a.currency)}</Num></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- (4) Trial balance

interface TbRow extends Account { balance: string }
interface Tb { asOf: string | null; rows: TbRow[]; totalDebit: string; totalCredit: string; balanced: boolean }

function TrialBalance() {
  const t = useT();
  const [asOf, setAsOf] = useState(todayLocal());
  const q = useQuery<Tb>({ queryKey: ["/api/reports/trial-balance", { asOf }], enabled: validDate(asOf) });
  const tb = q.data;

  function exportCsv() {
    if (!tb) return;
    downloadCsv(`trial-balance_${asOf}.csv`, [
      [t("Code", "Code"), t("Account", "Compte"), t("Type", "Type"), t("Debit", "Débit"), t("Credit", "Crédit")],
      ...tb.rows.map((r) => {
        const b = d(r.balance);
        return [r.code, r.name, accountTypeLabel(r.type, t), b.isPositive() ? b.toFixed(2) : "", b.isNegative() ? b.abs().toFixed(2) : ""];
      }),
      ["", t("Total", "Total"), "", tb.totalDebit, tb.totalCredit],
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t("As of", "Au")}>
          <Input type="date" className="w-44" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2">
          {tb && (
            <Badge variant={tb.balanced ? "default" : "destructive"}>
              {tb.balanced ? t("Balanced ✓", "Équilibrée ✓") : t("Not balanced", "Non équilibrée")}
            </Badge>
          )}
          <CsvButton onClick={exportCsv} disabled={!tb} />
        </div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {tb && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Account", "Compte")}</TableHead>
                    <TableHead>{t("Type", "Type")}</TableHead>
                    <TableHead className="text-right">{t("Debit", "Débit")}</TableHead>
                    <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tb.rows.map((r) => {
                    const b = d(r.balance);
                    return (
                      <TableRow key={r.id}>
                        <TableCell><span className="mr-2 font-mono text-xs text-muted-foreground">{r.code}</span>{r.name}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{accountTypeLabel(r.type, t)}</TableCell>
                        <TableCell className="text-right"><Num>{b.isPositive() ? usd(b.toFixed(2)) : ""}</Num></TableCell>
                        <TableCell className="text-right"><Num>{b.isNegative() ? usd(b.abs().toFixed(2)) : ""}</Num></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{t("Total", "Total")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(tb.totalDebit)}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(tb.totalCredit)}</Num></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- (5) Journal

interface JournalLine { id: number; accountId: number; accountName: string; accountCode: string; partyName: string | null; debit: string; credit: string; currency: string; nativeAmount: string | null; rate: string | null; memo: string | null }
interface Journal { id: number; number: string; date: string; type: string; memo: string | null; reversesJournalId: number | null; reversedByJournalId: number | null; lines: JournalLine[] }

const JOURNAL_TYPES = ["opening", "manual", "sale", "sale_void", "sale_return", "customer_receipt", "supplier_payment", "container_expense", "container_finalize", "container_reversal", "expense", "transfer", "partner_contribution", "partner_withdrawal", "stock_adjustment", "payment", "receipt", "payroll", "revaluation", "period_close", "reversal"];
const REVERSIBLE = ["manual", "opening", "transfer", "customer_receipt", "supplier_payment", "partner_contribution", "partner_withdrawal"];

function Journals() {
  const t = useT();
  const { can } = useAuth();
  const range = useRange();
  const [type, setType] = useState("all");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [reversing, setReversing] = useState<Journal | null>(null);
  const [adding, setAdding] = useState(false);
  const ok = validDate(range.from) && validDate(range.to);
  const q = useQuery<Journal[]>({ queryKey: ["/api/journals", { from: range.from, to: range.to, type: type === "all" ? undefined : type }], enabled: ok });
  const rows = q.data ?? [];
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function exportCsv() {
    const out: unknown[][] = [[
      t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Memo", "Libellé"),
      t("Code", "Code"), t("Account", "Compte"), t("Party", "Tiers"),
      t("Debit USD", "Débit USD"), t("Credit USD", "Crédit USD"), t("Currency", "Devise"), t("Native amount", "Montant en devise"), t("Rate", "Taux"), t("Line memo", "Libellé de ligne"),
    ]];
    for (const j of rows) {
      for (const l of j.lines) {
        out.push([j.date, j.number, journalTypeLabel(j.type, t), j.memo ?? "", l.accountCode, l.accountName, l.partyName ?? "", l.debit, l.credit, l.currency, l.nativeAmount ?? "", l.rate ?? "", l.memo ?? ""]);
      }
    }
    downloadCsv(`journal_${range.from}_${range.to}${type === "all" ? "" : `_${type}`}.csv`, out);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <RangePicker range={range} />
          <Field label={t("Type", "Type")}>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All types", "Tous les types")}</SelectItem>
                {JOURNAL_TYPES.map((x) => <SelectItem key={x} value={x}>{journalTypeLabel(x, t)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CsvButton onClick={exportCsv} disabled={!rows.length} />
          {can() && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-4 w-4" /> {t("Manual entry", "Écriture manuelle")}
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No entries", "Aucune écriture")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t("Date", "Date")}</TableHead>
                    <TableHead>{t("No.", "N°")}</TableHead>
                    <TableHead>{t("Type", "Type")}</TableHead>
                    <TableHead>{t("Details", "Détails")}</TableHead>
                    <TableHead className="text-right">{t("Amount", "Montant")}</TableHead>
                    {can() && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((j) => {
                    const total = j.lines.reduce((s, l) => s.plus(l.debit), d(0));
                    const isOpen = open.has(j.id);
                    const reversible = REVERSIBLE.includes(j.type) && !j.reversedByJournalId && !j.reversesJournalId;
                    return (
                      <Fragment key={j.id}>
                        <TableRow className="cursor-pointer" onClick={() => toggle(j.id)}>
                          <TableCell>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                          <TableCell className="whitespace-nowrap">{fmtDate(j.date)}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{j.number}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {journalTypeLabel(j.type, t)}
                            {j.reversedByJournalId && <Badge variant="secondary" className="ml-2">{t("Reversed", "Annulée")}</Badge>}
                          </TableCell>
                          <TableCell className="min-w-[180px]">{j.memo}</TableCell>
                          <TableCell className="text-right"><Num>{usd(total.toFixed(2))}</Num></TableCell>
                          {can() && (
                            <TableCell onClick={(e) => e.stopPropagation()}>
                              {reversible && (
                                <Button size="sm" variant="ghost" onClick={() => setReversing(j)}>
                                  <RotateCcw className="mr-1 h-4 w-4" /> {t("Reverse", "Annuler")}
                                </Button>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={can() ? 6 : 5} className="p-2">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>{t("Account", "Compte")}</TableHead>
                                    <TableHead>{t("Contact", "Contact")}</TableHead>
                                    <TableHead className="text-right">{t("Debit", "Débit")}</TableHead>
                                    <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                                    <TableHead className="text-right">CDF</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {j.lines.map((l) => (
                                    <TableRow key={l.id}>
                                      <TableCell><span className="mr-2 font-mono text-xs text-muted-foreground">{l.accountCode}</span>{l.accountName}{l.memo ? <span className="block text-xs text-muted-foreground">{l.memo}</span> : null}</TableCell>
                                      <TableCell>{l.partyName}</TableCell>
                                      <TableCell className="text-right"><Num>{d(l.debit).isZero() ? "" : usd(l.debit)}</Num></TableCell>
                                      <TableCell className="text-right"><Num>{d(l.credit).isZero() ? "" : usd(l.credit)}</Num></TableCell>
                                      <TableCell className="text-right text-xs text-muted-foreground">
                                        <Num>{l.nativeAmount != null ? `${cdf(l.nativeAmount)}${l.rate ? ` @ ${d(l.rate).toString()}` : ""}` : ""}</Num>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
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
      )}
      {rows.length >= 300 && <p className="text-xs text-muted-foreground">{t("Showing the latest 300 entries. Narrow the dates to see more.", "Les 300 dernières écritures. Réduisez la période pour voir plus.")}</p>}
      {reversing && <ReverseDialog journal={reversing} onClose={() => setReversing(null)} />}
      {adding && <ManualJournalDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function ReverseDialog({ journal, onClose }: { journal: Journal; onClose: () => void }) {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const m = useApiMutation("POST", `/api/journals/${journal.id}/reverse`, { success: t("Entry reversed", "Écriture annulée"), onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Reverse entry", "Annuler l'écriture")} {journal.number}</DialogTitle>
          <DialogDescription>
            {t("An opposite entry is posted on the date you choose. The original stays visible.", "Une écriture inverse est passée à la date choisie. L'originale reste visible.")}
          </DialogDescription>
        </DialogHeader>
        <Field label={t("Date", "Date")}>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button variant="destructive" disabled={!validDate(day) || m.isPending} onClick={() => m.mutate({ date: day })}>{t("Reverse", "Annuler l'écriture")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DraftLine { key: number; accountId: number | null; partyId: number | null; debit: string; credit: string; native: string; rate: string }

let lineKey = 1;
const blankLine = (): DraftLine => ({ key: lineKey++, accountId: null, partyId: null, debit: "", credit: "", native: "", rate: "" });

function ManualJournalDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const accountsQ = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const accounts = accountsQ.data ?? [];
  const [day, setDay] = useState(todayLocal());
  const [memo, setMemo] = useState("");
  const [opening, setOpening] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([blankLine(), blankLine()]);
  const m = useApiMutation("POST", "/api/journals", { success: t("Entry saved", "Écriture enregistrée"), onSuccess: onClose });
  const set = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const acc = (id: number | null) => accounts.find((a) => a.id === id);
  const partyTypes = (a?: Account): ("customer" | "supplier" | "agent" | "employee")[] | null =>
    a?.systemKey === "receivables" ? ["customer"] : a?.systemKey === "payables" ? ["supplier", "agent", "employee"] : null;
  const isCdf = (a?: Account) => !!a && a.isMoney && a.currency === "CDF";

  const totalDebit = lines.reduce((s, l) => s.plus(d(l.debit).toDecimalPlaces(2)), d(0));
  const totalCredit = lines.reduce((s, l) => s.plus(d(l.credit).toDecimalPlaces(2)), d(0));
  const diff = totalDebit.minus(totalCredit);
  const problems: string[] = [];
  if (!memo.trim()) problems.push(t("Add a description", "Ajoutez une description"));
  if (lines.some((l) => !l.accountId)) problems.push(t("Choose an account on every line", "Choisissez un compte sur chaque ligne"));
  if (lines.some((l) => d(l.debit).gt(0) && d(l.credit).gt(0))) problems.push(t("A line is either debit or credit", "Une ligne est soit au débit soit au crédit"));
  if (lines.some((l) => partyTypes(acc(l.accountId)) && !l.partyId)) problems.push(t("Pick the customer or supplier on receivable/payable lines", "Choisissez le client ou fournisseur sur les lignes créances/dettes"));
  if (lines.some((l) => isCdf(acc(l.accountId)) && (!d(l.native).gt(0) || !d(l.rate).gt(0)))) problems.push(t("CDF accounts need the CDF amount and the rate", "Les comptes en CDF ont besoin du montant en FC et du taux"));
  if (totalDebit.isZero()) problems.push(t("Enter some amounts", "Saisissez des montants"));
  if (!diff.isZero()) problems.push(t("Debits and credits must be equal", "Les débits et crédits doivent être égaux"));

  function setNative(l: DraftLine, native: string, rate: string) {
    const usdValue = d(rate).gt(0) && d(native).gt(0) ? d(native).dividedBy(d(rate)).toFixed(2) : "";
    if (d(l.credit).gt(0)) set(l.key, { native, rate, credit: usdValue });
    else set(l.key, { native, rate, debit: usdValue });
  }

  function save() {
    m.mutate({
      date: day,
      memo: memo.trim(),
      type: opening ? "opening" : "manual",
      lines: lines.map((l) => {
        const a = acc(l.accountId);
        return {
          accountId: l.accountId,
          debit: d(l.debit).gt(0) ? d(l.debit).toFixed(2) : null,
          credit: d(l.credit).gt(0) ? d(l.credit).toFixed(2) : null,
          partyId: partyTypes(a) ? l.partyId : null,
          ...(isCdf(a) ? { nativeAmount: d(l.native).toFixed(2), rate: d(l.rate).toString() } : {}),
        };
      }),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Manual entry", "Écriture manuelle")}</DialogTitle>
          <DialogDescription>
            {t("For corrections the other screens cannot make. Stock and container accounts cannot be used here.", "Pour les corrections impossibles depuis les autres écrans. Les comptes de stock et de conteneurs ne sont pas autorisés ici.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label={t("Date", "Date")}><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field label={t("Description", "Description")}><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={opening} onCheckedChange={setOpening} />
          {t("Opening balance (cash, debts and capital you start with)", "Solde d'ouverture (caisse, dettes et capital de départ)")}
        </label>
        <div className="space-y-3">
          {lines.map((l, i) => {
            const a = acc(l.accountId);
            const pt = partyTypes(a);
            return (
              <div key={l.key} className="rounded-lg border p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_7rem_auto]">
                  <Field label={`${t("Account", "Compte")} ${i + 1}`}>
                    <AccountSelect value={l.accountId} onChange={(id) => set(l.key, { accountId: id, partyId: null, native: "", rate: "" })} />
                  </Field>
                  <Field label={t("Debit USD", "Débit USD")}>
                    <Input inputMode="decimal" value={l.debit} onChange={(e) => set(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                  </Field>
                  <Field label={t("Credit USD", "Crédit USD")}>
                    <Input inputMode="decimal" value={l.credit} onChange={(e) => set(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                  </Field>
                  <div className="flex items-end">
                    <Button variant="ghost" size="icon" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t("Remove", "Retirer")}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {pt && (
                  <div className="mt-2">
                    <Field label={pt[0] === "customer" ? t("Customer", "Client") : t("Supplier or agent", "Fournisseur ou agent")}>
                      <PartySelect types={pt} value={l.partyId} onChange={(id) => set(l.key, { partyId: id })} allowCreate={false} />
                    </Field>
                  </div>
                )}
                {isCdf(a) && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Field label={t("Amount in CDF", "Montant en FC")}>
                      <Input inputMode="decimal" value={l.native} onChange={(e) => setNative(l, e.target.value, l.rate)} />
                    </Field>
                    <Field label={t("Rate (CDF per 1 USD)", "Taux (FC pour 1 USD)")}>
                      <Input inputMode="decimal" value={l.rate} onChange={(e) => setNative(l, l.native, e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            <Plus className="mr-1 h-4 w-4" /> {t("Add line", "Ajouter une ligne")}
          </Button>
        </div>
        <div className="flex flex-wrap justify-end gap-4 rounded-lg bg-muted p-3 text-sm">
          <span>{t("Debits", "Débits")}: <Num className="font-medium">{usd(totalDebit.toFixed(2))}</Num></span>
          <span>{t("Credits", "Crédits")}: <Num className="font-medium">{usd(totalCredit.toFixed(2))}</Num></span>
          <span className={cn("font-semibold", diff.isZero() ? "text-green-700 dark:text-green-400" : "text-destructive")}>
            {t("Difference", "Écart")}: <Num>{usd(diff.toFixed(2))}</Num>
          </span>
        </div>
        {problems.length > 0 && <p className="text-xs text-muted-foreground">{problems[0]}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button disabled={problems.length > 0 || m.isPending} onClick={save}>{t("Save entry", "Enregistrer l'écriture")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- (6) Account ledger

interface LedgerRow { journalId: number; number: string; date: string; type: string; memo: string | null; lineMemo: string | null; debit: string; credit: string; nativeAmount: string | null; rate: string | null; partyName: string | null; balance: string; nativeBalance: string | null }
interface LedgerData { account: Account; from: string; to: string; openingBalance: string; openingNative: string | null; rows: LedgerRow[]; closingBalance: string; closingNative: string | null }

function Ledger() {
  const t = useT();
  const range = useRange();
  const [accountId, setAccountId] = useState<number | null>(null);
  const accountsQ = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  useEffect(() => {
    if (!accountId && accountsQ.data?.length) {
      const first = accountsQ.data.find((a) => a.isMoney && a.active) ?? accountsQ.data[0];
      setAccountId(first.id);
    }
  }, [accountsQ.data, accountId]);
  const ok = !!accountId && validDate(range.from) && validDate(range.to);
  const q = useQuery<LedgerData>({ queryKey: [`/api/accounts/${accountId}/ledger`, { from: range.from, to: range.to }], enabled: ok });
  const L = q.data;
  const cdfAcc = L?.account.currency === "CDF" && L.account.isMoney;

  function exportCsv() {
    if (!L) return;
    const head = [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Détails"), t("Party", "Tiers"), t("Debit USD", "Débit USD"), t("Credit USD", "Crédit USD"), t("Balance USD", "Solde USD")];
    if (cdfAcc) head.push("CDF", t("CDF balance", "Solde CDF"));
    const rows: unknown[][] = [
      [`${L.account.code} · ${L.account.name}`],
      head,
      [L.from, "", "", t("Opening balance", "Solde d'ouverture"), "", "", "", L.openingBalance, ...(cdfAcc ? ["", L.openingNative ?? ""] : [])],
      ...L.rows.map((r) => [r.date, r.number, journalTypeLabel(r.type, t), r.lineMemo || r.memo || "", r.partyName ?? "", r.debit, r.credit, r.balance, ...(cdfAcc ? [r.nativeAmount ?? "", r.nativeBalance ?? ""] : [])]),
      [L.to, "", "", t("Closing balance", "Solde de clôture"), "", "", "", L.closingBalance, ...(cdfAcc ? ["", L.closingNative ?? ""] : [])],
    ];
    downloadCsv(`ledger_${L.account.code}_${L.from}_${L.to}.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("Account", "Compte")} className="w-full sm:w-72">
            <AccountSelect value={accountId} onChange={setAccountId} />
          </Field>
          <RangePicker range={range} />
        </div>
        <CsvButton onClick={exportCsv} disabled={!L} />
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {L && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{L.account.code} · {L.account.name}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {accountTypeLabel(L.account.type, t)} · {t("Balances are debit minus credit", "Soldes = débit moins crédit")}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date", "Date")}</TableHead>
                    <TableHead>{t("No.", "N°")}</TableHead>
                    <TableHead>{t("Details", "Détails")}</TableHead>
                    <TableHead className="text-right">{t("Debit", "Débit")}</TableHead>
                    <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                    {cdfAcc && <TableHead className="text-right">CDF</TableHead>}
                    <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="bg-muted/40">
                    <TableCell colSpan={5} className="font-medium">{t("Opening balance", "Solde d'ouverture")} · {fmtDate(L.from)}</TableCell>
                    {cdfAcc && <TableCell className="text-right"><Num>{cdf(L.openingNative)}</Num></TableCell>}
                    <TableCell className="text-right font-medium"><Num>{usd(L.openingBalance)}</Num></TableCell>
                  </TableRow>
                  {L.rows.map((r, i) => (
                    <TableRow key={`${r.journalId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{r.number}</TableCell>
                      <TableCell className="min-w-[180px]">
                        {r.lineMemo || r.memo}
                        <span className="block text-xs text-muted-foreground">{[journalTypeLabel(r.type, t), r.partyName].filter(Boolean).join(" · ")}</span>
                      </TableCell>
                      <TableCell className="text-right"><Num>{d(r.debit).isZero() ? "" : usd(r.debit)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{d(r.credit).isZero() ? "" : usd(r.credit)}</Num></TableCell>
                      {cdfAcc && <TableCell className="text-right text-xs"><Num>{r.nativeAmount != null ? cdf(r.nativeAmount) : ""}<span className="block text-muted-foreground">{r.nativeBalance != null ? cdf(r.nativeBalance) : ""}</span></Num></TableCell>}
                      <TableCell className="text-right"><Num>{usd(r.balance)}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{t("Closing balance", "Solde de clôture")} · {fmtDate(L.to)}</TableCell>
                    {cdfAcc && <TableCell className="text-right"><Num>{cdf(L.closingNative)}</Num></TableCell>}
                    <TableCell className="text-right"><Num>{usd(L.closingBalance)}</Num></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
