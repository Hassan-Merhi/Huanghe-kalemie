import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, Download, Percent, Printer, Search, ShoppingCart, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard, SubmitButton } from "@/components/common";
import { useToast } from "@/hooks/use-toast";
import { api, invalidateAll } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { d, date as fmtDate, qty as fmtQty, todayLocal, unitCost, usd, variantText } from "@/lib/format";
import { count, useT } from "@/lib/i18n";
import { downloadCsv, downloadXlsx } from "@/lib/sheets";
import type { VariantRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WIDE_PRINT_CSS } from "@/pages/ContactDetail";

interface StockItem {
  variantId: number;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  productName: string;
  categoryName: string | null;
  unit: string;
  qty: string;
  sellPrice: string;
  reorderLevel: string;
  avgCost: string;
  low: boolean;
}

/** One row of the price list, whichever endpoint it came from. */
interface Row {
  variantId: number;
  productName: string;
  attributes: Record<string, string>;
  sku: string;
  categoryName: string | null;
  sellPrice: string;
  qty: string;
  reorderLevel: string;
  avgCost: string | null;
  low: boolean;
}

/** Managers and partners read /api/stock; cashiers are not allowed there and use /api/variants. */
function usePriceRows(search: string) {
  const { can } = useAuth();
  const readsStock = can("manager", "partner");
  const stockQ = useQuery<{ items: StockItem[] }>({ queryKey: ["/api/stock"], enabled: readsStock });
  const [term, setTerm] = useState(search);
  useEffect(() => {
    const h = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(h);
  }, [search]);
  const variantsQ = useQuery<VariantRow[]>({ queryKey: ["/api/variants", { search: term, limit: 500 }], enabled: !readsStock });
  const rows: Row[] = useMemo(() => {
    if (readsStock)
      return (stockQ.data?.items ?? []).map((i) => ({
        variantId: i.variantId, productName: i.productName, attributes: i.attributes, sku: i.sku, categoryName: i.categoryName,
        sellPrice: i.sellPrice, qty: i.qty, reorderLevel: i.reorderLevel, avgCost: i.avgCost, low: i.low,
      }));
    return (variantsQ.data ?? []).map((v) => ({
      variantId: v.id, productName: v.productName, attributes: v.attributes, sku: v.sku, categoryName: v.categoryName,
      sellPrice: v.sellPrice, qty: v.stockQty, reorderLevel: v.reorderLevel, avgCost: null,
      low: d(v.stockQty).lte(d(v.reorderLevel)),
    }));
  }, [readsStock, stockQ.data, variantsQ.data]);
  const q = readsStock ? stockQ : variantsQ;
  return { rows, isLoading: q.isLoading, error: q.error, serverSearch: !readsStock };
}

