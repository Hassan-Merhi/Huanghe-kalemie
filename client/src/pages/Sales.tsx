import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { count, useT } from "@/lib/i18n";
import { cdf, d, date as fmtDate, monthStart, pct, qty as fmtQty, todayLocal, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SaleListRow {
  id: number;
  number: string;
  date: string;
  status: "completed" | "voided";
  total: string;
  paidUsd: string;
  creditUsd: string;
  cogs?: string;
  customerName: string | null;
  cashier: string | null;
  zeroPrice?: boolean;
  qty?: string;
  returnedQty?: string;
  /** Amount and cost of the goods brought back (all returns on the sale). */
  returnedTotal?: string;
  returnedCogs?: string;
  /** Cash handed back on those returns (part of a return may instead come off what the customer owes). */
  refundedUsd?: string;
  /** Credit still owed on the sale once returns came off the customer's balance. */
  creditLeftUsd?: string;
  /** Franc rounding of the till and the refunds, + when the shop kept a few cents. */
  fcRoundingUsd?: string;
  lineCount?: number;
  firstItem?: string | null;
}

interface Daily {
  date: string;
  count: number;
  total: string;
  credit: string;
  voidsCount: number;
  voidsTotal: string;
  returnsCount?: number;
  returnsTotal?: string;
  byAccount: { account_id: number; name: string; currency: string; usd: string; native: string; refund_native?: string }[];
}

function DailySummary() {
  const t = useT();
  const today = todayLocal();
  const q = useQuery<Daily>({ queryKey: ["/api/reports/daily", { date: today }] });
  const data = q.data;
  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Today", "Aujourd'hui")} · {fmtDate(data?.date ?? today)}</p>
          {data && <p className="text-sm text-muted-foreground">{count(t, data.count, ["sale", "sales"], ["vente", "ventes"])}</p>}
        </div>
        {q.error ? (
          <ErrorText error={q.error} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="mt-2 grid gap-4 sm:grid-cols-[auto_1fr]">
            <div>
              {/* Sold today, less what was cancelled and what was brought back today. */}
              <p className="text-3xl font-semibold tabular">{usd(d(data.total).minus(data.voidsTotal).minus(d(data.returnsTotal)).toFixed(2))}</p>
              {data.voidsCount > 0 && (
                <p className="text-sm text-muted-foreground">
                  {count(t, data.voidsCount, ["sale cancelled", "sales cancelled"], ["vente annulée", "ventes annulées"])} (−{usd(data.voidsTotal)})
                </p>
              )}
              {d(data.returnsTotal).gt(0) && (
                <p className="text-sm text-muted-foreground">
                  {t("Returns", "Retours")} −{usd(data.returnsTotal)}
                </p>
              )}
              {d(data.credit).gt(0) && <p className="text-sm text-amber-800 dark:text-amber-400">{t("of which on credit", "dont à crédit")} {usd(data.credit)}</p>}
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {data.byAccount.length === 0 && <p className="text-sm text-muted-foreground">{t("No money received yet today.", "Aucun encaissement aujourd'hui.")}</p>}
              {data.byAccount.map((a) => (
                <div key={a.account_id} className="rounded-md border px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">{a.name}</p>
                  <p className="font-medium tabular">{a.currency === "CDF" ? cdf(a.native) : usd(a.usd)}</p>
                  {a.currency === "CDF" && <p className="text-xs text-muted-foreground tabular">≈ {usd(a.usd)}</p>}
                  {d(a.refund_native).gt(0) && (
                    <p className="text-xs text-muted-foreground tabular">
                      {t("of which refunded", "dont remboursé")} −{a.currency === "CDF" ? cdf(a.refund_native) : usd(a.refund_native)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** "Prix nul" and "Vente à perte": sales worth a second look (a price typed wrong, a sale below cost). */
export function SaleFlags({ zeroPrice, total, cogs }: { zeroPrice?: boolean; total: string; cogs?: string }) {
  const t = useT();
  const loss = cogs !== undefined && d(cogs).gt(0) && d(total).lt(d(cogs));
  return (
    <>
      {zeroPrice && <Badge variant="destructive" className="ml-1 whitespace-nowrap">{t("Price 0", "Prix nul")}</Badge>}
      {loss && <Badge variant="outline" className="ml-1 whitespace-nowrap border-amber-600 text-amber-800 dark:border-amber-400 dark:text-amber-300">{t("Below cost", "Vente à perte")}</Badge>}
    </>
  );
}

/** Profit in green when the sale made money, in red when it lost money. */
function Profit({ value, muted }: { value: string; muted?: boolean }) {
  const v = d(value);
  return (
    <Num
      className={cn(
        "rounded px-2 py-0.5 font-medium max-[1100px]:px-1.5",
        !muted && v.gt(0) && "bg-green-500/15 text-green-800 dark:text-green-400",
        !muted && v.lt(0) && "bg-red-500/15 text-red-700 dark:text-red-400",
      )}
    >
      {usd(v.toFixed(2))}
    </Num>
  );
}

/** A sale as the list shows it: net of the goods brought back, and paid net of the cash refunded. */
function netOf(r: SaleListRow) {
  const total = d(r.total).minus(d(r.returnedTotal));
  const cogs = r.cogs !== undefined ? d(r.cogs).minus(d(r.returnedCogs)) : undefined;
  const refunded = d(r.refundedUsd);
  return { total, cogs, profit: cogs !== undefined ? total.minus(cogs) : undefined, returned: d(r.returnedTotal), paid: d(r.paidUsd).minus(refunded), refunded };
}

/** What is still on credit after returns took it off the customer's balance (the sale page's "Reste à crédit"). */
function creditOf(r: SaleListRow): string {
  return r.creditLeftUsd ?? r.creditUsd;
}

/**
 * "+5,00 $ sur le compte client" under a paid amount above the sale's total: a credit sale returned after a
 * payment keeps the money paid, and what is over the total went on the customer's balance. The few cents of
 * franc rounding (change and refunds in 100 FC steps) read "arrondi FC +0,03 $" instead, as on the sale page:
 * they are on no account, and a walk-in customer has none.
 */
function OnAccount({ r }: { r: SaleListRow }) {
  const t = useT();
  if (r.status === "voided") return null;
  const n = netOf(r);
  const rounding = d(r.fcRoundingUsd ?? 0);
  const over = n.paid.minus(n.total).minus(rounding);
  return (
    <>
      {over.gt(0) && r.customerName && (
        <span className="block whitespace-nowrap text-xs text-muted-foreground" data-testid="paid-on-account">
          +{usd(over.toFixed(2))} {t("to the customer's account", "sur le compte client")}
        </span>
      )}
      {!rounding.isZero() && (
        <span className="block whitespace-nowrap text-xs text-muted-foreground" data-testid="paid-rounding">
          {t("FC rounding", "arrondi FC")} {rounding.isNegative() ? "−" : "+"}{usd(rounding.abs().toFixed(2))}
        </span>
      )}
    </>
  );
}

/** "remboursé −22,00 $" under a paid amount; the amount itself never breaks. */
function Refunded({ value }: { value: { toFixed(n: number): string; gt(n: number): boolean } }) {
  const t = useT();
  if (!value.gt(0)) return null;
  return (
    <div className="text-xs text-muted-foreground">
      {t("refunded", "remboursé")} <span className="whitespace-nowrap tabular">−{usd(value.toFixed(2))}</span>
    </div>
  );
}

function Items({ r }: { r: SaleListRow }) {
  const t = useT();
  if (!r.firstItem) return null;
  return (
    <>
      {r.firstItem}
      {(r.lineCount ?? 1) > 1 && ` + ${count(t, (r.lineCount ?? 1) - 1, ["other", "others"], ["autre", "autres"])}`}
    </>
  );
}

function Customer({ r }: { r: SaleListRow }) {
  const t = useT();
  return <>{r.customerName ?? <span className="text-muted-foreground">{t("Walk-in", "De passage")}</span>}</>;
}

/** The sale's state next to its number: cancelled, or worth a second look. */
function Marks({ r }: { r: SaleListRow }) {
  const t = useT();
  const n = netOf(r);
  if (r.status === "voided") return <Badge variant="destructive" className="ml-1">{t("Cancelled", "Annulée")}</Badge>;
  return <SaleFlags zeroPrice={r.zeroPrice} total={n.total.toFixed(2)} cogs={n.cogs?.toFixed(2)} />;
}

/** On phones: one fixed card per sale, number, date and total first, then who and what, then the figures. */
function SaleCard({ r, showCost }: { r: SaleListRow; showCost: boolean }) {
  const t = useT();
  const voided = r.status === "voided";
  const n = netOf(r);
  return (
    <Link href={`/sales/${r.id}`} className={cn("block rounded-lg border p-3 active:bg-muted/50", voided && "text-muted-foreground")} data-testid="sale-card">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold">{r.number}</span>
          <span className="ml-2 text-xs text-muted-foreground">{fmtDate(r.date)}</span>
          <Marks r={r} />
        </div>
        <Num className={cn("shrink-0 text-lg font-semibold", voided && "line-through")}>{usd((voided ? d(r.total) : n.total).toFixed(2))}</Num>
      </div>
      <p className="mt-0.5 min-w-0 truncate text-sm">
        <Customer r={r} />
        {r.firstItem && <span className="text-muted-foreground"> · <Items r={r} /></span>}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <p className="min-w-0 tabular">
          {t("Qty", "Qté")} {fmtQty(d(r.qty).minus(d(r.returnedQty)).toString())} · {t("Paid", "Payé")} {usd((voided ? d(r.paidUsd) : n.paid).toFixed(2))}
          {d(creditOf(r)).gt(0) && !voided && <span className="text-amber-800 dark:text-amber-400"> · {t("Credit", "Crédit")} {usd(creditOf(r))}</span>}
          <OnAccount r={r} />
          {/* What came back, under the figures so the items above keep their line. */}
          {!voided && n.returned.gt(0) && (
            <span className="block">
              {t("returns", "retours")} −{usd(n.returned.toFixed(2))}
              {n.refunded.gt(0) && ` · ${t("refunded", "remboursé")} −${usd(n.refunded.toFixed(2))}`}
            </span>
          )}
        </p>
        {showCost && n.profit !== undefined && <Profit value={n.profit.toFixed(2)} muted={voided} />}
      </div>
    </Link>
  );
}

export default function Sales() {
  const t = useT();
  const { can, user } = useAuth();
  const [, navigate] = useLocation();
  const isCashier = user?.role === "cashier";
  const showCost = !isCashier;
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const [search, setSearch] = useState("");
  const q = useQuery<SaleListRow[]>({
    queryKey: ["/api/sales", isCashier ? { search: search.trim() } : { from, to, search: search.trim() }],
  });
  const rows = q.data ?? [];
  const live = rows.filter((r) => r.status !== "voided");
  const sumOf = (f: (r: SaleListRow) => unknown) => live.reduce((s, r) => s.plus(d(f(r))), d(0));
  // Period totals are net of returns, like each row.
  const totals = {
    total: sumOf((r) => netOf(r).total),
    returned: sumOf((r) => r.returnedTotal),
    paid: sumOf((r) => netOf(r).paid),
    refunded: sumOf((r) => r.refundedUsd),
    credit: sumOf(creditOf),
    cogs: sumOf((r) => netOf(r).cogs),
    qty: sumOf((r) => d(r.qty).minus(d(r.returnedQty))),
  };
  const profit = totals.total.minus(totals.cogs);

  return (
    <div>
      <PageHeader
        title={t("Sales", "Ventes")}
        description={isCashier ? t("Today's sales.", "Les ventes d'aujourd'hui.") : t("All sales for the chosen dates, net of returns.", "Toutes les ventes de la période, retours déduits.")}
        actions={can("manager", "cashier") ? <Button asChild><Link href="/pos"><Plus className="mr-1 h-4 w-4" /> {t("New sale", "Nouvelle vente")}</Link></Button> : undefined}
      />
      <DailySummary />

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label={t("Search", "Recherche")}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder={t("Sale number or customer", "N° de vente ou client")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
        {!isCashier && (
          <>
            <Field label={t("From", "Du")}><Input type="date" className="sm:w-44" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label={t("To", "Au")}><Input type="date" className="sm:w-44" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </>
        )}
      </div>

      {live.length > 0 && (
        <div className={cn("mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3", showCost ? "xl:grid-cols-5" : "xl:grid-cols-4")}>
          <StatCard label={t("Sales", "Ventes")} value={live.length} sub={`${fmtQty(totals.qty.toString())} ${t("units sold", "unités vendues")}`} />
          <StatCard label={t("Paid", "Payé")} value={usd(totals.paid.toFixed(2))} sub={totals.refunded.gt(0) ? `${t("refunded", "remboursé")} −${usd(totals.refunded.toFixed(2))}` : undefined} />
          <StatCard label={t("Total", "Total")} value={usd(totals.total.toFixed(2))} sub={totals.returned.gt(0) ? `${t("returns", "retours")} −${usd(totals.returned.toFixed(2))}` : undefined} />
          <StatCard label={t("On credit", "À crédit")} value={usd(totals.credit.toFixed(2))} tone={totals.credit.gt(0) ? "warn" : "neutral"} />
          {showCost && (
            <StatCard
              label={t("Profit", "Marge")}
              value={usd(profit.toFixed(2))}
              tone={profit.gt(0) ? "good" : profit.lt(0) ? "bad" : "neutral"}
              sub={totals.total.gt(0) ? `${pct(profit.dividedBy(totals.total).times(100).toNumber(), 1, 1)} ${t("of sales", "des ventes")}` : undefined}
            />
          )}
        </div>
      )}

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No sales", "Aucune vente")}>{t("Sales made at the till appear here.", "Les ventes faites à la caisse apparaissent ici.")}</EmptyState>
      ) : (
        <>
          <div className="space-y-2 sm:hidden">
            {rows.map((r) => <SaleCard key={r.id} r={r} showCost={showCost} />)}
          </div>
          <Card className="hidden sm:block">
            <div className="overflow-x-auto [contain:inline-size]">
              {/* The cost of each sale is on the sale's own page; here the list stays narrow enough for 1024 px
                  with the menu open (tighter cells below 1100 px). */}
              <Table cards={false} className="[&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 max-[1100px]:[&_td]:px-2 max-[1100px]:[&_th]:px-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("No. · date", "N° · date")}</TableHead>
                    <TableHead>{t("Customer", "Client")}</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className="text-right">{t("Paid", "Payé")}</TableHead>
                    <TableHead className="text-right">{t("Total", "Total")}</TableHead>
                    {showCost && <TableHead className="text-right">{t("Profit", "Marge")}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const voided = r.status === "voided";
                    const n = netOf(r);
                    return (
                      <TableRow key={r.id} className={cn("cursor-pointer odd:bg-muted/30", voided && "text-muted-foreground")} onClick={() => navigate(`/sales/${r.id}`)}>
                        <TableCell className="font-medium">
                          <Link href={`/sales/${r.id}`} className="whitespace-nowrap hover:underline" onClick={(e) => e.stopPropagation()}>{r.number}</Link>
                          <Marks r={r} />
                          <div className="whitespace-nowrap text-xs font-normal text-muted-foreground">
                            {fmtDate(r.date)}
                            {r.cashier && ` · ${r.cashier}`}
                          </div>
                        </TableCell>
                        <TableCell className="min-w-[140px]">
                          <div><Customer r={r} /></div>
                          {r.firstItem && <div className="max-w-[220px] truncate text-xs text-muted-foreground max-[1100px]:max-w-[150px]"><Items r={r} /></div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Num>{r.qty !== undefined ? fmtQty(d(r.qty).minus(d(r.returnedQty)).toString()) : ""}</Num>
                          {d(r.returnedQty).gt(0) && <div className="whitespace-nowrap text-xs text-muted-foreground">{fmtQty(r.returnedQty)} {t("returned", "retourné")}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Num>{usd((voided ? d(r.paidUsd) : n.paid).toFixed(2))}</Num>
                          {!voided && <Refunded value={n.refunded} />}
                          <OnAccount r={r} />
                          {/* What was not paid: owed by the customer. */}
                          {d(voided ? r.creditUsd : creditOf(r)).gt(0) && <div className={cn("whitespace-nowrap text-xs", !voided && "text-amber-800 dark:text-amber-400")}>{t("credit", "crédit")} {usd(voided ? r.creditUsd : creditOf(r))}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Num className={cn("font-medium", voided && "line-through")}>{usd((voided ? d(r.total) : n.total).toFixed(2))}</Num>
                          {!voided && n.returned.gt(0) && <div className="whitespace-nowrap text-xs text-muted-foreground">{t("of", "sur")} {usd(r.total)}</div>}
                        </TableCell>
                        {showCost && <TableCell className="text-right">{n.profit !== undefined ? <Profit value={n.profit.toFixed(2)} muted={voided} /> : ""}</TableCell>}
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{count(t, live.length, ["sale", "sales"], ["vente", "ventes"])}{t(", not counting cancelled ones", ", hors annulées")}</TableCell>
                    <TableCell className="text-right"><Num>{fmtQty(totals.qty.toString())}</Num></TableCell>
                    <TableCell className="text-right">
                      <Num>{usd(totals.paid.toFixed(2))}</Num>
                      <Refunded value={totals.refunded} />
                      {totals.credit.gt(0) && <div className="whitespace-nowrap text-xs font-normal text-amber-800 dark:text-amber-400">{t("credit", "crédit")} {usd(totals.credit.toFixed(2))}</div>}
                    </TableCell>
                    <TableCell className="text-right"><Num>{usd(totals.total.toFixed(2))}</Num></TableCell>
                    {showCost && <TableCell className="text-right"><Profit value={profit.toFixed(2)} /></TableCell>}
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </Card>
          {rows.length >= 500 && <p className="p-3 text-xs text-muted-foreground">{t("Showing the latest 500 sales; narrow the dates to see more.", "Affichage des 500 dernières ventes\u00a0; réduisez la période pour voir plus.")}</p>}
        </>
      )}
    </div>
  );
}
