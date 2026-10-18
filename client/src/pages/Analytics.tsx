import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { accountLabel, axisLines, compactUsd, d, num, pct, qty as fmtQty, usd, variantText } from "@/lib/format";
import { count, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { RangePicker, useRange } from "@/pages/Reports";

interface Analytics {
  totals: { income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string };
  /** credit: as given at the till; creditOwed / creditOnAvoir: after returns, owed and covered by an avoir (as on Sales). */
  sales: { count: number; total: string; credit: string; creditOwed?: string; creditOnAvoir?: string };
  daily: { date: string; revenue: string; cogs: string; grossProfit: string; expenses: string }[];
  trend: { month: string; income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string }[];
  payments: { accountId: number; name: string; currency: string; usd: string }[];
  byCategory: { name: string; revenue: string; profit: string; qty: string }[];
  topItems: { productName: string; attributes: Record<string, string>; sku: string; qty: string; revenue: string; cogs: string; profit: string }[];
  expenses: { accountId: number; code: string; name: string; amount: string }[];
  stockByCategory: { name: string; value: string }[];
  position: Position;
}

export interface Position { money: string; stock: string; transit: string; receivables: string; payables: string; otherAssets?: string; otherLiabilities?: string; net: string }

// Palette: primary for the main series, a muted second colour, emerald for profit.
const C_MAIN = "hsl(var(--primary))";
const C_MUTED = "hsl(var(--muted-foreground))";
const C_PROFIT = "#10b981";
/** Legend labels in the text colour (the swatch keeps the series colour): green text on the page is unreadable. */
const legendText = (value: string) => <span style={{ color: "hsl(var(--foreground))" }}>{value}</span>;
const C_LOSS = "hsl(var(--destructive))";
const GRID = "hsl(var(--border))";
const AXIS = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
const TOOLTIP = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, color: "hsl(var(--popover-foreground))", fontSize: 12 },
  labelStyle: { color: "hsl(var(--popover-foreground))", fontWeight: 600 },
  itemStyle: { color: "hsl(var(--popover-foreground))" },
  cursor: { fill: "hsl(var(--muted) / 0.4)" },
};

/** Short $ axis labels: 950 $, 1,2 k$, 15 k$. */
const axisUsd = (v: number) => compactUsd(v);
const tipUsd = (v: unknown) => usd(v);

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" }).replace(".", "") + (mo === 1 ? ` ${String(y).slice(2)}` : "");
}

/** Month tick on two lines (month, then the year under January) so all twelve fit and none is skipped. */
function MonthTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const [month, year] = String(payload?.value ?? "").split(" ");
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
      <tspan x={x} dy="0.9em">{month}</tspan>
      {year && <tspan x={x} dy="1.1em">{year}</tspan>}
    </text>
  );
}

/**
 * Category names on the bar charts' axis, on up to two lines split between words
 * ("Carburant du" / "groupe électrogène", see axisLines); the full name is in the tooltip.
 */
function CategoryTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const name = String(payload?.value ?? "");
  const lines = axisLines(name);
  return (
    <text x={x} y={y} textAnchor="end" fontSize={11} fill="hsl(var(--muted-foreground))">
      <title>{name}</title>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? (lines.length > 1 ? "-0.2em" : "0.35em") : "1.1em"}>{l}</tspan>
      ))}
    </text>
  );
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
  const payments = [...a.payments].sort((x, y) => num(y.usd) - num(x.usd)).map((x) => ({ name: x.currency === "CDF" ? accountLabel(x.name, "CDF") : x.name, usd: num(x.usd) }));
  // Credit as the Sales list counts it: after returns, and the part an avoir covered apart (it is not owed).
  const creditOwed = a.sales.creditOwed ?? a.sales.credit;
  const onAvoir = d(a.sales.creditOnAvoir ?? 0);
  const credit = num(creditOwed);
  if (credit > 0) payments.push({ name: t("On credit", "À crédit"), usd: credit });
  if (onAvoir.gt(0)) payments.push({ name: t("From customers' credit", "Sur l'avoir"), usd: num(onAvoir) });
  const expenses = [...a.expenses].sort((x, y) => num(y.amount) - num(x.amount)).slice(0, 10).map((x) => ({ name: x.name, amount: num(x.amount) }));
  const stock = [...a.stockByCategory].sort((x, y) => num(y.value) - num(x.value)).slice(0, 10).map((x) => ({ name: x.name || t("No category", "Sans catégorie"), value: num(x.value) }));
  const barH = (n: number) => Math.max(160, n * 30 + 40);
  const yCat = { type: "category" as const, dataKey: "name", width: 112, tick: <CategoryTick />, tickLine: false, axisLine: false, interval: 0 };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={t("Sales (before returns)", "Ventes (avant retours)")} value={usd(a.sales.total)} sub={count(t, a.sales.count, ["sale", "sales"], ["vente", "ventes"])} />
        <StatCard label={t("Gross profit", "Marge brute")} value={usd(a.totals.grossProfit)} tone={d(a.totals.grossProfit).lt(0) ? "bad" : "good"} sub={marginPct ? `${pct(marginPct, 1, 1)} ${t("of income", "des recettes")}` : undefined} />
        <StatCard label={t("Running costs", "Charges")} value={usd(a.totals.operatingExpenses)} />
        <StatCard label={t("Net profit", "Bénéfice net")} value={usd(a.totals.netProfit)} tone={d(a.totals.netProfit).lt(0) ? "bad" : "good"} />
        <StatCard
          label={t("Credit sales", "Ventes à crédit")}
          value={usd(creditOwed)}
          sub={
            <>
              <div>{t("after returns", "après retours")}</div>
              {onAvoir.gt(0) && <div className="text-emerald-800 dark:text-emerald-400">{t("From customers' credit", "Sur l'avoir")} {usd(onAvoir.toFixed(2))}</div>}
            </>
          }
        />
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        {t(
          "Gross and net profit are the books' figures: after returns, franc rounding and exchange differences. For a month still open, Partners and months also counts the month-end restatement of franc and yuan balances, so its result can differ.",
          "La marge et le bénéfice sont ceux des comptes\u00a0: après retours, arrondis en FC et écarts de change. Pour un mois encore ouvert, Associés et mois compte aussi la réévaluation des soldes en FC et en yuans de fin de mois\u00a0: son résultat peut donc différer.",
        )}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title={t("Daily income and gross profit", "Recettes et marge brute par jour")} empty={!daily.length}>
          <AreaChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} width={52} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
            <Area type="linear" dataKey="revenue" name={t("Income", "Recettes")} stroke={C_MAIN} fill={C_MAIN} fillOpacity={0.15} strokeWidth={2} />
            <Area type="linear" dataKey="grossProfit" name={t("Gross profit", "Marge brute")} stroke={C_PROFIT} fill={C_PROFIT} fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ChartCard>

        <ChartCard title={t("Last 12 months", "12 derniers mois")} empty={!trend.length}>
          <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tick={<MonthTick />} tickLine={false} axisLine={false} interval={0} height={36} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisUsd} width={52} />
            <Tooltip {...TOOLTIP} formatter={tipUsd} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
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
            <Bar dataKey="usd" name={t("Amount ($)", "Montant ($)")} radius={[0, 2, 2, 0]}>
              {payments.map((p, i) => <Cell key={i} fill={p.name === t("On credit", "À crédit") || p.name === t("From customers' credit", "Sur l'avoir") ? C_MUTED : C_MAIN} />)}
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
                          <Num className={cn(d(i.profit).lt(0) ? "text-destructive" : "text-emerald-800 dark:text-emerald-400")}>{usd(i.profit)}</Num>
                          {d(i.revenue).gt(0) && <div className="text-xs text-muted-foreground tabular">{pct(d(i.profit).div(d(i.revenue)).times(100).toNumber(), 1, 1)}</div>}
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
    // Credit customers hold is owed by us, and an advance to suppliers is owed to us: each said as what it is.
    d(p.receivables).lt(0) ? [t("Customer credit (we owe)", "Avoirs clients (dus)"), d(p.receivables).negated().toFixed(2), true] : [t("Customers owe us", "Clients nous doivent"), p.receivables],
    d(p.payables).lt(0) ? [t("Advances to suppliers", "Avances aux fournisseurs"), d(p.payables).negated().toFixed(2)] : [t("We owe", "Nous devons"), p.payables, true],
  ];
  if (p.otherAssets && !d(p.otherAssets).isZero()) rows.splice(4, 0, [t("Advances and deposits", "Avances et dépôts"), p.otherAssets]);
  if (p.otherLiabilities && !d(p.otherLiabilities).isZero()) rows.push([t("Other debts (withholdings…)", "Autres dettes (retenues…)"), p.otherLiabilities, true]);
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
              <TableCell className="text-right"><Num className={cn("font-semibold", d(p.net).lt(0) ? "text-destructive" : "text-emerald-800 dark:text-emerald-400")}>{usd(p.net)}</Num></TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