export default function SalesTools() {
  const t = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState("prices");
  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <PageHeader
        title={t("Sales tools", "Outils de vente")}
        description={t("Price list, restocking and today's sales.", "Liste de prix, réapprovisionnement et ventes du jour.")}
        actions={<Button asChild><Link href="/pos"><ShoppingCart className="mr-1 h-4 w-4" /> {t("Point of sale", "Caisse")}</Link></Button>}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="prices">{t("Price list", "Liste de prix")}</TabsTrigger>
            {can("manager", "partner") && <TabsTrigger value="reorder">{t("Restocking", "Réapprovisionnement")}</TabsTrigger>}
            <TabsTrigger value="today">{t("Today's sales", "Ventes du jour")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="prices"><PriceList /></TabsContent>
        {can("manager", "partner") && <TabsContent value="reorder"><Reorder /></TabsContent>}
        <TabsContent value="today"><TodaySales /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- Price list

const NO_CAT = "__none__";

function PriceList() {
  const t = useT();
  const { can } = useAuth();
  const canEdit = can("manager");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [bulkOpen, setBulkOpen] = useState(false);
  const { rows, isLoading, error, serverSearch } = usePriceRows(search);

  const categories = useMemo(() => Array.from(new Set(rows.map((r) => r.categoryName ?? NO_CAT))).sort(), [rows]);
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows
      .filter((r) => category === "all" || (r.categoryName ?? NO_CAT) === category)
      .filter((r) => serverSearch || !s || `${r.productName} ${variantText(r.attributes)} ${r.sku}`.toLowerCase().includes(s))
      .sort((a, b) => (a.categoryName ?? "").localeCompare(b.categoryName ?? "") || a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku));
  }, [rows, category, search, serverSearch]);

  const header = [t("Category", "Catégorie"), t("Item", "Article"), t("Variant", "Variante"), t("SKU", "Code"), t("Price ($)", "Prix ($)"), t("Stock", "Stock")];
  const table = () => [header, ...filtered.map((r) => [r.categoryName ?? "", r.productName, variantText(r.attributes), r.sku, Number(r.sellPrice), Number(r.qty)])];
  const catLabel = (c: string) => (c === NO_CAT ? t("No category", "Sans catégorie") : c);

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-end gap-2">
        <Field label={t("Search", "Rechercher")} className="min-w-[200px] flex-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Name, size, SKU…", "Nom, taille, code…")} />
          </div>
        </Field>
        <Field label={t("Category", "Catégorie")} className="w-48">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All categories", "Toutes les catégories")}</SelectItem>
              {categories.map((c) => <SelectItem key={c} value={c}>{catLabel(c)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="outline" onClick={() => setBulkOpen(true)} disabled={!filtered.length}>
              <Percent className="mr-1 h-4 w-4" /> {t("Change by %", "Modifier en %")}
            </Button>
          )}
          <Button variant="outline" onClick={() => window.print()} disabled={!filtered.length}><Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}</Button>
          <Button variant="outline" onClick={() => downloadCsv(`${t("price-list", "liste-de-prix")}_${todayLocal()}.csv`, table())} disabled={!filtered.length}><Download className="mr-1 h-4 w-4" /> CSV</Button>
          <Button variant="outline" onClick={() => downloadXlsx(`${t("price-list", "liste-de-prix")}_${todayLocal()}.xlsx`, table(), t("Prices", "Prix"))} disabled={!filtered.length}><Download className="mr-1 h-4 w-4" /> Excel</Button>
        </div>
      </div>
      {canEdit && filtered.length > 0 && (
        <p className="no-print text-xs text-muted-foreground">
          {t("Change a price, then press Enter or the tick to save it. Each price is saved on its own.", "Modifiez un prix puis appuyez sur Entrée ou sur la coche pour l'enregistrer. Chaque prix est enregistré séparément.")}
        </p>
      )}
      {serverSearch && <p className="no-print text-xs text-muted-foreground">{t("Showing up to 500 items; search to narrow down.", "Jusqu'à 500 articles affichés\u00a0; cherchez pour affiner.")}</p>}
      <ErrorText error={error} />
      {isLoading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState title={t("No items", "Aucun article")} />
      ) : (
        <Card className="print-area print-wide">
          <CardHeader className="hidden p-2 print:block">
            <CardTitle className="text-base">Huanghe Kalemie · {t("Price list", "Liste de prix")} · {fmtDate(todayLocal())}{category !== "all" ? ` · ${catLabel(category)}` : ""}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead className="hidden sm:table-cell print:table-cell">{t("Variant", "Variante")}</TableHead>
                    <TableHead className="hidden md:table-cell print:table-cell">{t("SKU", "Code")}</TableHead>
                    <TableHead className="text-right">{t("Price ($)", "Prix ($)")}</TableHead>
                    <TableHead className="text-right">{t("Stock", "Stock")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.variantId}>
                      <TableCell className="min-w-[150px]">
                        <div className="font-medium">{r.productName}</div>
                        <div className="text-xs text-muted-foreground sm:hidden print:hidden">{[variantText(r.attributes), r.sku].filter(Boolean).join(" · ")}</div>
                        <div className="hidden text-xs text-muted-foreground sm:block md:hidden print:hidden">{r.sku}</div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell print:table-cell">{variantText(r.attributes) || "—"}</TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell print:table-cell">{r.sku}</TableCell>
                      <TableCell className="text-right">
                        {canEdit ? <PriceCell row={r} /> : <Num className="font-medium">{usd(r.sellPrice)}</Num>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Num className={cn(d(r.qty).lte(0) && "text-destructive", r.low && d(r.qty).gt(0) && "text-amber-800 dark:text-amber-400")}>{fmtQty(r.qty)}</Num>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {bulkOpen && <BulkPriceDialog rows={filtered} onClose={() => setBulkOpen(false)} />}
    </div>
  );
}

