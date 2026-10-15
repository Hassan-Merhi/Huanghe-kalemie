import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { count, useT } from "@/lib/i18n";
import { cdf, d, date as fmtDate, monthStart, todayLocal, usd } from "@/lib/format";
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
}

interface Daily {
  date: string;
  count: number;
  total: string;
  credit: string;
  voidsCount: number;
  voidsTotal: string;
  byAccount: { account_id: number; name: string; currency: string; usd: string; native: string }[];
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
              <p className="text-3xl font-semibold tabular">{usd(d(data.total).minus(data.voidsTotal).toFixed(2))}</p>
              {data.voidsCount > 0 && (
                <p className="text-sm text-muted-foreground">
                  {count(t, data.voidsCount, ["sale cancelled", "sales cancelled"], ["vente annulée", "ventes annulées"])} (−{usd(data.voidsTotal)})
                </p>
              )}
              {d(data.credit).gt(0) && <p className="text-sm text-amber-600 dark:text-amber-400">{t("of which on credit", "dont à crédit")} {usd(data.credit)}</p>}
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {data.byAccount.length === 0 && <p className="text-sm text-muted-foreground">{t("No money received yet today.", "Aucun encaissement aujourd'hui.")}</p>}
              {data.byAccount.map((a) => (
                <div key={a.account_id} className="rounded-md border px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">{a.name}</p>
                  <p className="font-medium tabular">{a.currency === "CDF" ? cdf(a.native) : usd(a.usd)}</p>
                  {a.currency === "CDF" && <p className="text-xs text-muted-foreground tabular">≈ {usd(a.usd)}</p>}
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
      {zeroPrice && <Badge variant="destructive" className="ml-1">{t("Price 0", "Prix nul")}</Badge>}
      {loss && <Badge variant="outline" className="ml-1 border-amber-600 text-amber-800 dark:border-amber-400 dark:text-amber-300">{t("Below cost", "Vente à perte")}</Badge>}
    </>
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
  const sumOf = (f: (r: SaleListRow) => string | undefined) => live.reduce((s, r) => s.plus(d(f(r))), d(0));
  const totals = { total: sumOf((r) => r.total), paid: sumOf((r) => r.paidUsd), credit: sumOf((r) => r.creditUsd), cogs: sumOf((r) => r.cogs) };

  return (
    <div>
      <PageHeader
        title={t("Sales", "Ventes")}
        description={isCashier ? t("Today's sales.", "Les ventes d'aujourd'hui.") : t("All sales for the chosen dates. Returns are shown on each sale.", "Toutes les ventes de la période. Les retours sont visibles sur chaque vente.")}
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
            <Field label={t("From", "Du")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label={t("To", "Au")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </>
        )}
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No sales", "Aucune vente")}>{t("Sales made at the till appear here.", "Les ventes faites à la caisse apparaissent ici.")}</EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("No.", "N°")}</TableHead>
                  <TableHead>{t("Date", "Date")}</TableHead>
                  <TableHead>{t("Customer", "Client")}</TableHead>
                  <TableHead className="text-right">{t("Total", "Total")}</TableHead>
                  <TableHead className="text-right">{t("Paid", "Payé")}</TableHead>
                  <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                  {showCost && <TableHead className="text-right">{t("Cost", "Coût")}</TableHead>}
                  {showCost && <TableHead className="text-right">{t("Profit", "Marge")}</TableHead>}
                  <TableHead>{t("Cashier", "Caissier")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const voided = r.status === "voided";
                  return (
                    <TableRow key={r.id} className={cn("cursor-pointer", voided && "text-muted-foreground")} onClick={() => navigate(`/sales/${r.id}`)}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {r.number} {voided && <Badge variant="destructive" className="ml-1">{t("Cancelled", "Annulée")}</Badge>}
                        {!voided && <SaleFlags zeroPrice={r.zeroPrice} total={r.total} cogs={r.cogs} />}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                      <TableCell>{r.customerName ?? <span className="text-muted-foreground">{t("Walk-in", "De passage")}</span>}</TableCell>
                      <TableCell className="text-right"><Num className={cn(voided && "line-through")}>{usd(r.total)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(r.paidUsd)}</Num></TableCell>
                      <TableCell className="text-right"><Num className={cn(d(r.creditUsd).gt(0) && !voided && "text-amber-600 dark:text-amber-400")}>{d(r.creditUsd).gt(0) ? usd(r.creditUsd) : ""}</Num></TableCell>
                      {showCost && <TableCell className="text-right"><Num>{r.cogs !== undefined ? usd(r.cogs) : ""}</Num></TableCell>}
                      {showCost && <TableCell className="text-right"><Num>{r.cogs !== undefined ? usd(d(r.total).minus(r.cogs).toFixed(2)) : ""}</Num></TableCell>}
                      <TableCell className="whitespace-nowrap text-muted-foreground">{r.cashier ?? ""}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3}>{count(t, live.length, ["sale", "sales"], ["vente", "ventes"])}{t(", not counting cancelled ones", ", hors annulées")}</TableCell>
                  <TableCell className="text-right"><Num>{usd(totals.total.toFixed(2))}</Num></TableCell>
                  <TableCell className="text-right"><Num>{usd(totals.paid.toFixed(2))}</Num></TableCell>
                  <TableCell className="text-right"><Num>{usd(totals.credit.toFixed(2))}</Num></TableCell>
                  {showCost && <TableCell className="text-right"><Num>{usd(totals.cogs.toFixed(2))}</Num></TableCell>}
                  {showCost && <TableCell className="text-right"><Num>{usd(totals.total.minus(totals.cogs).toFixed(2))}</Num></TableCell>}
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
          {rows.length >= 500 && <p className="p-3 text-xs text-muted-foreground">{t("Showing the latest 500 sales; narrow the dates to see more.", "Affichage des 500 dernières ventes\u00a0; réduisez la période pour voir plus.")}</p>}
        </Card>
      )}
    </div>
  );
}
