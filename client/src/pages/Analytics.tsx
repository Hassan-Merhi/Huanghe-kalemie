import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { d, num, qty as fmtQty, usd, variantText } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { RangePicker, useRange } from "@/pages/Reports";

interface Analytics {
  totals: { income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string };
  sales: { count: number; total: string; credit: string };
  daily: { date: string; revenue: string; cogs: string; grossProfit: string; expenses: string }[];
  trend: { month: string; income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string }[];
  payments: { accountId: number; name: string; currency: string; usd: string }[];
  byCategory: { name: string; revenue: string; profit: string; qty: string }[];
  topItems: { productName: string; attributes: Record<string, string>; sku: string; qty: string; revenue: string; cogs: string; profit: string }[];
  expenses: { accountId: number; code: string; name: string; amount: string }[];
  stockByCategory: { name: string; value: string }[];
  position: Position;
}

export interface Position { money: string; stock: string; transit: string; receivables: string; payables: string; net: string }

// Palette: primary for the main series, a muted second colour, emerald for profit.
const C_MAIN = "hsl(var(--primary))";
const C_MUTED = "hsl(var(--muted-foreground))";
const C_PROFIT = "#10b981";
const C_LOSS = "hsl(var(--destructive))";
const GRID = "hsl(var(--border))";
const AXIS = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
const TOOLTIP = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, color: "hsl(var(--popover-foreground))", fontSize: 12 },
  labelStyle: { color: "hsl(var(--popover-foreground))", fontWeight: 600 },
  itemStyle: { color: "hsl(var(--popover-foreground))" },
  cursor: { fill: "hsl(var(--muted) / 0.4)" },
};

/** Short $ axis labels: $950, $1.2k, $15k. */
function axisUsd(v: number) {
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 10_000 ? `${Math.round(a / 1000)}k` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
  return `${v < 0 ? "-" : ""}$${s}`;
}
const tipUsd = (v: unknown) => usd(v);

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" }).replace(".", "") + (mo === 1 ? ` ${String(y).slice(2)}` : "");
}