function PriceCell({ row }: { row: Row }) {
  const t = useT();
  const { toast } = useToast();
  const [value, setValue] = useState(d(row.sellPrice).toFixed(2));
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(d(row.sellPrice).toFixed(2)), [row.sellPrice]);
  const valid = /^\d+(\.\d{1,2})?$/.test(value.trim());
  const changed = valid && !d(value).eq(d(row.sellPrice));

  async function save() {
    if (!changed) {
      if (!valid) setValue(d(row.sellPrice).toFixed(2));
      return;
    }
    setSaving(true);
    try {
      await api("PATCH", `/api/variants/${row.variantId}`, { sellPrice: d(value).toFixed(2) });
      await invalidateAll();
      toast({ title: t(`Price of ${row.sku} saved`, `Prix de ${row.sku} enregistré`) });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), variant: "destructive" });
      setValue(d(row.sellPrice).toFixed(2));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="no-print flex items-center justify-end gap-1 print:hidden">
        <Input
          className={cn("h-8 w-24 text-right tabular", !valid && "border-destructive", changed && "border-primary")}
          inputMode="decimal"
          value={value}
          disabled={saving}
          aria-label={t("Sell price", "Prix de vente")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setValue(d(row.sellPrice).toFixed(2));
          }}
        />
        {(changed || !valid) && (
          <>
            <Button size="icon" className="h-8 w-8" disabled={!changed || saving} onClick={save} aria-label={t("Save price", "Enregistrer le prix")} title={t("Save", "Enregistrer")}>
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8" disabled={saving} onClick={() => setValue(d(row.sellPrice).toFixed(2))} aria-label={t("Undo", "Annuler")} title={t("Undo", "Annuler")}>
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
      <Num className="hidden font-medium print:inline">{usd(row.sellPrice)}</Num>
    </>
  );
}

