import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "wouter";
import { ChevronDown, ChevronRight, FileUp, MapPin, Search, SlidersHorizontal, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionLinks } from "@/components/AppLayout";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { VariantSearch } from "@/components/pickers";
import { useAuth } from "@/lib/auth";
import { useI18n, useT, count } from "@/lib/i18n";
import { d, date as fmtDate, money, qty, qtyTotal, todayLocal, unitCost, usd, variantText } from "@/lib/format";
import { qtyWithUnit, unitKey } from "@/lib/units";
import { downloadCsv } from "@/lib/sheets";
import type { VariantRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CsvButton } from "@/pages/Reports";
import { ContainerStatusBadge, type ContainerStatus } from "@/pages/Containers";

// ---------------------------------------------------------------- Types

interface LocationRow {
  locationId: number;
  locationName: string;
  variantId: number;
  sku: string;
  attributes: Record<string, string>;
  productId: number;
  productName: string;
  categoryName: string | null;
  unit: string | null;
  qty: string;
  avgCost: string;
  value: string;
  retailValue: string;
}

interface OnTheWayRow {
  containerId: number;
  containerNumber: string;
  status: ContainerStatus;
  supplierName: string | null;
  shipDate: string | null;
  arrivalDate: string | null;
  currency: string;
  rateToUsd: string;
  variantId: number;
  sku: string;
  attributes: Record<string, string>;
  productName: string;
  categoryName: string | null;
  unit?: string | null;
  quantity: string;
  unitPrice: string;
  fobUsd: string;
}

/** What lines on the way add up to, with their unit ("103 pièces"), or null when units differ (litres and pieces). */
function onTheWayQty(t: (en: string, fr: string) => string, rows: OnTheWayRow[]): string | null {
  if (rows.length === 0 || new Set(rows.map((r) => unitKey(r.unit))).size > 1) return null;
  return qtyWithUnit(t, rows.reduce((s, r) => s.plus(r.quantity), d(0)).toString(), rows[0].unit);
}

interface AsOfData {
  asOf: string;
  items: { variantId: number; sku: string; attributes: Record<string, string>; productId: number; productName: string; categoryName: string | null; unit: string | null; qty: string; value: string }[];
  totalValue: string;
}

interface MonthlyData {
  variant: { id: number; sku: string; attributes: Record<string, string>; productName: string; unit: string | null; productId?: number };
  year: number;
  openingQty: string;
  openingValue: string;
  months: { month: number | string; inQty: string; inValue: string; outQty: string; outValue: string; closingQty: string; closingValue: string }[];
}

const TABS = ["location", "transit", "asof", "item"] as const;
type Tab = (typeof TABS)[number];

const ALL = "all";

function itemLabel(name: string, attributes: Record<string, string> | null | undefined) {
  const v = variantText(attributes);
  return v ? `${name} · ${v}` : name;
}

