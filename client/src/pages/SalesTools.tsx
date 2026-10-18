import { useEffect, useMemo, useRef, useState } from "react";
import { de } from "@shared/french";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, Download, Percent, Printer, Search, ShoppingCart, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard, SubmitButton } from "@/components/common";
import { useToast } from "@/hooks/use-toast";
import { api, invalidateAll } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { d, date as fmtDate, MINUS, pct as fmtPct, qty as fmtQty, todayLocal, usd, variantText } from "@/lib/format";
import { count, useT } from "@/lib/i18n";
import { downloadCsv, downloadXlsx } from "@/lib/sheets";
import type { VariantRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { creditSplit, dailyFigures, netOf, type Daily, type SaleListRow } from "@/lib/saleRows";
import { WIDE_PRINT_CSS } from "@/pages/ContactDetail";
import { OnAccount } from "@/pages/Sales";

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
  const [tab, setTab] = useState("prices");
  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <PageHeader
        title={t("Sales tools", "Outils de vente")}
        description={t("Price list and today's sales.", "Liste de prix et ventes du jour.")}
        actions={<Button asChild><Link href="/pos"><ShoppingCart className="mr-1 h-4 w-4" /> {t("Point of sale", "Caisse")}</Link></Button>}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="prices">{t("Price list", "Liste de prix")}</TabsTrigger>
            <TabsTrigger value="today">{t("Today's sales", "Ventes du jour")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="prices"><PriceList /></TabsContent>
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
              <Percent className="mr-1 h-4 w-4" /> {t("Change by %", "Modifier en\u00a0%")}
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
  // "220" for 22 or "145" for 1 450: a price ten times off saves like any other, so a big jump, or a price
  // below what the item cost, is asked about first. The server's own price rules stay as they are.
  const old = d(row.sellPrice);
  const gap = changed && old.gt(0) ? d(value).minus(old).dividedBy(old).times(100) : null;
  const farOff = !!gap && gap.abs().gt(50);
  const belowCost = changed && !!row.avgCost && d(row.avgCost).gt(0) && d(value).lt(d(row.avgCost));
  const [confirming, setConfirming] = useState(false);
  // "Corriger" goes back to the field with the unsaved price selected, to type over it; Escape or ✕ restores the saved one.
  const input = useRef<HTMLInputElement>(null);

  async function save(confirmed = false) {
    if (!changed) {
      if (!valid) setValue(d(row.sellPrice).toFixed(2));
      return;
    }
    if (!confirmed && (farOff || belowCost)) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setSaving(true);
    try {
      await api("PATCH", `/api/variants/${row.variantId}`, { sellPrice: d(value).toFixed(2) });
      await invalidateAll();
      toast({ title: t(`Price of ${row.sku} saved`, `Prix ${de(row.sku)} enregistré`) });
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
          ref={input}
          className={cn("h-8 w-24 text-right tabular", !valid && "border-destructive", changed && "border-primary")}
          inputMode="decimal" usd
          value={value}
          disabled={saving}
          aria-label={t("Sell price", "Prix de vente")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Else the same key press lands on the question's first button, which opens with the focus.
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") setValue(d(row.sellPrice).toFixed(2));
          }}
        />
        {(changed || !valid) && (
          <>
            <Button size="icon" className="h-8 w-8" disabled={!changed || saving} onClick={() => void save()} aria-label={t("Save price", "Enregistrer le prix")} title={t("Save", "Enregistrer")}>
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8" disabled={saving} onClick={() => setValue(d(row.sellPrice).toFixed(2))} aria-label={t("Undo", "Annuler")} title={t("Undo", "Annuler")}>
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
      {changed && !saving && (
        <p className="no-print mt-0.5 text-right text-xs text-amber-800 dark:text-amber-400 print:hidden" data-testid="price-unsaved">
          {t(`Not saved (${usd(row.sellPrice)})`, `Non enregistré (${usd(row.sellPrice)})`)}
        </p>
      )}
      <Num className="hidden font-medium print:inline">{usd(row.sellPrice)}</Num>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            if (!changed) return;
            e.preventDefault();
            input.current?.focus();
            input.current?.select();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Save this price?", "Enregistrer ce prix\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                <p>
                  {row.productName}
                  {variantText(row.attributes) ? ` · ${variantText(row.attributes)}` : ""} ({row.sku})
                </p>
                {farOff && gap && (
                  <p className="font-medium text-amber-800 dark:text-amber-400">
                    {t(
                      `The price goes from ${usd(old.toFixed(2))} to ${usd(d(value).toFixed(2))} (${gap.gt(0) ? "+" : MINUS}${fmtPct(gap.abs().toDecimalPlaces(0).toString(), 0)}).`,
                      `Le prix passe de ${usd(old.toFixed(2))} à ${usd(d(value).toFixed(2))} (${gap.gt(0) ? "+" : MINUS}${fmtPct(gap.abs().toDecimalPlaces(0).toString(), 0)}).`,
                    )}
                  </p>
                )}
                {belowCost && (
                  <p className="font-medium text-destructive">
                    {t(
                      `${usd(d(value).toFixed(2))} is below what it cost on average (${usd(d(row.avgCost).toFixed(2))}): each sale would lose money.`,
                      `${usd(d(value).toFixed(2))} est sous son coût moyen (${usd(d(row.avgCost).toFixed(2))})\u00a0: chaque vente perdrait de l'argent.`,
                    )}
                  </p>
                )}
                <p>{t("Check for a missing or extra zero before saving.", "Vérifiez qu'il ne manque pas un zéro, ou qu'il n'y en a pas un de trop.")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save(true)}>{t("Save anyway", "Enregistrer quand même")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BulkPriceDialog({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const [typedPct, setPct] = useState("");
  // The hint writes "−5" with the true minus sign: typed (or pasted) that way, it reads as "-5".
  const pct = typedPct.trim().replace(/^[\u2212\u2013]/, "-");
  const [round, setRound] = useState("0.01");
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(null);
  const valid = /^-?\d+(\.\d+)?$/.test(pct) && !d(pct).isZero() && d(pct).gt(-100);
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
          <Field label={t("Change (%)", "Variation (%)")} hint={t(`e.g. 10 to raise, ${MINUS}5 to lower`, `ex. 10 pour augmenter, ${MINUS}5 pour baisser`)}
            error={pct.trim() && !valid ? t(`Enter a number other than 0, above ${MINUS}100`, `Saisissez un nombre différent de 0 et supérieur à ${MINUS}100`) : null}
            required
          >
            <Input inputMode="decimal" value={typedPct} onChange={(e) => setPct(e.target.value)} disabled={running} placeholder="10" />
          </Field>
          <Field label={t("Round to", "Arrondir à")}>
            <Select value={round} onValueChange={setRound} disabled={running}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {/* Written as the prices are ("0,50 $"), whole dollars without cents. */}
                <SelectItem value="0.01">{usd("0.01")}</SelectItem>
                <SelectItem value="0.5">{usd("0.5")}</SelectItem>
                <SelectItem value="1">{t("$1", "1\u00a0$")}</SelectItem>
                <SelectItem value="5">{t("$5", "5\u00a0$")}</SelectItem>
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

// ---------------------------------------------------------------- Today's sales

function TodaySales() {
  const t = useT();
  const today = todayLocal();
  const q = useQuery<SaleListRow[]>({ queryKey: ["/api/sales", { from: today, to: today }] });
  // The figures are the "Aujourd'hui" card's (Sales, dashboard, Caisse du jour): net of returns and refunds, and
  // the credit an avoir covered apart from what is still owed. Each sale below reads as on the Sales list.
  const daily = useQuery<Daily>({ queryKey: ["/api/reports/daily", { date: today }] });
  const fig = daily.data ? dailyFigures(daily.data) : null;
  const sales = q.data ?? [];
  const dash = "—";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("Sales", "Ventes")} value={fig ? fig.count : dash} sub={fmtDate(today)} />
        <StatCard
          label={t("Total", "Total")}
          value={fig ? usd(fig.total.toFixed(2)) : dash}
          sub={daily.data && d(daily.data.returnsTotal).gt(0) ? `${t("returns", "retours")} −${usd(daily.data.returnsTotal)}` : undefined}
        />
        <StatCard
          label={t("Paid", "Encaissé")}
          value={fig ? usd(fig.paid.toFixed(2)) : dash}
          tone="good"
          sub={fig?.refunded.gt(0) ? `${t("of which refunded", "dont remboursé")} −${usd(fig.refunded.toFixed(2))}` : undefined}
        />
        <StatCard
          label={t("On credit", "À crédit")}
          value={fig ? usd(fig.owedCredit.toFixed(2)) : dash}
          tone={fig?.owedCredit.gt(0) ? "bad" : "neutral"}
          sub={fig?.onAvoir.gt(0) ? <span className="text-emerald-800 dark:text-emerald-400">{t("from customers' credit", "sur l'avoir")} {usd(fig.onAvoir.toFixed(2))}</span> : undefined}
        />
      </div>
      <ErrorText error={q.error ?? daily.error} />
      {q.isLoading ? (
        <Loading />
      ) : sales.length === 0 ? (
        <EmptyState title={t("No sales yet today", "Pas encore de ventes aujourd'hui")}>
          <Button asChild className="mt-2"><Link href="/pos"><ShoppingCart className="mr-1 h-4 w-4" /> {t("Open the point of sale", "Ouvrir la caisse")}</Link></Button>
        </EmptyState>
      ) : (
        <Card>
          <CardContent className="divide-y p-0 text-sm">
            {sales.map((s) => {
              const voided = s.status === "voided";
              const n = netOf(s);
              const c = creditSplit(s);
              return (
                <Link key={s.id} href={`/sales/${s.id}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-muted/50">
                  <span className="min-w-[40%]">
                    <span className="font-medium">{s.number}</span>
                    {/* Wraps rather than cut: on a phone the cashier's name is part of what the line says. */}
                    <span className="block break-words text-xs text-muted-foreground">
                      {s.customerName ?? t("walk-in", "de passage")}{s.cashier ? ` · ${s.cashier}` : ""}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col items-end gap-0.5 text-right">
                    <Num className={voided ? "text-muted-foreground line-through" : "font-medium"}>{usd((voided ? d(s.total) : n.total).toFixed(2))}</Num>
                    {voided ? (
                      <Badge variant="destructive">{t("Cancelled", "Annulée")}</Badge>
                    ) : (
                      <>
                        {/* One figure a line, so the customer's name keeps its room on a phone. */}
                        {n.returned.gt(0) && <span className="whitespace-nowrap text-xs text-muted-foreground">{t("returns", "retours")} −{usd(n.returned.toFixed(2))}</span>}
                        {n.refunded.gt(0) && <span className="whitespace-nowrap text-xs text-muted-foreground">{t("refunded", "remboursé")} −{usd(n.refunded.toFixed(2))}</span>}
                        {/* "+4,00 $ sur le compte client", "arrondi FC": as on the Sales list. */}
                        <OnAccount r={s} />
                        {c.onAvoir.gt(0) && <span className="whitespace-nowrap text-xs text-emerald-800 dark:text-emerald-400">{t("from credit", "sur l'avoir")} {usd(c.onAvoir.toFixed(2))}</span>}
                        {c.owed.gt(0) && <span className="whitespace-nowrap text-xs text-amber-800 dark:text-amber-400">{t("credit", "crédit")} {usd(c.owed.toFixed(2))}</span>}
                      </>
                    )}
                  </span>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