function BulkPriceDialog({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const [pct, setPct] = useState("");
  const [round, setRound] = useState("0.01");
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(null);
  const valid = /^-?\d+(\.\d+)?$/.test(pct.trim()) && !d(pct).isZero() && d(pct).gt(-100);
  const step = d(round);

  const changes = useMemo(() => {
    if (!valid) return [];
    const factor = d(1).plus(d(pct).div(100));
    return rows
      .map((r) => {
        const raw = d(r.sellPrice).times(factor);
        const next = raw.div(step).toDecimalPlaces(0).times(step).toFixed(2);
        return { r, next };
      })
      .filter((c) => !d(c.next).eq(d(c.r.sellPrice)));
  }, [rows, pct, valid, step]);

  // One request for the whole list: either every price changes or none does.
  async function apply() {
    setProgress({ done: 0, failed: 0 });
    try {
      const res = await api<{ updated: number }>("POST", "/api/import/prices", { rows: changes.map((c) => ({ sku: c.r.sku, sellPrice: c.next })) });
      setProgress({ done: res.updated, failed: 0 });
      await invalidateAll();
      toast({ title: t(`${res.updated} prices updated`, `${res.updated} prix mis à jour`) });
      onClose();
    } catch (e) {
      setProgress(null);
      toast({ title: (e as Error).message, variant: "destructive" });
    }
  }

  const running = progress !== null;
  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Change prices by a percentage", "Modifier les prix en pourcentage")}</DialogTitle>
          <DialogDescription>
            {t(`Applies to the ${count(t, rows.length, ["item", "items"], ["article", "articles"])} currently shown (search and category filter).`, `S'applique aux ${count(t, rows.length, ["item", "items"], ["article affiché", "articles affichés"])} (recherche et filtre de catégorie).`)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Change (%)", "Variation (%)")} hint={t("e.g. 10 to raise, -5 to lower", "ex. 10 pour augmenter, -5 pour baisser")}
            error={pct.trim() && !valid ? t("Enter a number other than 0, above -100", "Saisissez un nombre différent de 0 et supérieur à -100") : null}
            required
          >
            <Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} disabled={running} placeholder="10" />
          </Field>
          <Field label={t("Round to", "Arrondir à")}>
            <Select value={round} onValueChange={setRound} disabled={running}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0.01">$0.01</SelectItem>
                <SelectItem value="0.5">$0.50</SelectItem>
                <SelectItem value="1">$1</SelectItem>
                <SelectItem value="5">$5</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {valid && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{changes.length === 1 ? t("1 price will change.", "1 prix va changer.") : t(`${changes.length} prices will change.`, `${changes.length} prix vont changer.`)}</p>
            <div className="max-h-64 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead className="text-right">{t("Now", "Actuel")}</TableHead>
                    <TableHead className="text-right">{t("New", "Nouveau")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changes.slice(0, 200).map((c) => (
                    <TableRow key={c.r.variantId}>
                      <TableCell>
                        <div className="text-sm font-medium">{c.r.productName}</div>
                        <div className="text-xs text-muted-foreground">{[variantText(c.r.attributes), c.r.sku].filter(Boolean).join(" · ")}</div>
                      </TableCell>
                      <TableCell className="text-right"><Num className="text-muted-foreground">{usd(c.r.sellPrice)}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-medium">{usd(c.next)}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {changes.length > 200 && <p className="text-xs text-muted-foreground">{t(`…and ${changes.length - 200} more`, `…et ${changes.length - 200} de plus`)}</p>}
          </div>
        )}
        {progress && (
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${changes.length ? ((progress.done + progress.failed) / changes.length) * 100 : 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground tabular">{progress.done + progress.failed} / {changes.length}{progress.failed ? ` · ${progress.failed} ${t("failed", "en échec")}` : ""}</p>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={running}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            onClick={apply}
            blocked={!pct.trim() ? t("Enter a percentage", "Saisissez un pourcentage") : !valid ? t("Fix the percentage", "Corrigez le pourcentage") : !changes.length && t("No price would change", "Aucun prix ne changerait")}
            pending={running}
          >
            {t("Apply to", "Appliquer à")} {count(t, changes.length, ["item", "items"], ["article", "articles"])}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Restocking

function Reorder() {
  const t = useT();
  const q = useQuery<{ items: StockItem[] }>({ queryKey: ["/api/stock"] });
  const rows = useMemo(
    () =>
      (q.data?.items ?? [])
        .filter((i) => i.low || d(i.qty).lte(0))
        .map((i) => {
          const suggested = d(i.reorderLevel).times(2).minus(d(i.qty));
          return { ...i, suggested: suggested.gt(0) ? suggested : d(d(i.reorderLevel).gt(0) ? 0 : 1) };
        })
        .sort((a, b) => d(a.qty).comparedTo(d(b.qty)) || a.productName.localeCompare(b.productName)),
    [q.data],
  );
  const cost = rows.reduce((s, r) => s.plus(r.suggested.times(d(r.avgCost))), d(0));

  function exportXlsx() {
    downloadXlsx(`${t("restocking", "reapprovisionnement")}_${todayLocal()}.xlsx`, [
      [t("Category", "Catégorie"), t("Item", "Article"), t("Variant", "Variante"), t("SKU", "Code"), t("Qty", "Qté"), t("Reorder level", "Seuil"), t("Suggested order", "Commande suggérée"), t("Average cost", "Coût moyen")],
      ...rows.map((r) => [r.categoryName ?? "", r.productName, variantText(r.attributes), r.sku, Number(r.qty), Number(r.reorderLevel), Number(r.suggested.toString()), Number(r.avgCost)]),
    ], t("Restocking", "Réappro"));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t("Items at or below their reorder level, and items out of stock. Suggested order = 2 × reorder level − quantity.", "Articles au seuil de réapprovisionnement ou en dessous, et articles en rupture. Commande suggérée = 2 × seuil − quantité.")}
        </p>
        <Button variant="outline" onClick={exportXlsx} disabled={!rows.length}><Download className="mr-1 h-4 w-4" /> Excel</Button>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={t("Nothing to reorder", "Rien à réapprovisionner")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className="text-right">{t("Reorder level", "Seuil")}</TableHead>
                    <TableHead className="text-right">{t("Suggested", "Suggéré")}</TableHead>
                    <TableHead className="text-right">{t("Avg cost", "Coût moyen")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.variantId}>
                      <TableCell className="min-w-[150px]">
                        <div className="font-medium">{r.productName}</div>
                        <div className="text-xs text-muted-foreground">{[variantText(r.attributes), r.sku].filter(Boolean).join(" · ")}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        {d(r.qty).lte(0) ? <Badge variant="destructive">{fmtQty(r.qty)}</Badge> : <Num className="text-amber-800 dark:text-amber-400">{fmtQty(r.qty)}</Num>}
                      </TableCell>
                      <TableCell className="text-right"><Num>{fmtQty(r.reorderLevel)}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-semibold">{fmtQty(r.suggested.toString())}</Num></TableCell>
                      <TableCell className="text-right"><Num>{unitCost(r.avgCost)}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="border-t p-3 text-right text-sm text-muted-foreground">
              {t("Estimated cost of the suggested order", "Coût estimé de la commande suggérée")} : <span className="font-medium text-foreground tabular">{usd(cost.toFixed(2))}</span>
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Today's sales

interface SaleListRow {
  id: number;
  number: string;
  date: string;
  status: "completed" | "voided";
  total: string;
  paidUsd: string;
  creditUsd: string;
  customerName: string | null;
  cashier: string | null;
  createdAt?: string;
}

function TodaySales() {
  const t = useT();
  const today = todayLocal();
  const q = useQuery<SaleListRow[]>({ queryKey: ["/api/sales", { from: today, to: today }] });
  const sales = q.data ?? [];
  const live = sales.filter((s) => s.status !== "voided");
  const total = live.reduce((s, x) => s.plus(d(x.total)), d(0));
  const credit = live.reduce((s, x) => s.plus(d(x.creditUsd)), d(0));
  const paid = live.reduce((s, x) => s.plus(d(x.paidUsd)), d(0));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("Sales", "Ventes")} value={live.length} sub={fmtDate(today)} />
        <StatCard label={t("Total", "Total")} value={usd(total.toFixed(2))} />
        <StatCard label={t("Paid", "Encaissé")} value={usd(paid.toFixed(2))} tone="good" />
        <StatCard label={t("On credit", "À crédit")} value={usd(credit.toFixed(2))} tone={credit.gt(0) ? "bad" : "neutral"} />
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : sales.length === 0 ? (
        <EmptyState title={t("No sales yet today", "Pas encore de ventes aujourd'hui")}>
          <Button asChild className="mt-2"><Link href="/pos"><ShoppingCart className="mr-1 h-4 w-4" /> {t("Open the point of sale", "Ouvrir la caisse")}</Link></Button>
        </EmptyState>
      ) : (
        <Card>
          <CardContent className="divide-y p-0 text-sm">
            {sales.map((s) => (
              <Link key={s.id} href={`/sales/${s.id}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-muted/50">
                <span className="min-w-0">
                  <span className="font-medium">{s.number}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.customerName ?? t("walk-in", "de passage")}{s.cashier ? ` · ${s.cashier}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <Num className={s.status === "voided" ? "text-muted-foreground line-through" : "font-medium"}>{usd(s.total)}</Num>
                  {s.status === "voided" ? (
                    <Badge variant="destructive">{t("Cancelled", "Annulée")}</Badge>
                  ) : d(s.creditUsd).gt(0) ? (
                    <span className="text-xs text-amber-800 dark:text-amber-400">{t("credit", "crédit")} {usd(s.creditUsd)}</span>
                  ) : null}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