function ChartCard({ title, children, empty, height = 260, className }: { title: string; children: ReactNode; empty?: boolean; height?: number; className?: string }) {
  const t = useT();
  return (
    <Card className={className}>
      <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-2 pt-0 sm:p-4 sm:pt-0">
        {empty ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("No data for this period.", "Aucune donnée pour cette période.")}</p>
        ) : (
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export default function AnalyticsPage() {
  const t = useT();
  const range = useRange();
  const ok = validDate(range.from) && validDate(range.to);
  const q = useQuery<Analytics>({ queryKey: ["/api/reports/analytics", { from: range.from, to: range.to }], enabled: ok });
  const a = q.data;

  return (
    <div>
      <PageHeader title={t("Analytics", "Analyses")} description={t("Sales, margins, running costs and what the shop is worth.", "Ventes, marges, charges et valeur de la boutique.")} />
      <div className="mb-4"><RangePicker range={range} /></div>
      <ErrorText error={q.error} />
      {q.isLoading && <Loading />}
      {a && <Body a={a} />}
    </div>
  );
}

function Body({ a }: { a: Analytics }) {
  const t = useT();
  const income = d(a.totals.income);
  const marginPct = income.gt(0) ? d(a.totals.grossProfit).div(income).times(100).toFixed(1) : null;

  const daily = a.daily.map((x) => ({ date: x.date.slice(8, 10) + "/" + x.date.slice(5, 7), revenue: num(x.revenue), grossProfit: num(x.grossProfit) }));
  const trend = a.trend.map((x) => ({ month: monthLabel(x.month), income: num(x.income), grossProfit: num(x.grossProfit), netProfit: num(x.netProfit) }));
  const byCat = [...a.byCategory].sort((x, y) => num(y.revenue) - num(x.revenue)).slice(0, 10).map((x) => ({ name: x.name || t("No category", "Sans catégorie"), revenue: num(x.revenue) }));
  const payments = [...a.payments].sort((x, y) => num(y.usd) - num(x.usd)).map((x) => ({ name: x.currency === "CDF" ? `${x.name} (FC)` : x.name, usd: num(x.usd) }));
  const credit = num(a.sales.credit);
  if (credit > 0) payments.push({ name: t("On credit", "À crédit"), usd: credit });
  const expenses = [...a.expenses].sort((x, y) => num(y.amount) - num(x.amount)).slice(0, 10).map((x) => ({ name: x.name, amount: num(x.amount) }));
  const stock = [...a.stockByCategory].sort((x, y) => num(y.value) - num(x.value)).slice(0, 10).map((x) => ({ name: x.name || t("No category", "Sans catégorie"), value: num(x.value) }));
  const barH = (n: number) => Math.max(160, n * 30 + 40);
  const yCat = { type: "category" as const, dataKey: "name", width: 110, tick: AXIS, tickLine: false, axisLine: false, interval: 0 };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={t("Sales", "Ventes")} value={usd(a.sales.total)} sub={`${a.sales.count} ${t("sale(s)", "vente(s)")}`} />
        <StatCard label={t("Gross profit", "Marge brute")} value={usd(a.totals.grossProfit)} tone={d(a.totals.grossProfit).lt(0) ? "bad" : "good"} sub={marginPct ? `${marginPct} % ${t("of income", "des recettes")}` : undefined} />
        <StatCard label={t("Running costs", "Charges")} value={usd(a.totals.operatingExpenses)} />
        <StatCard label={t("Net profit", "Bénéfice net")} value={usd(a.totals.netProfit)} tone={d(a.totals.netProfit).lt(0) ? "bad" : "good"} />
        <StatCard label={t("Credit sales", "Ventes à crédit")} value={usd(a.sales.credit)} sub={d(a.sales.total).gt(0) ? `${d(a.sales.credit).div(d(a.sales.total)).times(100).toFixed(0)} % ${t("of sales", "des ventes")}` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title={t("Daily income and gross profit", "Recettes et marge brute par jour")} empty={!daily.length}>
          <AreaChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} width={52} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="revenue" name={t("Income", "Recettes")} stroke={C_MAIN} fill={C_MAIN} fillOpacity={0.15} strokeWidth={2} />
            <Area type="monotone" dataKey="grossProfit" name={t("Gross profit", "Marge brute")} stroke={C_PROFIT} fill={C_PROFIT} fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ChartCard>

        <ChartCard title={t("Last 12 months", "12 derniers mois")} empty={!trend.length}>
          <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} width={52} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="income" name={t("Income", "Recettes")} fill={C_MAIN} radius={[2, 2, 0, 0]} />
            <Bar dataKey="grossProfit" name={t("Gross profit", "Marge brute")} fill={C_MUTED} radius={[2, 2, 0, 0]} />
            <Bar dataKey="netProfit" name={t("Net profit", "Bénéfice net")} fill={C_PROFIT} radius={[2, 2, 0, 0]}>
              {trend.map((x, i) => <Cell key={i} fill={x.netProfit < 0 ? C_LOSS : C_PROFIT} />)}
            </Bar>
          </BarChart>
        </ChartCard>

        <ChartCard title={t("Sales by category", "Ventes par catégorie")} empty={!byCat.length} height={barH(byCat.length)}>
          <BarChart data={byCat} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} />
            <YAxis {...yCat} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Bar dataKey="revenue" name={t("Income", "Recettes")} fill={C_MAIN} radius={[0, 2, 2, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title={t("How customers paid", "Modes de paiement")} empty={!payments.length} height={barH(payments.length)}>
          <BarChart data={payments} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} />
            <YAxis {...yCat} dataKey="name" />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Bar dataKey="usd" name={t("Amount (USD)", "Montant (USD)")} radius={[0, 2, 2, 0]}>
              {payments.map((p, i) => <Cell key={i} fill={p.name === t("On credit", "À crédit") ? C_MUTED : C_MAIN} />)}
            </Bar>
          </BarChart>
        </ChartCard>

        <ChartCard title={t("Running costs by account", "Charges par compte")} empty={!expenses.length} height={barH(expenses.length)}>
          <BarChart data={expenses} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} />
            <YAxis {...yCat} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Bar dataKey="amount" name={t("Amount", "Montant")} fill={C_MUTED} radius={[0, 2, 2, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title={t("Stock value by category (at cost)", "Valeur du stock par catégorie (au coût)")} empty={!stock.length} height={barH(stock.length)}>
          <BarChart data={stock} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} />
            <YAxis {...yCat} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Bar dataKey="value" name={t("Value", "Valeur")} fill={C_MAIN} radius={[0, 2, 2, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Top 10 items", "10 meilleurs articles")}</CardTitle></CardHeader>
          <CardContent className="p-0">
            {a.topItems.length === 0 ? (
              <div className="p-4"><EmptyState title={t("No sales for this period", "Aucune vente sur cette période")} /></div>
            ) : (
              <div className="overflow-x-auto [contain:inline-size]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Item", "Article")}</TableHead>
                      <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                      <TableHead className="text-right">{t("Income", "Recettes")}</TableHead>
                      <TableHead className="text-right">{t("Profit", "Marge")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.topItems.slice(0, 10).map((i) => (
                      <TableRow key={i.sku}>
                        <TableCell className="min-w-[150px]">
                          <div className="font-medium">{i.productName}</div>
                          <div className="text-xs text-muted-foreground">{[variantText(i.attributes), i.sku].filter(Boolean).join(" · ")}</div>
                        </TableCell>
                        <TableCell className="text-right"><Num>{fmtQty(i.qty)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{usd(i.revenue)}</Num></TableCell>
                        <TableCell className="text-right">
                          <Num className={cn(d(i.profit).lt(0) ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>{usd(i.profit)}</Num>
                          {d(i.revenue).gt(0) && <div className="text-xs text-muted-foreground tabular">{d(i.profit).div(d(i.revenue)).times(100).toFixed(0)} %</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
        <PositionCard position={a.position} />
      </div>
    </div>
  );
}

/** What the shop owns minus what it owes, today. */
export function PositionCard({ position: p }: { position: Position }) {
  const t = useT();
  const rows: [string, string, boolean?][] = [
    [t("Money (cash, bank, mobile)", "Trésorerie (caisse, banque, mobile)"), p.money],
    [t("Stock (at cost)", "Stock (au coût)"), p.stock],
    [t("Goods on the way", "Marchandises en route"), p.transit],
    [t("Customers owe us", "Clients nous doivent"), p.receivables],
    [t("We owe", "Nous devons"), p.payables, true],
  ];
  return (
    <Card>
      <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Net position", "Situation nette")}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {rows.map(([label, v, minus]) => (
              <TableRow key={label}>
                <TableCell>{label}</TableCell>
                <TableCell className="text-right"><Num className={minus && d(v).gt(0) ? "text-destructive" : undefined}>{minus ? usd(d(v).negated().toFixed(2)) : usd(v)}</Num></TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{t("Net", "Net")}</TableCell>
              <TableCell className="text-right"><Num className={cn("font-semibold", d(p.net).lt(0) ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>{usd(p.net)}</Num></TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