function matches(term: string, ...fields: (string | null | undefined)[]) {
  const s = term.trim().toLowerCase();
  if (!s) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(s));
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input className="pl-9" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function CategoryFilter({ value, onChange, names }: { value: string; onChange: (v: string) => void; names: string[] }) {
  const t = useT();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-56" aria-label={t("Category", "Catégorie")}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("All categories", "Toutes les catégories")}</SelectItem>
        {names.map((n) => (
          <SelectItem key={n} value={n}>{n}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function categoryNames(rows: { categoryName: string | null }[], none: string) {
  return Array.from(new Set(rows.map((r) => r.categoryName ?? none))).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- Page

export default function Inventory() {
  const t = useT();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "location";
  const setTab = (v: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (v === "location") next.delete("tab");
      else next.set("tab", v);
      return next;
    }, { replace: true });

  return (
    <div>
      <PageHeader
        title={t("Inventory", "Inventaire")}
        description={t(
          "Stock by location, goods on the way, stock at a date and the monthly history of an item.",
          "Le stock par emplacement, la marchandise en route, le stock à une date et l'historique mensuel d'un article.",
        )}
        actions={
          can("manager") && (
            <>
              <Button variant="outline" asChild>
                <Link href="/stock"><SlidersHorizontal className="mr-1 h-4 w-4" /> {t("Adjust stock", "Ajuster le stock")}</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/stock/import"><FileUp className="mr-1 h-4 w-4" /> {t("Import", "Importer")}</Link>
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="location">{t("By location", "Par emplacement")}</TabsTrigger>
          <TabsTrigger value="transit">{t("On the way", "En route")}</TabsTrigger>
          <TabsTrigger value="asof">{t("Stock at a date", "Stock à une date")}</TabsTrigger>
          <TabsTrigger value="item">{t("Item history", "Historique d'un article")}</TabsTrigger>
          <SectionLinks />
        </TabsList>
        <TabsContent value="location"><ByLocationTab /></TabsContent>
        <TabsContent value="transit"><OnTheWayTab /></TabsContent>
        <TabsContent value="asof"><AsOfTab /></TabsContent>
        <TabsContent value="item"><ItemHistoryTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- By location

function ByLocationTab() {
  const t = useT();
  const q = useQuery<LocationRow[]>({ queryKey: ["/api/inventory/by-location"] });
  const [location, setLocation] = useState<string>(ALL);
  const [category, setCategory] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const all = useMemo(() => q.data ?? [], [q.data]);
  const none = t("No category", "Sans catégorie");

  const locations = useMemo(() => {
    const map = new Map<number, { id: number; name: string; items: number; value: ReturnType<typeof d>; retail: ReturnType<typeof d> }>();
    for (const r of all) {
      const cur = map.get(r.locationId) ?? { id: r.locationId, name: r.locationName, items: 0, value: d(0), retail: d(0) };
      if (d(r.qty).gt(0)) cur.items += 1;
      cur.value = cur.value.plus(r.value);
      cur.retail = cur.retail.plus(r.retailValue);
      map.set(r.locationId, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);
  const cats = useMemo(() => categoryNames(all, none), [all, none]);

  const rows = all.filter(
    (r) =>
      (location === ALL || String(r.locationId) === location) &&
      (category === ALL || (r.categoryName ?? none) === category) &&
      matches(search, r.productName, r.sku, variantText(r.attributes), r.categoryName),
  );
  const totQty = qtyTotal(rows);
  const totValue = rows.reduce((s, r) => s.plus(r.value), d(0));
  const totRetail = rows.reduce((s, r) => s.plus(r.retailValue), d(0));
  const showLocation = location === ALL && locations.length > 1;

  function csv() {
    downloadCsv(`stock-par-emplacement-${todayLocal()}.csv`, [
      [t("Location", "Emplacement"), t("Item", "Article"), t("Variant", "Variante"), t("SKU", "Code"), t("Category", "Catégorie"), t("Qty", "Qté"), t("Average cost", "Coût moyen"), t("Value", "Valeur"), t("Retail value", "Valeur de vente")],
      ...rows.map((r) => [r.locationName, r.productName, variantText(r.attributes), r.sku, r.categoryName ?? "", r.qty, r.avgCost, r.value, r.retailValue]),
      [t("Total", "Total"), "", "", "", "", totQty, "", totValue.toFixed(2), totRetail.toFixed(2)],
    ]);
  }

  if (q.isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <ErrorText error={q.error} />
      {locations.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {locations.map((l) => {
            const selected = location === String(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => setLocation(selected ? ALL : String(l.id))}
                className={cn("rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50", selected && "border-primary ring-1 ring-primary")}
              >
                <p className="flex items-center gap-1.5 font-medium"><MapPin className="h-4 w-4 text-muted-foreground" /> {l.name}</p>
                <p className="mt-2 text-xl font-semibold tabular">{usd(l.value.toFixed(2))}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {count(t, l.items, ["item in stock", "items in stock"], ["article en stock", "articles en stock"])} · {t("retail", "vente")} {usd(l.retail.toFixed(2))}
                </p>
              </button>
            );
          })}
        </div>
      )}

      <div className={cn("flex flex-wrap items-center gap-2", locations.length <= 1 && "hidden")}>
        <Select value={location} onValueChange={setLocation}>
          <SelectTrigger className="w-full sm:w-56" aria-label={t("Location", "Emplacement")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("All locations", "Tous les emplacements")}</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CategoryFilter value={category} onChange={setCategory} names={cats} />
        <SearchBox value={search} onChange={setSearch} placeholder={t("Search item, SKU, size", "Chercher article, code, taille")} />
        {(location !== ALL || category !== ALL || search) && (
          <Button variant="ghost" size="sm" onClick={() => { setLocation(ALL); setCategory(ALL); setSearch(""); }}>
            <X className="mr-1 h-4 w-4" /> {t("Clear", "Effacer")}
          </Button>
        )}
        <div className="ml-auto"><CsvButton onClick={csv} disabled={rows.length === 0} /></div>
      </div>

      {locations.length <= 1 ? (
        // With one place the per-item list would repeat Stock > Valorisation word for word.
        <p className="text-sm text-muted-foreground">
          {t("With one location, the item-by-item list is in", "Avec un seul emplacement, la liste article par article est dans")}{" "}
          <Link href="/stock" className="font-medium text-primary hover:underline dark:text-orange-400">{t("Stock › Valuation", "Stock › Valorisation")}</Link>.
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title={t("No stock matches", "Aucun stock ne correspond")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    {showLocation && <TableHead className="hidden md:table-cell">{t("Location", "Emplacement")}</TableHead>}
                    <TableHead className="hidden sm:table-cell">{t("Variant", "Variante")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("SKU", "Code")}</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{t("Avg cost", "Coût moyen")}</TableHead>
                    <TableHead className="text-right">{t("Value", "Valeur")}</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">{t("Retail value", "Valeur de vente")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={`${r.locationId}-${r.variantId}`}>
                      <TableCell className="min-w-40">
                        <Link href={`/products/${r.productId}`} className="font-medium hover:underline">{r.productName}</Link>
                        <span className="block text-xs text-muted-foreground sm:hidden">{[variantText(r.attributes), r.sku].filter(Boolean).join(" · ")}</span>
                        {r.categoryName && <span className="hidden text-xs text-muted-foreground sm:block">{r.categoryName}</span>}
                      </TableCell>
                      {showLocation && <TableCell className="hidden md:table-cell">{r.locationName}</TableCell>}
                      <TableCell className="hidden sm:table-cell">{variantText(r.attributes) || "—"}</TableCell>
                      <TableCell className="hidden font-mono text-xs lg:table-cell">{r.sku}</TableCell>
                      <TableCell className="text-right"><Num className={cn(d(r.qty).isNegative() && "text-destructive")}>{qtyWithUnit(t, r.qty, r.unit)}</Num></TableCell>
                      <TableCell className="hidden text-right md:table-cell"><Num>{unitCost(r.avgCost)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(r.value)}</Num></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Num>{usd(r.retailValue)}</Num></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>{t("Total", "Total")} · {count(t, rows.length, ["line", "lines"], ["ligne", "lignes"])}</TableCell>
                    {showLocation && <TableCell className="hidden md:table-cell" />}
                    <TableCell className="hidden sm:table-cell" />
                    <TableCell className="hidden lg:table-cell" />
                    <TableCell className="text-right"><Num>{totQty}</Num></TableCell>
                    <TableCell className="hidden md:table-cell" />
                    <TableCell className="text-right"><Num className="font-semibold">{usd(totValue.toFixed(2))}</Num></TableCell>
                    <TableCell className="hidden text-right sm:table-cell"><Num className="font-semibold">{usd(totRetail.toFixed(2))}</Num></TableCell>
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

// ---------------------------------------------------------------- On the way

function OnTheWayTab() {
  const t = useT();
  const q = useQuery<OnTheWayRow[]>({ queryKey: ["/api/inventory/on-the-way"] });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const all = useMemo(() => q.data ?? [], [q.data]);

  const groups = useMemo(() => {
    const map = new Map<number, { head: OnTheWayRow; lines: OnTheWayRow[] }>();
    for (const r of all) {
      const g = map.get(r.containerId) ?? { head: r, lines: [] };
      g.lines.push(r);
      map.set(r.containerId, g);
    }
    return Array.from(map.values()).sort((a, b) => (a.head.arrivalDate ?? "9999").localeCompare(b.head.arrivalDate ?? "9999"));
  }, [all]);

  const shown = groups
    .map((g) => {
      const headHit = matches(search, g.head.containerNumber, g.head.supplierName);
      const lines = headHit ? g.lines : g.lines.filter((l) => matches(search, l.productName, l.sku, variantText(l.attributes), l.categoryName));
      return { ...g, lines };
    })
    .filter((g) => g.lines.length > 0);

  const kpiQty = onTheWayQty(t, all);
  const kpiFob = all.reduce((s, r) => s.plus(r.fobUsd), d(0));
  const kpiItems = new Set(all.map((r) => r.variantId)).size;

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (q.isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <ErrorText error={q.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("Containers", "Conteneurs")} value={groups.length} />
        <StatCard label={t("Items", "Articles")} value={kpiItems} />
        <StatCard label={t("Quantity", "Quantité")} value={kpiQty ?? "—"} sub={kpiQty ? undefined : t("several units", "plusieurs unités")} />
        <StatCard label={t("FOB value", "Valeur FOB")} value={usd(kpiFob.toFixed(2))} sub="USD" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={search} onChange={setSearch} placeholder={t("Container, supplier or item", "Conteneur, fournisseur ou article")} />
        <p className="text-xs text-muted-foreground">
          {t("FOB value only: landed cost (freight, duties…) is added at offload.", "Valeur FOB seulement\u00a0: le coût de revient (fret, droits…) s'ajoute au déchargement.")}
        </p>
      </div>
      {shown.length === 0 ? (
        <EmptyState title={t("Nothing on the way", "Rien en route")} />
      ) : (
        <div className="space-y-3">
          {shown.map(({ head, lines }) => {
            const isOpen = open.has(head.containerId) || !!search.trim();
            const gQty = onTheWayQty(t, lines);
            const gFob = lines.reduce((s, l) => s.plus(l.fobUsd), d(0));
            return (
              <Card key={head.containerId}>
                <button type="button" className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 p-4 text-left" onClick={() => toggle(head.containerId)}>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/containers/${head.containerId}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{head.containerNumber}</Link>
                        <ContainerStatusBadge status={head.status} />
                      </span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {head.supplierName ?? "—"}
                        {head.shipDate ? ` · ${t("shipped", "expédié")} ${fmtDate(head.shipDate)}` : ""}
                        {head.arrivalDate ? ` · ${t("arrival", "arrivée")} ${fmtDate(head.arrivalDate)}` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="text-right text-sm">
                    <Num className="block font-semibold">{usd(gFob.toFixed(2))}</Num>
                    <span className="block text-xs text-muted-foreground">{count(t, lines.length, ["line", "lines"], ["ligne", "lignes"])}{gQty ? ` · ${gQty}` : ""}</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="overflow-x-auto border-t">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("Item", "Article")}</TableHead>
                          <TableHead className="hidden sm:table-cell">{t("SKU", "Code")}</TableHead>
                          <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                          <TableHead className="hidden text-right sm:table-cell">{t("Unit price", "Prix unitaire")}</TableHead>
                          <TableHead className="text-right">FOB USD</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lines.map((l, i) => (
                          <TableRow key={`${l.variantId}-${i}`}>
                            <TableCell className="min-w-40">
                              <span className="font-medium">{itemLabel(l.productName, l.attributes)}</span>
                              {l.categoryName && <span className="block text-xs text-muted-foreground">{l.categoryName}</span>}
                            </TableCell>
                            <TableCell className="hidden font-mono text-xs sm:table-cell">{l.sku}</TableCell>
                            <TableCell className="text-right"><Num>{qtyWithUnit(t, l.quantity, l.unit)}</Num></TableCell>
                            <TableCell className="hidden text-right sm:table-cell"><Num>{money(l.unitPrice, l.currency)}{l.currency !== "USD" && l.currency !== "CDF" ? ` ${l.currency}` : ""}</Num></TableCell>
                            <TableCell className="text-right"><Num>{usd(l.fobUsd)}</Num></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Stock at a date

function AsOfTab() {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const [category, setCategory] = useState(ALL);
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(true);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day);
  const q = useQuery<AsOfData>({ queryKey: ["/api/inventory/as-of", { date: day }], enabled: valid });
  const none = t("No category", "Sans catégorie");
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const cats = useMemo(() => categoryNames(items, none), [items, none]);
  const rows = items.filter((r) => (category === ALL || (r.categoryName ?? none) === category) && matches(search, r.productName, r.sku, variantText(r.attributes)));
  const totQty = qtyTotal(rows);
  const totValue = rows.reduce((s, r) => s.plus(r.value), d(0));

  const groups = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.categoryName ?? none;
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, none]);

  function csv() {
    downloadCsv(`stock-au-${day}.csv`, [
      [t("Category", "Catégorie"), t("Item", "Article"), t("Variant", "Variante"), t("SKU", "Code"), t("Qty", "Qté"), t("Value", "Valeur")],
      ...rows.map((r) => [r.categoryName ?? "", r.productName, variantText(r.attributes), r.sku, r.qty, r.value]),
      [t("Total", "Total"), "", "", "", totQty, totValue.toFixed(2)],
    ]);
  }

  const renderRow = (r: AsOfData["items"][number]) => (
    <TableRow key={r.variantId}>
      <TableCell className="min-w-40">
        <Link href={`/products/${r.productId}`} className="font-medium hover:underline">{r.productName}</Link>
        {variantText(r.attributes) && <span className="text-muted-foreground"> · {variantText(r.attributes)}</span>}
        <span className="block font-mono text-xs text-muted-foreground sm:hidden">{r.sku}</span>
      </TableCell>
      <TableCell className="hidden font-mono text-xs sm:table-cell">{r.sku}</TableCell>
      <TableCell className="text-right"><Num>{qtyWithUnit(t, r.qty, r.unit)}</Num></TableCell>
      <TableCell className="text-right"><Num>{usd(r.value)}</Num></TableCell>
    </TableRow>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("Stock at", "Stock au")}>
          <Input type="date" className="w-44" value={day} max={todayLocal()} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <CategoryFilter value={category} onChange={setCategory} names={cats} />
        <SearchBox value={search} onChange={setSearch} placeholder={t("Search item or SKU", "Chercher article ou code")} />
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={grouped} onCheckedChange={setGrouped} />
          {t("Group by category", "Grouper par catégorie")}
        </label>
        <div className="ml-auto"><CsvButton onClick={csv} disabled={rows.length === 0} /></div>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <StatCard label={t("Stock value", "Valeur du stock")} value={usd(totValue.toFixed(2))} sub={valid ? fmtDate(day) : undefined} />
            <StatCard label={t("Items", "Articles")} value={rows.length} />
          </div>
          {rows.length === 0 ? (
            <EmptyState title={t("No stock at that date", "Aucun stock à cette date")} />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Item", "Article")}</TableHead>
                        <TableHead className="hidden sm:table-cell">{t("SKU", "Code")}</TableHead>
                        <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                        <TableHead className="text-right">{t("Value", "Valeur")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {grouped
                        ? groups.map(([name, list]) => {
                            const gv = list.reduce((s, r) => s.plus(r.value), d(0));
                            return (
                              <Fragment key={name}>
                                <TableRow className="bg-muted/40 hover:bg-muted/40">
                                  <TableCell className="font-semibold">{name} <span className="font-normal text-muted-foreground">· {list.length}</span></TableCell>
                                  <TableCell className="hidden sm:table-cell" />
                                  <TableCell />
                                  <TableCell className="text-right"><Num className="font-semibold">{usd(gv.toFixed(2))}</Num></TableCell>
                                </TableRow>
                                {list.map(renderRow)}
                              </Fragment>
                            );
                          })
                        : rows.map(renderRow)}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell>{t("Total", "Total")}</TableCell>
                        <TableCell className="hidden sm:table-cell" />
                        <TableCell className="text-right"><Num>{totQty}</Num></TableCell>
                        <TableCell className="text-right"><Num className="font-semibold">{usd(totValue.toFixed(2))}</Num></TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Item history

function ItemHistoryTab() {
  const t = useT();
  const { lang } = useI18n();
  const thisYear = Number(todayLocal().slice(0, 4));
  const [variant, setVariant] = useState<VariantRow | null>(null);
  const [year, setYear] = useState(thisYear);
  const q = useQuery<MonthlyData>({ queryKey: [`/api/variants/${variant?.id}/monthly`, { year }], enabled: !!variant });
  const monthName = (m: number) => {
    const s = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, m - 1, 1)));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const monthNum = (m: number | string) => (typeof m === "number" ? m : Number(String(m).slice(-2)));
  const data = q.data;
  const today = todayLocal();
  const nowYear = Number(today.slice(0, 4));
  const nowMonth = Number(today.slice(5, 7));
  // Months after the current one have not happened yet: show "—" and keep them out of the chart and totals.
  const isFuture = (m: number | string) => year > nowYear || (year === nowYear && monthNum(m) > nowMonth);
  const pastMonths = (data?.months ?? []).filter((m) => !isFuture(m.month));
  const chart = pastMonths.map((m) => ({ name: monthName(monthNum(m.month)), qty: Number(m.closingQty) }));
  const totIn = pastMonths.reduce((s, m) => ({ q: s.q.plus(m.inQty), v: s.v.plus(m.inValue) }), { q: d(0), v: d(0) });
  const totOut = pastMonths.reduce((s, m) => ({ q: s.q.plus(m.outQty), v: s.v.plus(m.outValue) }), { q: d(0), v: d(0) });
  const last = pastMonths[pastMonths.length - 1];
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);

  function csv() {
    if (!data) return;
    downloadCsv(`historique-${data.variant.sku}-${year}.csv`, [
      [t("Month", "Mois"), t("In qty", "Entrées qté"), t("In value", "Entrées valeur"), t("Out qty", "Sorties qté"), t("Out value", "Sorties valeur"), t("Closing qty", "Stock final qté"), t("Closing value", "Stock final valeur")],
      [t("Opening", "Ouverture"), "", "", "", "", data.openingQty, data.openingValue],
      ...data.months.map((m) => (isFuture(m.month) ? [monthName(monthNum(m.month)), "", "", "", "", "", ""] : [monthName(monthNum(m.month)), m.inQty, m.inValue, m.outQty, m.outValue, m.closingQty, m.closingValue])),
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("Item", "Article")} className="w-full sm:w-96">
          <VariantSearch onPick={setVariant} placeholder={t("Search item, size or SKU", "Chercher article, taille ou code")} />
        </Field>
        <Field label={t("Year", "Année")}>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {data && <div className="ml-auto"><CsvButton onClick={csv} /></div>}
      </div>

      {!variant ? (
        <EmptyState title={t("Pick an item", "Choisissez un article")}>
          {t("See what came in, went out and remained each month.", "Voyez ce qui est entré, sorti et resté chaque mois.")}
        </EmptyState>
      ) : q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : data ? (
        <>
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold">
              {data.variant.productId ? (
                <Link href={`/products/${data.variant.productId}`} className="hover:underline">{itemLabel(data.variant.productName, data.variant.attributes)}</Link>
              ) : (
                itemLabel(data.variant.productName, data.variant.attributes)
              )}
            </h2>
            <span className="font-mono text-xs text-muted-foreground">{data.variant.sku}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t("Opening", "Ouverture")} value={qty(data.openingQty)} sub={usd(data.openingValue)} />
            <StatCard label={t("In", "Entrées")} value={qty(totIn.q.toString())} sub={usd(totIn.v.toFixed(2))} />
            <StatCard label={t("Out", "Sorties")} value={qty(totOut.q.toString())} sub={usd(totOut.v.toFixed(2))} />
            <StatCard label={t("Closing", "Stock final")} value={qty(last?.closingQty ?? data.openingQty)} sub={usd(last?.closingValue ?? data.openingValue)} />
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("Closing quantity by month", "Quantité en fin de mois")}</CardTitle></CardHeader>
            <CardContent>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval={0} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted))" }}
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12, color: "hsl(var(--foreground))" }}
                      formatter={(v: number) => [qty(v), t("Closing qty", "Stock final")]}
                    />
                    <Bar dataKey="qty" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Month", "Mois")}</TableHead>
                      <TableHead className="text-right">{t("In qty", "Entrées")}</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">{t("In value", "Valeur entrées")}</TableHead>
                      <TableHead className="text-right">{t("Out qty", "Sorties")}</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">{t("Out value", "Valeur sorties")}</TableHead>
                      <TableHead className="text-right">{t("Closing qty", "Stock final")}</TableHead>
                      <TableHead className="text-right">{t("Closing value", "Valeur finale")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell className="font-medium">{t(`Opening ${year}`, `Ouverture ${year}`)}</TableCell>
                      <TableCell />
                      <TableCell className="hidden sm:table-cell" />
                      <TableCell />
                      <TableCell className="hidden sm:table-cell" />
                      <TableCell className="text-right"><Num className="font-medium">{qty(data.openingQty)}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-medium">{usd(data.openingValue)}</Num></TableCell>
                    </TableRow>
                    {data.months.map((m) => {
                      if (isFuture(m.month)) {
                        return (
                          <TableRow key={String(m.month)} className="text-muted-foreground">
                            <TableCell>{monthName(monthNum(m.month))}</TableCell>
                            <TableCell className="text-right">—</TableCell>
                            <TableCell className="hidden text-right sm:table-cell">—</TableCell>
                            <TableCell className="text-right">—</TableCell>
                            <TableCell className="hidden text-right sm:table-cell">—</TableCell>
                            <TableCell className="text-right">—</TableCell>
                            <TableCell className="text-right">—</TableCell>
                          </TableRow>
                        );
                      }
                      const empty = d(m.inQty).isZero() && d(m.outQty).isZero();
                      return (
                        <TableRow key={String(m.month)}>
                          <TableCell>{monthName(monthNum(m.month))}</TableCell>
                          <TableCell className="text-right"><Num className={cn(empty && "text-muted-foreground")}>{d(m.inQty).isZero() ? "—" : qty(m.inQty)}</Num></TableCell>
                          <TableCell className="hidden text-right sm:table-cell"><Num className="text-muted-foreground">{d(m.inValue).isZero() ? "—" : usd(m.inValue)}</Num></TableCell>
                          <TableCell className="text-right"><Num className={cn(empty && "text-muted-foreground")}>{d(m.outQty).isZero() ? "—" : qty(m.outQty)}</Num></TableCell>
                          <TableCell className="hidden text-right sm:table-cell"><Num className="text-muted-foreground">{d(m.outValue).isZero() ? "—" : usd(m.outValue)}</Num></TableCell>
                          <TableCell className="text-right"><Num className="font-medium">{qty(m.closingQty)}</Num></TableCell>
                          <TableCell className="text-right"><Num>{usd(m.closingValue)}</Num></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>{t("Year", "Année")}</TableCell>
                      <TableCell className="text-right"><Num>{qty(totIn.q.toString())}</Num></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Num>{usd(totIn.v.toFixed(2))}</Num></TableCell>
                      <TableCell className="text-right"><Num>{qty(totOut.q.toString())}</Num></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Num>{usd(totOut.v.toFixed(2))}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-semibold">{qty(last?.closingQty ?? data.openingQty)}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-semibold">{usd(last?.closingValue ?? data.openingValue)}</Num></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
