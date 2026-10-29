import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, ArrowRight, ArrowRightLeft, Bike, Boxes, MapPin, Pencil, Plus, Search, Warehouse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader } from "@/components/common";
import { useLocations } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT, count } from "@/lib/i18n";
import { d, qty, unitCost, usd, variantText } from "@/lib/format";
import { qtyWithUnit } from "@/lib/units";
import type { Location } from "@/lib/types";
import { TransferForm } from "@/pages/Stock";

/** A warehouse is a child location. Existing stock stays in its original parent location. */
interface StockPosition {
  locationId: number;
  locationName: string;
  variantId: number;
  sku: string;
  attributes: Record<string, string>;
  productId: number;
  productName: string;
  categoryName: string | null;
  tracksSerials: boolean;
  unit: string;
  qty: string;
  avgCost: string;
  value: string;
  retailValue: string;
}

function summary(rows: StockPosition[]) {
  return {
    variants: rows.length,
    value: rows.reduce((sum, r) => sum.plus(d(r.value)), d(0)).toFixed(2),
    motorcycles: rows.filter((r) => r.tracksSerials).reduce((sum, r) => sum.plus(d(r.qty)), d(0)).toFixed(0),
  };
}

function PlaceDialog({
  parentId, place, onClose, onSaved,
}: {
  parentId: number | null;
  place?: Location;
  onClose: () => void;
  onSaved: (place: Location) => void;
}) {
  const t = useT();
  const [name, setName] = useState(place?.name ?? "");
  const create = useApiMutation<{ name: string; parentId: number | null }, Location>("POST", "/api/locations", {
    success: t("Location saved", "Emplacement enregistré"),
    onSuccess: onSaved,
  });
  const update = useApiMutation<{ name: string }, Location>("PATCH", "/api/locations/" + (place?.id ?? 0), {
    success: t("Location saved", "Emplacement enregistré"),
    onSuccess: onSaved,
  });
  const pending = create.isPending || update.isPending;
  function save() {
    const clean = name.trim();
    if (!clean || pending) return;
    if (place) update.mutate({ name: clean });
    else create.mutate({ name: clean, parentId });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{place
            ? t("Rename", "Renommer")
            : parentId === null
              ? t("Create location", "Créer un emplacement")
              : t("Create warehouse", "Créer un entrepôt")}</DialogTitle>
          <DialogDescription>{parentId === null
            ? t("A location can contain several warehouses.", "Un emplacement peut contenir plusieurs entrepôts.")
            : t("A warehouse stores items and motorcycles inside this location.", "Un entrepôt stocke des articles et des motos dans cet emplacement.")}</DialogDescription>
        </DialogHeader>
        <Field label={t("Name", "Nom")} required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button disabled={!name.trim() || pending} onClick={save}>
            {pending ? t("Saving…", "Enregistrement…") : t("Save", "Enregistrer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function InventoryLocations() {
  const t = useT();
  const { can } = useAuth();
  const canManagePlaces = can();
  const canTransfer = can("manager");
  const locationsQuery = useLocations();
  const stockQuery = useQuery<StockPosition[]>({ queryKey: ["/api/inventory/by-location"] });
  const locations = locationsQuery.data ?? [];
  const positions = stockQuery.data ?? [];
  const [siteId, setSiteId] = useState<number | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ parentId: number | null; place?: Location } | null>(null);
  const [transferTarget, setTransferTarget] = useState<{ fromId?: number; toId?: number } | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [siteSearch, setSiteSearch] = useState("");
  const byId = useMemo(() => new Map(locations.map((loc) => [loc.id, loc])), [locations]);
  const sites = locations.filter((loc) => loc.parentId == null);
  const site = siteId !== null ? byId.get(siteId) : null;
  const warehouse = warehouseId !== null ? byId.get(warehouseId) : null;
  const warehouses = site ? locations.filter((loc) => loc.parentId === site.id) : [];
  const siteRows = site ? positions.filter((r) => r.locationId === site.id || byId.get(r.locationId)?.parentId === site.id) : [];
  const detailRows = warehouse ? positions.filter((r) => r.locationId === warehouse.id) : [];
  const categories = Array.from(new Set(detailRows.map((r) => r.categoryName ?? t("Uncategorized", "Sans catégorie")))).sort();
  const filteredRows = detailRows.filter((r) => {
    const text = [r.productName, r.sku, variantText(r.attributes), r.categoryName ?? ""].join(" ").toLowerCase();
    return text.includes(search.trim().toLowerCase()) && (category === "all" || (r.categoryName ?? t("Uncategorized", "Sans catégorie")) === category);
  });
  const detail = summary(filteredRows);
  const total = summary(positions);
  const warehouseName = warehouse?.id === site?.id ? t("Stock at location", "Stock sur place") : warehouse?.name;

  function backToSites() {
    setSiteId(null);
    setWarehouseId(null);
    setSearch("");
    setCategory("all");
  }
  function openSite(id: number) {
    setSiteId(id);
    setWarehouseId(null);
    setSearch("");
    setCategory("all");
  }
  function openWarehouse(id: number) {
    setWarehouseId(id);
    setSearch("");
    setCategory("all");
  }
  function doneSaving(row: Location) {
    setEditing(null);
    if (!row.parentId) openSite(row.id);
    else { setSiteId(row.parentId); openWarehouse(row.id); }
  }
  const owners = (loc: Location) => positions.filter((r) => r.locationId === loc.id);
  const perSite = (loc: Location) => positions.filter((r) => r.locationId === loc.id || byId.get(r.locationId)?.parentId === loc.id);

  return (
    <div>
      <PageHeader
        title={t("Location inventory", "Inventaire par emplacement")}
        description={site
          ? t("Manage items and warehouses at " + site.name, "Gérer les articles et les entrepôts à " + site.name)
          : t("Manage inventory across locations and warehouses.", "Gérer le stock par emplacement et entrepôt.")}
        actions={site === undefined || !site
          ? canManagePlaces && <Button onClick={() => setEditing({ parentId: null })}><Plus className="mr-2 h-4 w-4" />{t("Create location", "Créer un emplacement")}</Button>
          : warehouse
            ? canTransfer && warehouse.active && <Button onClick={() => setTransferTarget(warehouse.id === site.id ? { fromId: warehouse.id } : { toId: warehouse.id })}><ArrowRightLeft className="mr-2 h-4 w-4" />{warehouse.id === site.id ? t("Send stock", "Envoyer le stock") : t("Move stock here", "Transférer du stock ici")}</Button>
            : canManagePlaces && site.active && <Button onClick={() => setEditing({ parentId: site.id })}><Plus className="mr-2 h-4 w-4" />{t("Create warehouse", "Créer un entrepôt")}</Button>}
      />

      {(locationsQuery.isLoading || stockQuery.isLoading) && <Loading />}
      {locationsQuery.error && <ErrorText error={locationsQuery.error} />}
      {stockQuery.error && <ErrorText error={stockQuery.error} />}

      {!locationsQuery.isLoading && !stockQuery.isLoading && !locationsQuery.error && !stockQuery.error && (
        <>
          {!site ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{t("Locations", "Emplacements")}</h2>
                  <p className="text-sm text-muted-foreground">{count(t, sites.length, ["location", "locations"], ["emplacement", "emplacements"])} · {count(t, total.variants, ["stock variant", "stock variants"], ["variante en stock", "variantes en stock"])} · {usd(total.value)}</p>
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" value={siteSearch} onChange={(e) => setSiteSearch(e.target.value)} placeholder={t("Search locations", "Rechercher des emplacements")} />
                </div>
              </div>
              {sites.length === 0 ? <EmptyState title={t("No locations yet", "Aucun emplacement")}>
                {canManagePlaces ? t("Create a location to start organizing warehouses.", "Créez un emplacement pour organiser les entrepôts.") : null}
              </EmptyState> : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {sites.filter((loc) => loc.name.toLowerCase().includes(siteSearch.toLowerCase())).map((loc) => {
                    const locationRows = perSite(loc);
                    const totals = summary(locationRows);
                    const children = locations.filter((l) => l.parentId === loc.id);
                    return (
                      <button type="button" key={loc.id} onClick={() => openSite(loc.id)} className="text-left">
                        <Card className="h-full transition-colors hover:border-primary/70">
                          <CardContent className="flex h-full flex-col gap-3 p-4">
                            <div className="flex items-center gap-3">
                              <div className="rounded-lg bg-primary/10 p-3 text-primary"><MapPin className="h-5 w-5" /></div>
                              <div className="min-w-0 flex-1"><p className="truncate font-semibold">{loc.name}</p>
                                <p className="text-xs text-muted-foreground">{count(t, children.length, ["warehouse", "warehouses"], ["entrepôt", "entrepôts"])}</p></div>
                              <ArrowRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                            {!loc.active && <Badge variant="secondary" className="w-fit">{t("Inactive", "Inactif")}</Badge>}
                            <div className="flex flex-wrap gap-2 border-t pt-3 text-xs text-muted-foreground">
                              <span>{count(t, totals.variants, ["variant", "variants"], ["variante", "variantes"])}</span>
                              <span>· {usd(totals.value)}</span>
                              {Number(totals.motorcycles) > 0 && <span>· {totals.motorcycles} {t("motorcycles", "motos")}</span>}
                            </div>
                          </CardContent>
                        </Card>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : !warehouse ? (
            <div className="space-y-5">
              <Button variant="ghost" size="sm" onClick={backToSites}><ArrowLeft className="mr-2 h-4 w-4" />{t("All locations", "Tous les emplacements")}</Button>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-2xl font-semibold">{site.name}</h2>
                  <p className="text-sm text-muted-foreground">{count(t, warehouses.length, ["warehouse", "warehouses"], ["entrepôt", "entrepôts"])} · {count(t, siteRows.length, ["variant position", "variant positions"], ["position de variante", "positions de variantes"])} · {usd(summary(siteRows).value)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canTransfer && site.active && owners(site).length > 0 && <Button variant="outline" size="sm" onClick={() => setTransferTarget({ fromId: site.id })}><ArrowRightLeft className="mr-2 h-4 w-4" />{t("Send existing stock", "Transférer le stock existant")}</Button>}
                  {canManagePlaces && <Button variant="outline" size="sm" onClick={() => setEditing({ parentId: null, place: site })}><Pencil className="mr-2 h-4 w-4" />{t("Rename location", "Renommer l'emplacement")}</Button>}
                </div>
              </div>
              <h3 className="text-lg font-semibold">{t("Warehouses", "Entrepôts")}</h3>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {owners(site).length > 0 && (
                  <button type="button" className="text-left" onClick={() => openWarehouse(site.id)}>
                    <Card className="h-full transition-colors hover:border-primary/70">
                      <CardContent className="space-y-3 p-4">
                        <div className="flex items-center gap-3"><Boxes className="h-5 w-5 text-primary" />
                          <span className="flex-1 font-semibold">{t("Stock at location (existing)", "Stock sur place (existant)")}</span><ArrowRight className="h-4 w-4" /></div>
                        <p className="border-t pt-3 text-sm text-muted-foreground">{count(t, owners(site).length, ["variant", "variants"], ["variante", "variantes"])} · {usd(summary(owners(site)).value)}</p>
                      </CardContent>
                    </Card>
                  </button>
                )}
                {warehouses.map((loc) => {
                  const rows = owners(loc);
                  const totals = summary(rows);
                  return (
                    <button type="button" key={loc.id} className="text-left" onClick={() => openWarehouse(loc.id)}>
                      <Card className="h-full transition-colors hover:border-primary/70">
                        <CardContent className="space-y-3 p-4">
                          <div className="flex items-center gap-3"><Warehouse className="h-5 w-5 text-primary" />
                            <span className="min-w-0 flex-1 truncate font-semibold">{loc.name}</span><ArrowRight className="h-4 w-4 text-muted-foreground" /></div>
                          {!loc.active && <Badge variant="secondary">{t("Inactive", "Inactif")}</Badge>}
                          <p className="border-t pt-3 text-sm text-muted-foreground">{count(t, totals.variants, ["variant", "variants"], ["variante", "variantes"])} · {usd(totals.value)}</p>
                        </CardContent>
                      </Card>
                    </button>
                  );
                })}
              </div>
              {warehouses.length === 0 && owners(site).length === 0 && <EmptyState title={t("No warehouses or stock yet", "Aucun entrepôt ni stock pour le moment")} />}
              {warehouses.length > 0 && owners(site).length > 0 &&
                <p className="text-sm text-muted-foreground">{t("Existing stock stays directly at this location until you transfer it into a warehouse.", "Le stock existant reste dans cet emplacement jusqu'à son transfert vers un entrepôt.")}</p>}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Button variant="ghost" size="sm" onClick={backToSites}>{t("Locations", "Emplacements")}</Button>
                <span className="text-muted-foreground">/</span>
                <Button variant="ghost" size="sm" onClick={() => { setWarehouseId(null); setCategory("all"); }}>{site.name}</Button>
                <span className="text-muted-foreground">/</span>
                <span className="font-medium">{warehouseName}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-2xl font-semibold">{warehouseName}</h2><p className="text-sm text-muted-foreground">{site.name} · {count(t, detailRows.length, ["variant", "variants"], ["variante", "variantes"])} · {usd(summary(detailRows).value)}</p></div>
                {canManagePlaces && warehouse.id !== site.id && <Button variant="outline" size="sm" onClick={() => setEditing({ parentId: site.id, place: warehouse })}><Pencil className="mr-2 h-4 w-4" />{t("Rename warehouse", "Renommer l'entrepôt")}</Button>}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("Variants", "Variantes")}</p><p className="text-2xl font-semibold">{detailRows.length}</p></CardContent></Card>
                <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("Total value", "Valeur totale")}</p><p className="text-2xl font-semibold">{usd(summary(detailRows).value)}</p></CardContent></Card>
                <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("Motorcycles", "Motos")}</p><p className="text-2xl font-semibold">{summary(detailRows).motorcycles}</p></CardContent></Card>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search items or variants", "Rechercher des articles ou variantes")} />
                </div>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("All categories", "Toutes les catégories")}</SelectItem>
                    {categories.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {filteredRows.length === 0 ? <EmptyState title={t("No items in this warehouse", "Aucun article dans cet entrepôt")}>
                {canTransfer && warehouse.active ? t("Use Move stock to transfer existing items here.", "Utilisez Transférer le stock pour placer des articles ici.") : null}
              </EmptyState> : (
                <Card className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>{t("Item / variant", "Article / variante")}</TableHead>
                      <TableHead>{t("Category", "Catégorie")}</TableHead>
                      <TableHead className="text-right">{t("Quantity", "Quantité")}</TableHead>
                      <TableHead className="text-right">{t("Avg cost", "Coût moyen")}</TableHead>
                      <TableHead className="text-right">{t("Total value", "Valeur totale")}</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {filteredRows.map((r) => <TableRow key={r.variantId}>
                        <TableCell>
                          <Link href={"/products/" + r.productId} className="font-medium text-primary hover:underline">{r.productName}</Link>
                          {r.tracksSerials && <Bike className="ml-2 inline h-4 w-4 text-muted-foreground" />}
                          <p className="text-xs text-muted-foreground">{[r.sku, variantText(r.attributes)].filter(Boolean).join(" · ")}</p>
                        </TableCell>
                        <TableCell><Badge variant="outline">{r.categoryName ?? "—"}</Badge></TableCell>
                        <TableCell className="text-right"><Num>{qtyWithUnit(t, r.qty, r.unit)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{unitCost(r.avgCost)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{usd(r.value)}</Num></TableCell>
                      </TableRow>)}
                      <TableRow className="bg-muted/40 font-medium">
                        <TableCell colSpan={4}>{t("Filtered total", "Total filtré")} ({filteredRows.length})</TableCell>
                        <TableCell className="text-right"><Num>{usd(detail.value)}</Num></TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </Card>
              )}
              {detailRows.some((r) => r.tracksSerials) && <p className="text-sm text-muted-foreground"><Link href="/motorcycles" className="text-primary hover:underline">{t("See motorcycle chassis and engine numbers", "Voir les numéros de châssis et de moteur")}</Link></p>}
            </div>
          )}
        </>
      )}

      {editing && <PlaceDialog key={(editing.place?.id ?? "new") + "-" + (editing.parentId ?? "site")} parentId={editing.parentId} place={editing.place} onClose={() => setEditing(null)} onSaved={doneSaving} />}
      {transferTarget !== null && (
        <Dialog open onOpenChange={(open) => { if (!open) setTransferTarget(null); }}>
          <DialogContent className="max-h-[92dvh] max-w-6xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("Move stock", "Transférer le stock")}</DialogTitle>
              <DialogDescription>{t("Transfer items between locations or warehouses without changing their average cost.", "Transférez des articles entre les emplacements ou entrepôts sans modifier leur coût moyen.")}</DialogDescription>
            </DialogHeader>
            <TransferForm initialFromId={transferTarget.fromId} initialToId={transferTarget.toId} onDone={() => setTransferTarget(null)} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
