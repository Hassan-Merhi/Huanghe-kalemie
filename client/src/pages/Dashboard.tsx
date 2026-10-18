import { useQuery } from "@tanstack/react-query";
import { capitalize, deMonth, monthText } from "@shared/french";
import { Link } from "wouter";
import { AlertTriangle, ArrowRight, BarChart3, BookOpen, ClipboardList, Container, FilePlus2, Receipt, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorText, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { RatesCard } from "@/components/RatesCard";
import { useAuth } from "@/lib/auth";
import { count, useT } from "@/lib/i18n";
import { useSystemText } from "@/lib/systemText";
import { cdf, d, pct, date as fmtDate, usd } from "@/lib/format";

interface DashboardData {
  today: string;
  month: string;
  /** Net of the goods brought back today (`returns`). */
  todaySales: { count: number; total: string; returns?: string };
  monthPnl: { income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string };
  /** The gross profit apart: margin on sales, stock losses and gains, exchange differences, the rest. */
  monthMargin?: { sales: string; stockAdjustments: string; fx: string; other: string };
  money: { id: number; name: string; currency: "USD" | "CDF"; balance: string; nativeBalance: string }[];
  receivables: string;
  payables: string;
  /** The same two balances contact by contact: what customers owe apart from their avoirs, our debts apart from our advances. */
  /** Suppliers' and agents' sides apart from the employees' (salaries owed, salary advances), never netted. */
  contactBalances?: { customersOwe: string; customerAvoirs: string; weOweSuppliers: string; supplierAdvances: string; salariesOwed?: string; salaryAdvances?: string };
  stockValue: string;
  lowStockCount: number;
  openContainers: { id: number; number: string; status: string; arrivalDate: string | null; purchaseUsd: string }[];
  recentSales: { id: number; number: string; date: string; total: string; status: string; customerName: string | null; returnedTotal?: string }[];
  partners: { id: number; name: string; sharePct: string; bearsOperatingExpenses: boolean; currentBalance: string; capitalBalance: string }[];
  position?: { money: string; stock: string; transit: string; receivables: string; payables: string; otherAssets?: string; otherLiabilities?: string; net: string };
}

const STATUS_LABEL: Record<string, [string, string]> = {
  draft: ["Draft", "Brouillon"],
  ordered: ["Ordered", "Commandé"],
  shipped: ["Shipped", "Expédié"],
  in_transit: ["In transit", "En route"],
  arrived: ["Arrived", "Arrivé"],
};

export default function Dashboard() {
  const t = useT();
  const sys = useSystemText();
  const { can } = useAuth();
  const q = useQuery<DashboardData>({ queryKey: ["/api/reports/dashboard"] });
  const data = q.data;

  const moneyTotal = (data?.money ?? []).reduce((s, m) => s.plus(d(m.balance)), d(0));
  // Sales at 0 $ or below cost in the last 90 days (from Rapports > Contrôles).
  const checksQ = useQuery<{ warnings?: { key: string; ok: boolean; actual: string }[] }>({ queryKey: ["/api/reports/self-check"], enabled: can("manager", "partner"), staleTime: 60_000 });
  const flagged = (checksQ.data?.warnings ?? []).filter((w) => !w.ok);

  return (
    <div>
      <PageHeader
        title={t("Dashboard", "Tableau de bord")}
        description={data ? `${fmtDate(data.today)} · ${t(`month of ${monthText(data.month, "en")}`, `mois ${deMonth(data.month)}`)}` : undefined}
        actions={
          can("manager") ? (
            <>
              <Button asChild><Link href="/pos"><ShoppingCart className="mr-1 h-4 w-4" /> {t("New sale", "Nouvelle vente")}</Link></Button>
              <Button asChild variant="outline"><Link href="/vouchers?tab=payment&line=account"><Receipt className="mr-1 h-4 w-4" /> {t("Add expense", "Ajouter une dépense")}</Link></Button>
              <Button asChild variant="outline"><Link href="/containers"><Container className="mr-1 h-4 w-4" /> {t("New container", "Nouveau conteneur")}</Link></Button>
            </>
          ) : undefined
        }
      />

      {q.isLoading ? (
        <Loading />
      ) : q.error || !data ? (
        <ErrorText error={q.error} />
      ) : (
        <div className="space-y-4">
          {flagged.length > 0 && (
            <Link href="/reports?tab=checks" className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-900 hover:bg-amber-500/15 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {flagged.map((w) =>
                  w.key === "sales_zero_price"
                    ? count(t, Number(w.actual), ["sale at 0 $", "sales at 0 $"], ["vente à prix nul", "ventes à prix nul"])
                    : count(t, Number(w.actual), ["sale below cost", "sales below cost"], ["vente à perte", "ventes à perte"]),
                ).join(" · ")}
                {t(" in the last 90 days: check them.", " ces 90 derniers jours\u00a0: à vérifier.")}
              </span>
            </Link>
          )}
          <div className="flex flex-wrap gap-2">
            {can("manager") && <Button asChild size="sm" variant="secondary"><Link href="/vouchers"><FilePlus2 className="mr-1 h-4 w-4" /> {t("New voucher", "Nouvelle pièce")}</Link></Button>}
            <Button asChild size="sm" variant="secondary"><Link href="/daybook"><BookOpen className="mr-1 h-4 w-4" /> {t("Day book", "Journal du jour")}</Link></Button>
            <Button asChild size="sm" variant="secondary"><Link href="/inventory"><ClipboardList className="mr-1 h-4 w-4" /> {t("Inventory", "Inventaire")}</Link></Button>
            <Button asChild size="sm" variant="secondary"><Link href="/analytics"><BarChart3 className="mr-1 h-4 w-4" /> {t("Analytics", "Analyses")}</Link></Button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <StatCard label={t("Today's sales", "Ventes du jour")} value={usd(data.todaySales.total)} sub={`${count(t, data.todaySales.count, ["sale", "sales"], ["vente", "ventes"])}${d(data.todaySales.returns).gt(0) ? ` · ${t("returns", "retours")} −${usd(data.todaySales.returns)}` : ""}`} />
            <StatCard
              label={t("Gross profit this month", "Marge brute du mois")}
              value={usd(data.monthPnl.grossProfit)}
              tone={d(data.monthPnl.grossProfit).lt(0) ? "bad" : "good"}
              sub={data.monthMargin ? marginParts(t, data.monthMargin) : `${t("Income", "Recettes")} ${usd(data.monthPnl.income)} − ${t("cost", "coût")} ${usd(data.monthPnl.costOfSales)}`}
            />
            <StatCard label={t("Running costs this month", "Charges du mois")} value={usd(data.monthPnl.operatingExpenses)} sub={t("Rent, salaries, electricity…", "Loyer, salaires, électricité…")} />
            <StatCard label={t("Net profit this month", "Bénéfice net du mois")} value={usd(data.monthPnl.netProfit)} tone={d(data.monthPnl.netProfit).lt(0) ? "bad" : "good"} />
            <StatCard label={t("Stock value (at cost)", "Valeur du stock (au coût)")} value={usd(data.stockValue)} />
            {/* Customers who paid ahead are owed by us, and an advance to one supplier is not less owed to another:
                each side is said on its own, never netted. */}
            {data.contactBalances ? (
              <>
                <StatCard
                  label={t("Customers owe us", "Créances clients")}
                  value={usd(data.contactBalances.customersOwe)}
                  sub={<SideSub other={data.contactBalances.customerAvoirs} otherLabel={t("customer credit (we owe)", "avoirs clients (dus)")} link={t("See customers", "Voir les clients")} />}
                />
                <StatCard
                  label={t("We owe suppliers", "Dettes fournisseurs")}
                  value={usd(data.contactBalances.weOweSuppliers)}
                  sub={
                    <>
                      {d(data.contactBalances.salariesOwed ?? 0).gt(0) && <span className="block">{t("salaries owed", "salaires dus")} {usd(data.contactBalances.salariesOwed!)}</span>}
                      {d(data.contactBalances.salaryAdvances ?? 0).gt(0) && <span className="block">{t("salary advances", "avances sur salaire")} {usd(data.contactBalances.salaryAdvances!)}</span>}
                      <SideSub other={data.contactBalances.supplierAdvances} otherLabel={t("advances to suppliers", "avances aux fournisseurs")} link={t("See suppliers", "Voir les fournisseurs")} />
                    </>
                  }
                />
              </>
            ) : (
              <>
                <StatCard
                  label={d(data.receivables).lt(0) ? t("Customer credit", "Avoirs clients") : t("Customers owe us", "Créances clients")}
                  value={usd(d(data.receivables).abs().toFixed(2))}
                  sub={<Link href="/contacts" className="underline-offset-2 hover:underline">{t("See customers", "Voir les clients")}</Link>}
                />
                <StatCard
                  label={d(data.payables).lt(0) ? t("Advances to suppliers", "Avances aux fournisseurs") : t("We owe suppliers", "Dettes fournisseurs")}
                  value={usd(d(data.payables).abs().toFixed(2))}
                  sub={<Link href="/contacts" className="underline-offset-2 hover:underline">{t("See suppliers", "Voir les fournisseurs")}</Link>}
                />
              </>
            )}
            <StatCard
              label={t("Low stock items", "Articles en stock bas")}
              value={<span className="flex items-center gap-2">{data.lowStockCount}{data.lowStockCount > 0 && <AlertTriangle className="h-5 w-5 text-amber-500" />}</span>}
              sub={<Link href="/stock" className="inline-flex items-center underline-offset-2 hover:underline">{t("Open stock", "Voir le stock")} <ArrowRight className="ml-1 h-3 w-3" /></Link>}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {data.position && <PositionCard p={data.position} onTheWay={data.openContainers} sides={data.contactBalances} />}
            <RatesCard />
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                <CardTitle className="text-base">{t("Money", "Trésorerie")}</CardTitle>
                <Link href="/accounts" className="text-sm text-muted-foreground hover:text-foreground">{t("Details", "Détails")}</Link>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                {data.money.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("No money accounts.", "Aucun compte de trésorerie.")}</p>
                ) : (
                  <div className="divide-y text-sm">
                    {data.money.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 py-2">
                        <span>{sys.account(m.name)}</span>
                        <span className="text-right">
                          {m.currency === "CDF" ? (
                            <>
                              <Num className="block font-medium">{cdf(m.nativeBalance)}</Num>
                              <Num className="block text-xs text-muted-foreground">≈ {usd(m.balance)}</Num>
                            </>
                          ) : (
                            <Num className="font-medium">{usd(m.balance)}</Num>
                          )}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between py-2 font-semibold">
                      <span>{t("Total (in $)", "Total (en $)")}</span>
                      <Num>{usd(moneyTotal.toFixed(2))}</Num>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                <CardTitle className="text-base">{t("Partners", "Associés")}</CardTitle>
                <Link href="/partners" className="text-sm text-muted-foreground hover:text-foreground">{t("Details", "Détails")}</Link>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="mb-2 text-xs text-muted-foreground">
                  {t(
                    "At each month close, gross profit is split 75/25; shop running costs then come off the 75% partner's share only.",
                    "À chaque clôture mensuelle, la marge brute est partagée 75/25\u00a0; les charges de la boutique sont ensuite déduites uniquement de la part de l'associé à 75\u00a0%.",
                  )}
                </p>
                <div className="divide-y text-sm">
                  {data.partners.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{p.name}</span> <Badge variant="outline" className="ml-1">{pct(p.sharePct)}</Badge>
                        {p.bearsOperatingExpenses && <span className="block text-xs text-muted-foreground">{t("bears running costs", "supporte les charges")}</span>}
                      </span>
                      <span className="text-right">
                        <Num className="block font-medium">{usd(p.currentBalance)}</Num>
                        <span className="block text-xs text-muted-foreground">{t("profit share owed", "part de bénéfice due")}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                <CardTitle className="text-base">{t("Containers not yet offloaded", "Conteneurs pas encore déchargés")}</CardTitle>
                <Link href="/containers" className="text-sm text-muted-foreground hover:text-foreground">{t("All", "Tous")}</Link>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                {data.openContainers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("No container on the way.", "Aucun conteneur en cours.")}</p>
                ) : (
                  <div className="divide-y text-sm">
                    {data.openContainers.map((c) => {
                      const label = STATUS_LABEL[c.status];
                      return (
                        <Link key={c.id} href={`/containers/${c.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-muted/50">
                          <span className="font-medium">{c.number}</span>
                          <span className="flex items-center gap-2 text-muted-foreground">
                            {c.arrivalDate && <span className="text-xs">{t("arrival", "arrivée")} {fmtDate(c.arrivalDate)}</span>}
                            <Badge variant="secondary">{label ? t(label[0], label[1]) : c.status}</Badge>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                <CardTitle className="text-base">{t("Recent sales", "Ventes récentes")}</CardTitle>
                <Link href="/sales" className="text-sm text-muted-foreground hover:text-foreground">{t("All", "Toutes")}</Link>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                {data.recentSales.length === 0 ? (
                  <EmptyState title={t("No sales yet", "Pas encore de ventes")} />
                ) : (
                  <div className="divide-y text-sm">
                    {data.recentSales.map((s) => {
                      const voided = s.status === "voided";
                      const returned = d(s.returnedTotal);
                      // Net of what came back, as on the Sales list; a cancelled sale keeps its struck-through total.
                      const shown = voided ? d(s.total) : d(s.total).minus(returned);
                      return (
                        <Link key={s.id} href={`/sales/${s.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-muted/50">
                          <span className="min-w-0">
                            <span className="font-medium">{s.number}</span>
                            <span className="text-muted-foreground"> · {fmtDate(s.date)} · {s.customerName ?? t("walk-in", "de passage")}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {voided && <Badge variant="destructive">{t("Cancelled", "Annulée")}</Badge>}
                            <span className="text-right">
                              <Num className={voided ? "text-muted-foreground line-through" : "font-medium"}>{usd(shown.toFixed(2))}</Num>
                              {!voided && returned.gt(0) && <span className="block whitespace-nowrap text-xs text-muted-foreground">{t("returns", "retours")} −{usd(returned.toFixed(2))}</span>}
                            </span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/** "avoirs clients (dus) 15 750,00 $ · Voir les clients": the other side of a contacts card, when there is one. */
function SideSub({ other, otherLabel, link }: { other: string; otherLabel: string; link: string }) {
  return (
    <>
      {d(other).gt(0) && <span className="block">{otherLabel} {usd(other)}</span>}
      <Link href="/contacts" className="underline-offset-2 hover:underline">{link}</Link>
    </>
  );
}

function PositionCard({ p, onTheWay, sides }: { p: NonNullable<DashboardData["position"]>; onTheWay: DashboardData["openContainers"]; sides?: DashboardData["contactBalances"] }) {
  const t = useT();
  const purchase = onTheWay.reduce((s, c) => s.plus(d(c.purchaseUsd)), d(0));
  // Credit customers hold is owed by us, and an advance to suppliers is owed to us: each said as what it is,
  // contact by contact when known (the net is the same).
  const contactRows: [string, string, boolean][] = sides
    ? [
        [t("Customers owe us", "Clients nous doivent"), sides.customersOwe, false],
        ...(d(sides.customerAvoirs).gt(0) ? [[t("Customer credit (we owe)", "Avoirs clients (dus)"), sides.customerAvoirs, true] as [string, string, boolean]] : []),
        ...(d(sides.supplierAdvances).gt(0) ? [[t("Advances to suppliers", "Avances aux fournisseurs"), sides.supplierAdvances, false] as [string, string, boolean]] : []),
        ...(d(sides.salaryAdvances ?? 0).gt(0) ? [[t("Salary advances", "Avances sur salaire"), sides.salaryAdvances!, false] as [string, string, boolean]] : []),
        [t("We owe", "Nous devons"), sides.weOweSuppliers, true],
        ...(d(sides.salariesOwed ?? 0).gt(0) ? [[t("Salaries owed", "Salaires dus"), sides.salariesOwed!, true] as [string, string, boolean]] : []),
      ]
    : [
        d(p.receivables).lt(0) ? [t("Customer credit (we owe)", "Avoirs clients (dus)"), d(p.receivables).negated().toFixed(2), true] : [t("Customers owe us", "Clients nous doivent"), p.receivables, false],
        d(p.payables).lt(0) ? [t("Advances to suppliers", "Avances aux fournisseurs"), d(p.payables).negated().toFixed(2), false] : [t("We owe", "Nous devons"), p.payables, true],
      ];
  const rows: [string, string, boolean][] = [
    [t("Money", "Trésorerie"), p.money, false],
    [t("Stock (at cost)", "Stock (au coût)"), p.stock, false],
    [t("Container costs paid (on the way)", "Frais payés (conteneurs en route)"), p.transit, false],
    ...contactRows,
  ];
  // Other advances and deposits go with the assets, before what is owed.
  const firstOwed = rows.findIndex(([, , owed]) => owed);
  if (p.otherAssets && !d(p.otherAssets).isZero()) rows.splice(firstOwed < 0 ? rows.length : firstOwed, 0, [t("Advances and deposits", "Avances et dépôts"), p.otherAssets, false]);
  if (p.otherLiabilities && !d(p.otherLiabilities).isZero()) rows.push([t("Other debts (withholdings…)", "Autres dettes (retenues…)"), p.otherLiabilities, true]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
        <CardTitle className="text-base">{t("Net position", "Situation nette")}</CardTitle>
        <Link href="/analytics" className="text-sm text-muted-foreground hover:text-foreground">{t("Details", "Détails")}</Link>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="divide-y text-sm">
          {rows.map(([label, v, owed]) => (
            <div key={label} className="flex items-center justify-between gap-2 py-2">
              <span>{label}</span>
              <Num className={owed && d(v).gt(0) ? "text-destructive" : undefined}>{owed ? usd(d(v).negated().toFixed(2)) : usd(v)}</Num>
            </div>
          ))}
          <div className="flex justify-between py-2 font-semibold">
            <span>{t("Net", "Net")}</span>
            <Num className={d(p.net).lt(0) ? "text-destructive" : "text-emerald-800 dark:text-emerald-400"}>{usd(p.net)}</Num>
          </div>
        </div>
        {purchase.gt(0) && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              `Not counted yet: ${usd(purchase.toFixed(2))} of goods bought in containers on the way. They enter stock, with the supplier debt, on offload.`,
              `Pas encore compté\u00a0: ${usd(purchase.toFixed(2))} de marchandises achetées dans les conteneurs en route. Elles entrent en stock, avec la dette fournisseur, au déchargement.`,
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** "Margin on sales 1 446,99 $ · stock −547,40 $ · exchange +0,21 $": the Sales page's margin, then what the books add to it. */
function marginParts(t: (en: string, fr: string) => string, m: NonNullable<DashboardData["monthMargin"]>) {
  const signed = (v: string) => `${d(v).isNegative() ? "−" : "+"}${usd(d(v).abs().toFixed(2))}`;
  return [
    `${t("Margin on sales", "Marge sur ventes")} ${usd(m.sales)}`,
    !d(m.stockAdjustments).isZero() && `${t("stock losses and gains", "pertes et gains de stock")} ${signed(m.stockAdjustments)}`,
    !d(m.fx).isZero() && `${t("exchange", "change")} ${signed(m.fx)}`,
    !d(m.other).isZero() && `${t("other income", "autres produits")} ${signed(m.other)}`,
  ].filter(Boolean).join(" · ");
}
