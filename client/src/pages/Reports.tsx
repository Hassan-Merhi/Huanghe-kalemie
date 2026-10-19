import { Fragment, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
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
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard, SubmitButton } from "@/components/common";
import { AccountSelect, PartySelect, useAccounts } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { downloadCsv } from "@/lib/sheets";
import { count, useT } from "@/lib/i18n";
import { cdf, curLabel, d, pct, date as fmtDate, money, monthStart, previousMonth, qty, todayLocal, usd, variantText } from "@/lib/format";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WIDE_PRINT_CSS, journalTypeLabel } from "@/pages/ContactDetail";
import { useSystemText } from "@/lib/systemText";

/** A balanced report reads as good news: green, not the orange of buttons. */
const BALANCED = "border-green-700/40 bg-green-50 text-green-800 dark:border-green-400/40 dark:bg-green-950/40 dark:text-green-300";

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

/** One line under a report tab saying what the report answers. */
function TabNote({ children }: { children: string }) {
  return <p className="mb-3 text-sm text-muted-foreground">{children}</p>;
}

export default function Reports() {
  const t = useT();
  const search = useSearch();
  const [tab, setTab] = useState(() => new URLSearchParams(search).get("tab") ?? "pnl");
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
            <TabsTrigger value="bs">{t("Balance sheet", "Bilan")}</TabsTrigger>
            <TabsTrigger value="tb">{t("Trial balance", "Balance")}</TabsTrigger>
            <TabsTrigger value="journal">{t("Journal", "Journal")}</TabsTrigger>
            <TabsTrigger value="ledger">{t("Account ledger", "Grand livre")}</TabsTrigger>
            <TabsTrigger value="ageing">{t("Who owes us", "Âge des créances")}</TabsTrigger>
            <TabsTrigger value="checks">{t("Self-check", "Contrôles")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="pnl"><TabNote>{t("What the shop earned in the period: sales minus the cost of the goods sold and the running costs.", "Ce que la boutique a gagné sur la période\u00a0: les ventes moins le coût des articles vendus et les frais de fonctionnement.")}</TabNote><ProfitLoss /></TabsContent>
        <TabsContent value="items"><TabNote>{t("Which items sold, how many, and what each one earned after its cost.", "Quels articles se sont vendus, combien, et ce que chacun a rapporté après son coût.")}</TabNote><SalesByItem /></TabsContent>
        <TabsContent value="daily"><TabNote>{t("One day at the till: sales by payment type, then what each cash box and account should hold at closing.", "Une journée de caisse\u00a0: les ventes par moyen de paiement, puis ce que chaque caisse et compte doit contenir à la fermeture.")}</TabNote><DailyCash /></TabsContent>
        <TabsContent value="bs"><TabNote>{t("What the shop owns, what it owes, and what is left for the partners, on a date.", "Ce que la boutique possède, ce qu'elle doit, et ce qui revient aux associés, à une date.")}</TabNote><BalanceSheet /></TabsContent>
        <TabsContent value="tb"><TabNote>{t("Every account's balance on a date. Both columns must be equal: that proves nothing is missing from the books.", "Le solde de chaque compte à une date. Les deux colonnes doivent être égales\u00a0: cela prouve que rien ne manque dans les comptes.")}</TabNote><TrialBalance /></TabsContent>
        <TabsContent value="journal"><TabNote>{t("Every entry in date order, with the accounts each one moved.", "Toutes les écritures par date, avec les comptes que chacune a touchés.")}</TabNote><Journals /></TabsContent>
        <TabsContent value="ledger"><TabNote>{t("Everything that went through one account, line by line, with the running balance.", "Tout ce qui est passé par un compte, ligne par ligne, avec le solde au fur et à mesure.")}</TabNote><Ledger /></TabsContent>
        <TabsContent value="ageing"><TabNote>{t("Each customer who owes money, split by how long it has been owed. Payments clear the oldest amounts first.", "Chaque client qui doit de l'argent, réparti selon depuis combien de temps. Les paiements soldent d'abord les montants les plus anciens.")}</TabNote><Ageing /></TabsContent>
        <TabsContent value="checks"><TabNote>{t("The figures that must always agree, recomputed now. Anything in red needs a look.", "Les chiffres qui doivent toujours concorder, recalculés maintenant. Ce qui est en rouge est à vérifier.")}</TabNote><SelfCheck /></TabsContent>
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
  const sys = useSystemText();
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
    const rows: unknown[][] = [[t("Group", "Groupe"), t("Code", "Code"), t("Account", "Compte"), t("Amount ($)", "Montant ($)")]];
    for (const [type, label, key] of groups) {
      for (const a of p.accounts.filter((x) => x.type === type)) rows.push([label, a.code, sys.account(a.name), a.amount]);
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
                            <TableCell className="pl-6"><span className="mr-2 font-mono text-xs text-muted-foreground">{a.code}</span>{sys.account(a.name)}</TableCell>
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
                      {/* On a phone the label runs across the card, the amount under it, like the rows above. */}
                      <TableCell className="font-semibold max-sm:col-span-2">{t("Net profit (gross profit − running costs)", "Bénéfice net (marge brute − frais)")}</TableCell>
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
      [t("Item", "Article"), t("Size / variant", "Taille / variante"), t("SKU", "Code"), t("Category", "Catégorie"), t("Qty", "Qté"), t("Revenue", "Ventes"), t("Cost", "Coût"), t("Profit", "Bénéfice"), t("Margin %", "Marge %")],
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
                      <TableCell className="text-right"><Num>{margin(r) != null ? pct(margin(r), 1, 1) : "—"}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{t("Total", "Total")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(tot.revenue.toFixed(2))}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(tot.cogs.toFixed(2))}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(tot.profit.toFixed(2))}</Num></TableCell>
                    <TableCell className="text-right"><Num>{totMargin != null ? pct(totMargin, 1, 1) : "—"}</Num></TableCell>
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
interface Daily { date: string; count: number; total: string; netCount?: number; netTotal?: string; credit: string; creditOnAvoirUsd?: string; voidsCount: number; voidsTotal: string; returnsCount: number; returnsTotal: string; byAccount: { account_id: number; name: string; currency: string; usd: string; native: string; received_native?: string; change_native?: string; refund_native?: string }[]; drawer?: DrawerRow[] }

function DailyCash() {
  const t = useT();
  const sys = useSystemText();
  const [day, setDay] = useState(todayLocal());
  const q = useQuery<Daily>({ queryKey: ["/api/reports/daily", { date: day }], enabled: validDate(day) });
  const r = q.data;
  const paidUsd = (r?.byAccount ?? []).reduce((s, a) => s.plus(a.usd), d(0));
  // Credit an avoir covered is not owed: it reads apart from "À crédit", as on the Sales list and the sale page.
  const onAvoir = r ? Decimal.max(Decimal.min(d(r.creditOnAvoirUsd ?? 0), d(r.credit)), 0) : d(0);
  const owedCredit = r ? d(r.credit).minus(onAvoir) : d(0);

  function exportCsv() {
    if (!r) return;
    const rows: unknown[][] = [
      [t("Daily cash report", "Rapport de caisse du jour"), r.date],
      [t("Sales", "Ventes"), r.netCount ?? r.count],
      [t("Total sold, net ($)", "Total vendu net ($)"), r.netTotal ?? r.total],
      [t("Gross sales, cancelled ones included ($)", "Ventes brutes, annulées comprises ($)"), r.count, r.total],
      [t("Cancellations", "Annulations"), r.voidsCount, r.voidsTotal],
      [t("Returns", "Retours"), r.returnsCount, r.returnsTotal],
      [t("On credit ($)", "À crédit ($)"), owedCredit.toFixed(2)],
      [t("From customers' credit ($)", "Sur l'avoir ($)"), onAvoir.toFixed(2)],
      [],
      [t("Received into", "Reçu dans"), t("Currency", "Devise"), t("Handed over", "Reçu"), t("Change given", "Monnaie rendue"), t("Refunds", "Remboursements"), t("Kept", "Gardé"), t("Value in $ (rates used)", "Valeur en $ (taux appliqués)")],
      ...r.byAccount.map((a) => [sys.account(a.name), curLabel(a.currency), a.received_native ?? a.native, a.change_native ?? "0", a.refund_native ?? "0", a.native, a.usd]),
      [t("Total kept", "Total gardé"), "$", "", "", "", "", paidUsd.toFixed(2)],
    ];
    if (r.drawer) {
      rows.push([]);
      rows.push([t("Drawer count", "Comptage de caisse")]);
      rows.push([t("Box or account", "Caisse ou compte"), t("Currency", "Devise"), t("Opening", "Ouverture"), t("In", "Entrées"), t("Out", "Sorties"), t("Expected at closing", "Attendu à la fermeture")]);
      for (const a of r.drawer) {
        rows.push([sys.account(a.name), a.currency, a.opening, a.totalIn, a.totalOut, a.closing]);
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
            <div className={cn("grid grid-cols-2 gap-3", onAvoir.gt(0) ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-4")}>
              {/* Led by the sales still standing less the day's returns, the dashboard's and the Sales list's figure;
                  the gross sales, cancelled ones included, read below it with the day's cancellations. */}
              <StatCard
                dense={onAvoir.gt(0)}
                label={t("Sales", "Ventes")}
                value={r.netCount ?? r.count}
                sub={r.netCount != null && r.count > r.netCount ? `+ ${count(t, r.count - r.netCount, ["cancelled", "cancelled"], ["annulée", "annulées"])}` : undefined}
              />
              <StatCard
                dense={onAvoir.gt(0)}
                label={t("Total sold", "Total vendu")}
                value={usd(r.netTotal ?? r.total)}
                sub={r.netTotal != null && (r.voidsCount > 0 || !d(r.total).eq(r.netTotal)) ? (
                  <>
                    <div>{t("gross", "brut")} {usd(r.total)}</div>
                    {r.voidsCount > 0 && <div>{count(t, r.voidsCount, ["cancellation", "cancellations"], ["annulation", "annulations"])} −{usd(r.voidsTotal)}</div>}
                    {d(r.returnsTotal).gt(0) && <div>{t("returns", "retours")} −{usd(r.returnsTotal)}</div>}
                  </>
                ) : undefined}
              />
              <StatCard dense={onAvoir.gt(0)} label={t("Returns", "Retours")} value={d(r.returnsTotal).gt(0) ? `−${usd(r.returnsTotal)}` : usd(r.returnsTotal)} sub={count(t, r.returnsCount, ["return", "returns"], ["retour", "retours"])} />
              <StatCard dense={onAvoir.gt(0)} label={t("On credit", "À crédit")} value={usd(owedCredit.toFixed(2))} />
              {onAvoir.gt(0) && <StatCard dense={onAvoir.gt(0)} label={t("From customers' credit", "Sur l'avoir")} value={usd(onAvoir.toFixed(2))} sub={t("paid ahead, nothing owed", "payé d'avance, rien de dû")} />}
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Received into", "Reçu dans")}</TableHead>
                    <TableHead className="text-right">{t("Handed over", "Reçu")}</TableHead>
                    <TableHead className="text-right">{t("Change given", "Monnaie rendue")}</TableHead>
                    <TableHead className="text-right">{t("Refunds", "Remboursements")}</TableHead>
                    <TableHead className="text-right">{t("Kept", "Gardé")}</TableHead>
                    <TableHead className="text-right">{t("Value in $ (rates used)", "Valeur en $ (taux appliqués)")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byAccount.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">{t("No payments", "Aucun paiement")}</TableCell></TableRow>
                  )}
                  {r.byAccount.map((a) => (
                    <TableRow key={a.account_id}>
                      <TableCell className="font-medium">{sys.account(a.name)}</TableCell>
                      <TableCell className="text-right"><Num>{money(a.received_native ?? a.native, a.currency)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{d(a.change_native).isZero() ? "—" : `−${money(a.change_native, a.currency)}`}</Num></TableCell>
                      <TableCell className="text-right"><Num>{d(a.refund_native).isZero() ? "—" : `−${money(a.refund_native, a.currency)}`}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-medium">{money(a.native, a.currency)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(a.usd)}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{t("Total kept", "Total gardé")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(paidUsd.toFixed(2))}</Num></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Sales payments and refunds only. The drawer count below includes everything else.", "Paiements et remboursements des ventes seulement. Le comptage de caisse ci-dessous inclut tout le reste.")}
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
                            <span className="font-medium">{sys.account(a.name)}</span>
                            {a.byType.length > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {a.byType.map((b) => `${journalTypeLabel(b.type, t)}${t(":", "\u00a0:")} ${d(b.in).gt(0) ? `+${money(b.in, a.currency)}` : ""}${d(b.in).gt(0) && d(b.out).gt(0) ? " " : ""}${d(b.out).gt(0) ? `−${money(b.out, a.currency)}` : ""}`).join(" · ")}
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

// ---------------------------------------------------------------- Customer ageing

interface AgeingData {
  asOf: string;
  rows: { partyId: number; name: string; phone: string | null; balance: string; current: string; d31_60: string; d61_90: string; over90: string; oldestDate: string | null }[];
  totals: { balance: string; current: string; d31_60: string; d61_90: string; over90: string };
}

function Ageing() {
  const t = useT();
  const [asOf, setAsOf] = useState(todayLocal());
  const q = useQuery<AgeingData>({ queryKey: ["/api/reports/ageing", { asOf }], enabled: validDate(asOf) });
  const a = q.data;
  const cell = (v: string, warn = false) => (d(v).isZero() ? <span className="text-muted-foreground">—</span> : <Num className={warn ? "font-medium text-destructive" : undefined}>{usd(v)}</Num>);
  function exportCsv() {
    if (!a) return;
    downloadCsv(`ageing_${a.asOf}.csv`, [
      [t("Customer", "Client"), t("Phone", "Téléphone"), t("Owes", "Doit"), t("0–30 days", "0–30 jours"), t("31–60 days", "31–60 jours"), t("61–90 days", "61–90 jours"), t("Over 90 days", "Plus de 90 jours"), t("Oldest", "Plus ancien")],
      ...a.rows.map((r) => [r.name, r.phone ?? "", r.balance, r.current, r.d31_60, r.d61_90, r.over90, r.oldestDate ?? ""]),
    ]);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t("On", "Au")}><Input type="date" className="w-44" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <CsvButton onClick={exportCsv} disabled={!a?.rows.length} />
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {a && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatCard label={t("Owed to us", "On nous doit")} value={usd(a.totals.balance)} sub={count(t, a.rows.length, ["customer", "customers"], ["client", "clients"])} />
            <StatCard label={t("0–30 days", "0–30 jours")} value={usd(a.totals.current)} />
            <StatCard label={t("31–60 days", "31–60 jours")} value={usd(a.totals.d31_60)} />
            <StatCard label={t("61–90 days", "61–90 jours")} value={usd(a.totals.d61_90)} />
            <StatCard label={t("Over 90 days", "Plus de 90 jours")} value={usd(a.totals.over90)} tone={d(a.totals.over90).gt(0) ? "bad" : undefined} />
          </div>
          {a.rows.length === 0 ? (
            <EmptyState title={t("No customer owes anything", "Aucun client ne doit rien")} />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Customer", "Client")}</TableHead>
                      <TableHead className="text-right">{t("Owes", "Doit")}</TableHead>
                      <TableHead className="text-right">{t("0–30 days", "0–30 jours")}</TableHead>
                      <TableHead className="text-right">{t("31–60 days", "31–60 jours")}</TableHead>
                      <TableHead className="text-right">{t("61–90 days", "61–90 jours")}</TableHead>
                      <TableHead className="text-right">{t("Over 90 days", "Plus de 90 jours")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.rows.map((r) => (
                      <TableRow key={r.partyId}>
                        <TableCell>
                          <Link href={`/contacts/${r.partyId}`} className="font-medium hover:underline">{r.name}</Link>
                          <span className="block text-xs text-muted-foreground">
                            {r.phone ? `${r.phone} · ` : ""}{r.oldestDate ? t(`since ${fmtDate(r.oldestDate)}`, `depuis le ${fmtDate(r.oldestDate)}`) : ""}
                          </span>
                        </TableCell>
                        <TableCell className="text-right"><Num className="font-semibold">{usd(r.balance)}</Num></TableCell>
                        <TableCell className="text-right">{cell(r.current)}</TableCell>
                        <TableCell className="text-right">{cell(r.d31_60)}</TableCell>
                        <TableCell className="text-right">{cell(r.d61_90, true)}</TableCell>
                        <TableCell className="text-right">{cell(r.over90, true)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Self-check

interface CheckRow { key: string; ok: boolean; expected: string; actual: string; difference: string; details?: { label: string; value: string }[] }

const CHECK_TEXT: Record<string, { title: [string, string]; what: [string, string]; money: boolean; expected: [string, string]; actual: [string, string] }> = {
  books_balance: { title: ["The books balance", "Les comptes sont équilibrés"], what: ["Total debit balances equal total credit balances.", "Le total des soldes débiteurs égale le total des soldes créditeurs."], money: true, expected: ["Debits", "Débits"], actual: ["Credits", "Crédits"] },
  stock_value: { title: ["Stock matches the books", "Le stock correspond aux comptes"], what: ["The value of every item in stock adds up to the Stock account.", "La valeur de chaque article en stock égale le compte Stock."], money: true, expected: ["Stock account", "Compte Stock"], actual: ["Items", "Articles"] },
  stock_locations: { title: ["Quantities by location add up", "Les quantités par emplacement concordent"], what: ["Each item's quantity equals the sum over its locations.", "La quantité de chaque article égale la somme de ses emplacements."], money: false, expected: ["Expected", "Attendu"], actual: ["Items that differ", "Articles en écart"] },
  motorcycles: { title: ["Every motorcycle has its record", "Chaque moto a sa fiche"], what: ["Motorcycles in stock equal the chassis records in stock.", "Les motos en stock égalent les fiches châssis en stock."], money: false, expected: ["Expected", "Attendu"], actual: ["Models that differ", "Modèles en écart"] },
  receivables: { title: ["Customers add up", "Les clients concordent"], what: ["What each customer owes adds up to the receivables account.", "Ce que doit chaque client égale le compte Clients."], money: true, expected: ["Account", "Compte"], actual: ["Customers", "Clients"] },
  payables: { title: ["Suppliers add up", "Les fournisseurs concordent"], what: ["What we owe each supplier, agent and employee adds up to the payables account.", "Ce que l'on doit à chaque fournisseur, agent et employé égale le compte Fournisseurs."], money: true, expected: ["Account", "Compte"], actual: ["Contacts", "Contacts"] },
  goods_in_transit: { title: ["Container costs add up", "Les frais de conteneur concordent"], what: ["Costs of containers not yet offloaded equal Goods in transit.", "Les frais des conteneurs pas encore déchargés égalent Marchandises en transit."], money: true, expected: ["Account", "Compte"], actual: ["Containers", "Conteneurs"] },
  money_not_negative: { title: ["No cash box below zero", "Aucune caisse sous zéro"], what: ["No cash box, bank or mobile money account holds less than nothing.", "Aucune caisse, banque ou mobile money n'a un solde négatif."], money: false, expected: ["Expected", "Attendu"], actual: ["Accounts below zero", "Comptes sous zéro"] },
  sales_zero_price: { title: ["No sale at 0 $", "Aucune vente à prix nul"], what: ["Completed sales of the last 90 days with an item sold at 0 $: usually a price typed wrong.", "Ventes des 90 derniers jours avec un article vendu à 0\u00a0$\u00a0: souvent un prix mal saisi."], money: false, expected: ["Expected", "Attendu"], actual: ["Sales at 0 $", "Ventes à prix nul"] },
  sales_below_cost: { title: ["No sale below cost", "Aucune vente à perte"], what: ["Completed sales of the last 90 days sold for less than the cost of their items.", "Ventes des 90 derniers jours vendues moins cher que le coût de leurs articles."], money: false, expected: ["Expected", "Attendu"], actual: ["Sales below cost", "Ventes à perte"] },
  franc_lines: { title: ["Francs are counted", "Les francs sont comptés"], what: ["Every movement of a franc account carries its amount in francs and its rate.", "Chaque mouvement d'un compte en francs porte son montant en FC et son taux."], money: false, expected: ["Expected", "Attendu"], actual: ["Lines without francs", "Lignes sans francs"] },
  foreign_balances: { title: ["Francs and yuan match their dollars", "Les francs et les yuans correspondent à leurs dollars"], what: ["No contact holds dollars on francs or yuan worth under half a cent: such a balance comes from a journal typed by hand and needs correcting.", "Aucun contact n'a de dollars sur des francs ou des yuans valant moins d'un demi-centime\u00a0: un tel solde vient d'une écriture saisie à la main et doit être corrigé."], money: false, expected: ["Expected", "Attendu"], actual: ["Balances that differ", "Soldes en écart"] },
};

function SelfCheck() {
  const t = useT();
  const q = useQuery<{ ok: boolean; checks: CheckRow[]; warnings?: CheckRow[] }>({ queryKey: ["/api/reports/self-check"] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorText error={q.error} />;
  const data = q.data!;
  return (
    <div className="space-y-3">
      <div className={cn("rounded-md border p-3 text-sm font-medium", data.ok ? "border-green-600/30 bg-green-600/10 text-green-800 dark:text-green-300" : "border-destructive/40 bg-destructive/10 text-destructive")}>
        {data.ok
          ? `${t("Everything agrees.", "Tout concorde.")}${(data.warnings ?? []).some((w) => !w.ok) ? ` ${t("Some sales are worth a look below.", "Quelques ventes sont à regarder ci-dessous.")}` : ""}`
          : t(`${data.checks.filter((c) => !c.ok).length} check(s) need a look.`, count(t, data.checks.filter((c) => !c.ok).length, ["", ""], ["contrôle à vérifier", "contrôles à vérifier"]))}
        <Button variant="ghost" size="sm" className="ml-2 h-7" onClick={() => q.refetch()}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> {t("Check again", "Recontrôler")}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[...data.checks, ...(data.warnings ?? []).map((w) => ({ ...w, warning: true }))].map((c: CheckRow & { warning?: boolean }) => {
          const text = CHECK_TEXT[c.key];
          const show = (v: string) => (text?.money ? usd(v) : v);
          return (
            <Card key={c.key} className={cn(!c.ok && (c.warning ? "border-amber-500/60" : "border-destructive/50"))}>
              <CardContent className="space-y-1 p-4">
                <p className={cn("font-medium", c.ok ? "text-green-800 dark:text-green-400" : c.warning ? "text-amber-800 dark:text-amber-400" : "text-destructive")}>
                  {c.ok ? "✓" : c.warning ? "!" : "✗"}{" "}
                  {text && c.warning && !c.ok ? `${t(text.actual[0], text.actual[1])}${t(":", "\u00a0:")} ${c.actual}` : text ? t(text.title[0], text.title[1]) : c.key}
                </p>
                {text && <p className="text-xs text-muted-foreground">{t(text.what[0], text.what[1])}</p>}
                {text?.money ? (
                  <p className="text-sm tabular">
                    {t(text.expected[0], text.expected[1])} {show(c.expected)} · {t(text.actual[0], text.actual[1])} {show(c.actual)}
                    {!c.ok && <span className="ml-1 font-medium text-destructive">({t("difference", "écart")} {show(c.difference)})</span>}
                  </p>
                ) : (
                  !c.ok && text && !c.warning && <p className={cn("text-sm", "text-destructive")}>{t(text.actual[0], text.actual[1])}{t(":", "\u00a0:")} {c.actual}</p>
                )}
                {c.details?.length ? (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {c.details.map((x, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span>{c.warning ? x.label.replace(/\d{4}-\d{2}-\d{2}/, (iso) => fmtDate(iso)) : x.label}</span>
                        <span className="tabular">{c.warning ? x.value.split(" < ").map((v) => usd(v)).join(" < ") : x.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

interface BsLine {
  id: number;
  code: string;
  name: string;
  currency: string;
  nativeBalance: string | null;
  amount: string;
}
interface Bs {
  assets: BsLine[];
  liabilities: BsLine[];
  equity: BsLine[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  balanced: boolean;
}

function BalanceSheet() {
  const t = useT();
  const sys = useSystemText();
  const [asOf, setAsOf] = useState(todayLocal());
  const q = useQuery<Bs>({ queryKey: ["/api/reports/balance-sheet", { asOf }], enabled: validDate(asOf) });
  const bs = q.data;

  function exportCsv() {
    if (!bs) return;
    const rows = (title: string, xs: BsLine[]) => [[title, "", ""], ...xs.map((x) => [x.code, sys.account(x.name), x.amount])];
    downloadCsv(`bilan_${asOf}.csv`, [
      [t("Code", "Code"), t("Account", "Compte"), t("Amount ($)", "Montant ($)")],
      ...rows(t("Assets", "Actif"), bs.assets),
      ["", t("Total assets", "Total actif"), bs.totalAssets],
      ...rows(t("Liabilities", "Dettes"), bs.liabilities),
      ["", t("Total liabilities", "Total dettes"), bs.totalLiabilities],
      ...rows(t("Equity", "Capitaux propres"), bs.equity),
      ["", t("Total equity", "Total capitaux propres"), bs.totalEquity],
    ]);
  }

  const section = (title: string, xs: BsLine[], total: string, totalLabel: string) => (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {xs.length === 0 && (
              <TableRow><TableCell className="text-muted-foreground">{t("Nothing", "Rien")}</TableCell><TableCell /></TableRow>
            )}
            {xs.map((x) => (
              <TableRow key={`${x.id}-${x.name}`}>
                <TableCell>
                  {sys.account(x.name)}
                  {x.nativeBalance && <div className="text-xs text-muted-foreground"><Num>{cdf(x.nativeBalance)}</Num></div>}
                </TableCell>
                <TableCell className="text-right"><Num>{usd(x.amount)}</Num></TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{totalLabel}</TableCell>
              <TableCell className="text-right font-semibold"><Num>{usd(total)}</Num></TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t("As of", "Au")}>
          <Input type="date" className="w-44" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2">
          {bs && (
            <Badge variant={bs.balanced ? "outline" : "destructive"} className={cn(bs.balanced && BALANCED)}>
              {bs.balanced ? t("Balanced ✓", "Équilibré ✓") : t("Not balanced", "Non équilibré")}
            </Badge>
          )}
          <CsvButton onClick={exportCsv} disabled={!bs} />
        </div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {bs && (
        <div className="grid gap-4 lg:grid-cols-2">
          {section(t("Assets: what the shop owns", "Actif\u00a0: ce que la boutique possède"), bs.assets, bs.totalAssets, t("Total assets", "Total actif"))}
          <div className="space-y-4">
            {section(t("Liabilities: what the shop owes", "Dettes\u00a0: ce que la boutique doit"), bs.liabilities, bs.totalLiabilities, t("Total liabilities", "Total dettes"))}
            {section(t("Equity: what belongs to the partners", "Capitaux propres\u00a0: ce qui revient aux associés"), bs.equity, bs.totalEquity, t("Total equity", "Total capitaux propres"))}
          </div>
        </div>
      )}
    </div>
  );
}

function TrialBalance() {
  const t = useT();
  const sys = useSystemText();
  const [asOf, setAsOf] = useState(todayLocal());
  const q = useQuery<Tb>({ queryKey: ["/api/reports/trial-balance", { asOf }], enabled: validDate(asOf) });
  const tb = q.data;

  function exportCsv() {
    if (!tb) return;
    downloadCsv(`trial-balance_${asOf}.csv`, [
      [t("Code", "Code"), t("Account", "Compte"), t("Type", "Type"), t("Debit", "Débit"), t("Credit", "Crédit")],
      ...tb.rows.map((r) => {
        const b = d(r.balance);
        return [r.code, sys.account(r.name), accountTypeLabel(r.type, t), b.isPositive() ? b.toFixed(2) : "", b.isNegative() ? b.abs().toFixed(2) : ""];
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
            <Badge variant={tb.balanced ? "outline" : "destructive"} className={cn(tb.balanced && BALANCED)}>
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
                        <TableCell><span className="mr-2 font-mono text-xs text-muted-foreground">{r.code}</span>{sys.account(r.name)}</TableCell>
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
  const sys = useSystemText();
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
      t("Debit ($)", "Débit ($)"), t("Credit ($)", "Crédit ($)"), t("Currency", "Devise"), t("Native amount", "Montant en devise"), t("Rate", "Taux"), t("Line memo", "Libellé de ligne"),
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
                          <TableCell className="min-w-[180px]">{sys.memo(j.memo)}</TableCell>
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
                                      <TableCell><span className="mr-2 font-mono text-xs text-muted-foreground">{l.accountCode}</span>{sys.account(l.accountName)}{l.memo ? <span className="block text-xs text-muted-foreground">{sys.memo(l.memo)}</span> : null}</TableCell>
                                      <TableCell>{l.partyName}</TableCell>
                                      <TableCell className="text-right"><Num>{d(l.debit).isZero() ? "" : usd(l.debit)}</Num></TableCell>
                                      <TableCell className="text-right"><Num>{d(l.credit).isZero() ? "" : usd(l.credit)}</Num></TableCell>
                                      <TableCell className="text-right text-xs text-muted-foreground">
                                        <Num>{l.nativeAmount != null ? `${cdf(l.nativeAmount)}${l.rate ? ` · ${t("rate", "taux")} ${qty(l.rate)}\u00a0FC/$` : ""}` : ""}</Num>
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
        <Field label={t("Date", "Date")} required>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Back", "Retour")}</Button>
          <SubmitButton variant="destructive" blocked={!validDate(day) && t("Choose a valid date", "Choisissez une date valide")} pending={m.isPending} onClick={() => m.mutate({ date: day })}>{t("Reverse", "Annuler l'écriture")}</SubmitButton>
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
  const accountsQ = useAccounts();
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
  if (lines.some((l) => isCdf(acc(l.accountId)) && (!d(l.native).gt(0) || !d(l.rate).gt(0)))) problems.push(t("CDF accounts need the CDF amount and the rate", "Les comptes en francs ont besoin du montant en FC et du taux"));
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
          <Field label={t("Description", "Description")} required><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
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
                  <Field label={`${t("Account", "Compte")} ${i + 1}`} required>
                    <AccountSelect value={l.accountId} onChange={(id) => set(l.key, { accountId: id, partyId: null, native: "", rate: "" })} />
                  </Field>
                  <Field label={t("Debit ($)", "Débit ($)")}>
                    <Input inputMode="decimal" usd value={l.debit} onChange={(e) => set(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                  </Field>
                  <Field label={t("Credit ($)", "Crédit ($)")}>
                    <Input inputMode="decimal" usd value={l.credit} onChange={(e) => set(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                  </Field>
                  <div className="flex items-end">
                    <Button variant="ghost" size="icon" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t("Remove", "Retirer")}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {pt && (
                  <div className="mt-2">
                    <Field label={pt[0] === "customer" ? t("Customer", "Client") : t("Supplier or agent", "Fournisseur ou agent")} required>
                      <PartySelect types={pt} value={l.partyId} onChange={(id) => set(l.key, { partyId: id })} allowCreate={false} />
                    </Field>
                  </div>
                )}
                {isCdf(a) && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Field label={t("Amount in CDF", "Montant en FC")} required>
                      <Input inputMode="decimal" thousands value={l.native} onChange={(e) => setNative(l, e.target.value, l.rate)} />
                    </Field>
                    <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} required>
                      <Input inputMode="decimal" thousands rate value={l.rate} onChange={(e) => setNative(l, l.native, e.target.value)} />
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
          <span>{t("Debits:", "Débits\u00a0:")} <Num className="font-medium">{usd(totalDebit.toFixed(2))}</Num></span>
          <span>{t("Credits:", "Crédits\u00a0:")} <Num className="font-medium">{usd(totalCredit.toFixed(2))}</Num></span>
          <span className={cn("font-semibold", diff.isZero() ? "text-green-800 dark:text-green-400" : "text-destructive")}>
            {t("Difference:", "Écart\u00a0:")} <Num>{usd(diff.toFixed(2))}</Num>
          </span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton blocked={problems[0]} pending={m.isPending} onClick={save}>{t("Save entry", "Enregistrer l'écriture")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- (6) Account ledger

interface LedgerRow { journalId: number; number: string; date: string; type: string; memo: string | null; lineMemo: string | null; debit: string; credit: string; nativeAmount: string | null; rate: string | null; partyName: string | null; balance: string; nativeBalance: string | null }
interface LedgerData { account: Account; from: string; to: string; openingBalance: string; openingNative: string | null; rows: LedgerRow[]; closingBalance: string; closingNative: string | null }

function Ledger() {
  const sys = useSystemText();
  const t = useT();
  const range = useRange();
  const [accountId, setAccountId] = useState<number | null>(null);
  const accountsQ = useAccounts();
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
    const head = [t("Date", "Date"), t("No.", "N°"), t("Type", "Type"), t("Details", "Détails"), t("Party", "Tiers"), t("Debit ($)", "Débit ($)"), t("Credit ($)", "Crédit ($)"), t("Balance USD", "Solde USD")];
    if (cdfAcc) head.push("CDF", t("CDF balance", "Solde en FC"));
    const rows: unknown[][] = [
      [`${L.account.code} · ${sys.account(L.account.name)}`],
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
            <CardTitle className="text-base">{L.account.code} · {sys.account(L.account.name)}</CardTitle>
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
                        {sys.memo(r.lineMemo || r.memo)}
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
