import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, Bike, History, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { CategorySelect, useLocations } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { d, date, qty, usd, variantUnitCost } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import type { Category, MotorcycleUnit, Product, ProductVariant } from "@/lib/types";
import { QuickCategoryButton, UNITS, unitLabel } from "./Products";

type T = (en: string, fr: string) => string;

export function movementTypeLabel(t: T, type: string) {
  const m: Record<string, [string, string]> = {
    opening: ["Opening stock", "Stock d'ouverture"],
    container_in: ["Container offload", "Déchargement conteneur"],
    container_reversal: ["Container reversal", "Annulation conteneur"],
    sale: ["Sale", "Vente"],
    sale_void: ["Sale voided", "Vente annulée"],
    sale_return: ["Return", "Retour"],
    adjustment: ["Adjustment", "Ajustement"],
    transfer_in: ["Transfer in", "Transfert entrant"],
    transfer_out: ["Transfer out", "Transfert sortant"],
  };
  const x = m[type];
  return x ? t(x[0], x[1]) : type;
}

interface Movement {
  id: number;
  date: string;
  type: string;
  qty: string;
  value: string;
  locationName: string;
  note: string | null;
  sourceType: string | null;
  sourceId: number | null;
}

export default function ProductDetail() {
  const t = useT();
  const { can } = useAuth();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const q = useQuery<Product>({ queryKey: [`/api/products/${id}`] });
  const { data: locations = [] } = useLocations();
  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ["/api/categories"] });
  const p = q.data;
  const units = useQuery<(MotorcycleUnit & { attributes?: Record<string, string> })[]>({
    queryKey: ["/api/units", { status: "in_stock" }],
    enabled: !!p?.tracksSerials,
  });
  const [editing, setEditing] = useState(false);
  const [variantEdit, setVariantEdit] = useState<ProductVariant | "new" | null>(null);
  const [history, setHistory] = useState<ProductVariant | null>(null);
  const showCost = can("manager", "partner");
  const isManager = can("manager");

  if (q.isLoading) return <Loading />;
  if (q.error || !p) return <ErrorText error={q.error ?? t("Item not found", "Article introuvable")} />;

  const variants = p.variants ?? [];
  const usedLocations = locations.filter((l) => l.active || variants.some((v) => v.levels.some((x) => x.locationId === l.id && !d(x.qty).isZero())));
  const byLocation = usedLocations.length > 1;
  const variantIds = new Set(variants.map((v) => v.id));
  const myUnits = (units.data ?? []).filter((u) => variantIds.has(u.variantId));
  const totalQty = variants.reduce((s, v) => s.plus(d(v.stockQty)), d(0));
  const totalValue = variants.reduce((s, v) => s.plus(d(v.stockValue)), d(0));
  const categoryName = categories.find((c) => c.id === p.categoryId)?.name;
  const locName = (lid: number) => locations.find((l) => l.id === lid)?.name ?? `#${lid}`;

  return (
    <div>
      <Link href="/products" className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> {t("Items", "Articles")}
      </Link>
      <PageHeader
        title={p.name}
        description={[p.brand, categoryName, unitLabel(t, p.unit)].filter(Boolean).join(" · ")}
        actions={
          isManager && (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="mr-1 h-4 w-4" /> {t("Edit item", "Modifier l'article")}</Button>
              <Button onClick={() => setVariantEdit("new")}><Plus className="mr-1 h-4 w-4" /> {t("Add variant", "Ajouter une variante")}</Button>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {!p.active && <Badge variant="secondary">{t("Inactive", "Inactif")}</Badge>}
        {p.tracksSerials && (
          <Badge variant="outline" className="gap-1"><Bike className="h-3 w-3" /> {t("Motorcycle — chassis numbers tracked", "Moto — numéros de châssis suivis")}</Badge>
        )}
        <Badge variant="outline">{t("In stock:", "En stock\u00a0:")} {qty(totalQty.toString())}</Badge>
        {showCost && <Badge variant="outline">{t("Stock value:", "Valeur du stock\u00a0:")} {usd(totalValue.toFixed(2))}</Badge>}
      </div>
      {p.description && <p className="mb-4 whitespace-pre-line text-sm text-muted-foreground">{p.description}</p>}

      <Card className="mb-6">
        <CardHeader className="pb-2"><CardTitle className="text-base">{t("Variants", "Variantes")}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Variant", "Variante")}</TableHead>
                {/* With a column per location, the barcode goes under the code so the table still fits at 1024 px. */}
                <TableHead>{byLocation ? t("SKU · barcode", "Code · code-barres") : t("SKU", "Code")}</TableHead>
                {!byLocation && <TableHead>{t("Barcode", "Code-barres")}</TableHead>}
                <TableHead className="text-right">{t("Price", "Prix")}</TableHead>
                <TableHead className="text-right">{t("Reorder", "Seuil")}</TableHead>
                <TableHead className="text-right">{t("Stock", "Stock")}</TableHead>
                {showCost && <TableHead className="text-right">{t("Avg cost", "Coût moyen")}</TableHead>}
                {showCost && <TableHead className="text-right">{t("Value", "Valeur")}</TableHead>}
                {byLocation && usedLocations.map((l) => <TableHead key={l.id} className="text-right">{l.name}</TableHead>)}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => {
                const low = d(v.reorderLevel).gt(0) && d(v.stockQty).lte(d(v.reorderLevel));
                return (
                  <TableRow key={v.id} className={!v.active ? "opacity-60" : undefined}>
                    <TableCell className="font-medium">
                      {v.label}
                      {!v.active && <Badge variant="secondary" className="ml-2">{t("Inactive", "Inactif")}</Badge>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {v.sku}
                      {byLocation && v.barcode && <span className="block text-muted-foreground">{v.barcode}</span>}
                    </TableCell>
                    {!byLocation && <TableCell className="whitespace-nowrap font-mono text-xs">{v.barcode ?? "—"}</TableCell>}
                    <TableCell className="text-right"><Num>{usd(v.sellPrice)}</Num></TableCell>
                    <TableCell className="text-right"><Num>{qty(v.reorderLevel)}</Num></TableCell>
                    <TableCell className="text-right">
                      <Num className={d(v.stockQty).lte(0) ? "text-destructive" : undefined}>{qty(v.stockQty)}</Num>
                      {low && <Badge variant="destructive" className="ml-2">{t("Low", "Bas")}</Badge>}
                    </TableCell>
                    {showCost && <TableCell className="text-right"><Num>{variantUnitCost(v)}</Num></TableCell>}
                    {showCost && <TableCell className="text-right"><Num>{usd(v.stockValue)}</Num></TableCell>}
                    {byLocation &&
                      usedLocations.map((l) => (
                        <TableCell key={l.id} className="text-right"><Num>{qty(v.levels.find((x) => x.locationId === l.id)?.qty ?? 0)}</Num></TableCell>
                      ))}
                    <TableCell className="whitespace-nowrap text-right">
                      {showCost && (
                        <Button variant="ghost" size="icon" title={t("Movements", "Mouvements")} onClick={() => setHistory(v)}><History className="h-4 w-4" /></Button>
                      )}
                      {isManager && (
                        <Button variant="ghost" size="icon" title={t("Edit", "Modifier")} onClick={() => setVariantEdit(v)}><Pencil className="h-4 w-4" /></Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {p.tracksSerials && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">{t("Motorcycles in stock", "Motos en stock")}</CardTitle>
            <Link href="/motorcycles" className="text-sm text-primary hover:underline">{t("All motorcycles →", "Toutes les motos →")}</Link>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {units.isLoading ? (
              <Loading />
            ) : myUnits.length === 0 ? (
              <div className="p-4"><EmptyState title={t("No motorcycle of this model in stock", "Aucune moto de ce modèle en stock")} /></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Variant", "Variante")}</TableHead>
                    <TableHead>{t("Chassis no.", "N° de châssis")}</TableHead>
                    <TableHead>{t("Engine no.", "N° de moteur")}</TableHead>
                    <TableHead>{t("Colour", "Couleur")}</TableHead>
                    <TableHead>{t("Location", "Emplacement")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myUnits.map((u) => (
                    <TableRow key={u.id} className={!u.chassisNo ? "bg-amber-50 dark:bg-amber-950/30" : undefined}>
                      <TableCell>{u.label}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {u.chassisNo ?? <Link href="/motorcycles" className="font-sans text-amber-800 underline underline-offset-2 hover:text-amber-900 dark:text-amber-400">{t("Missing — register in Motorcycles", "Manquant — à saisir dans Motos")}</Link>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{u.engineNo ?? "—"}</TableCell>
                      <TableCell>{u.color ?? "—"}</TableCell>
                      <TableCell>{locName(u.locationId)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {editing && <EditProductDialog product={p} onClose={() => setEditing(false)} />}
      {variantEdit && <VariantDialog product={p} variant={variantEdit === "new" ? null : variantEdit} onClose={() => setVariantEdit(null)} />}
      {history && <MovementsDialog variant={history} productName={p.name} onClose={() => setHistory(null)} />}
    </div>
  );
}

function EditProductDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(product.name);
  const [categoryId, setCategoryId] = useState<number | null>(product.categoryId);
  const [brand, setBrand] = useState(product.brand ?? "");
  const [unit, setUnit] = useState(product.unit);
  const [description, setDescription] = useState(product.description ?? "");
  const [active, setActive] = useState(product.active);
  const [tracksSerials, setTracksSerials] = useState(product.tracksSerials);
  const m = useApiMutation("PATCH", `/api/products/${product.id}`, { success: t("Item saved", "Article enregistré"), onSuccess: onClose });
  const hasStock = (product.variants ?? []).some((v) => !d(v.stockQty).isZero());
  const units: string[] = UNITS.includes(product.unit as (typeof UNITS)[number]) ? [...UNITS] : [...UNITS, product.unit];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("Edit item", "Modifier l'article")}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label={t("Name", "Nom")} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Category", "Catégorie")}>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><CategorySelect value={categoryId} onChange={setCategoryId} /></div>
              <QuickCategoryButton onCreated={setCategoryId} />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Brand", "Marque")}><Input value={brand} onChange={(e) => setBrand(e.target.value)} /></Field>
            <Field label={t("Unit", "Unité")}>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{units.map((u) => <SelectItem key={u} value={u}>{unitLabel(t, u)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field label={t("Description", "Description")}><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="ts" checked={tracksSerials} onCheckedChange={setTracksSerials} />
            <div>
              <Label htmlFor="ts">{t("Motorcycle (track chassis numbers)", "Moto (suivre les numéros de châssis)")}</Label>
              {hasStock && <p className="text-xs text-muted-foreground">{t("Can only be changed while the item has no stock.", "Modifiable seulement quand l'article n'a pas de stock.")}</p>}
            </div>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={active} onCheckedChange={setActive} /> {t("Active (shown in sales and searches)", "Actif (visible dans les ventes et recherches)")}
          </label>
          {m.error && <ErrorText error={m.error} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            blocked={!name.trim() && t("Enter a name", "Saisissez un nom")}
            pending={m.isPending}
            onClick={() =>
              m.mutate({
                name: name.trim(),
                categoryId,
                brand: brand.trim() || null,
                unit,
                description: description.trim() || null,
                active,
                ...(tracksSerials !== product.tracksSerials && { tracksSerials }),
              })
            }
          >
            {t("Save", "Enregistrer")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VariantDialog({ product, variant, onClose }: { product: Product; variant: ProductVariant | null; onClose: () => void }) {
  const t = useT();
  const otherKeys = Array.from(new Set((product.variants ?? []).flatMap((v) => Object.keys(v.attributes ?? {}))));
  const initial: [string, string][] = variant
    ? Object.entries(variant.attributes ?? {})
    : otherKeys.map((k) => [k, ""] as [string, string]);
  const [attrs, setAttrs] = useState<[string, string][]>(initial.length ? initial : []);
  const [sku, setSku] = useState(variant?.sku ?? "");
  const [barcode, setBarcode] = useState(variant?.barcode ?? "");
  const [sellPrice, setSellPrice] = useState(variant ? d(variant.sellPrice).toFixed(2) : "");
  const [reorderLevel, setReorderLevel] = useState(variant ? d(variant.reorderLevel).toString() : "");
  const [active, setActive] = useState(variant?.active ?? true);
  const m = useApiMutation(variant ? "PATCH" : "POST", variant ? `/api/variants/${variant.id}` : `/api/products/${product.id}/variants`, {
    success: variant ? t("Variant saved", "Variante enregistrée") : t("Variant added", "Variante ajoutée"),
    onSuccess: onClose,
  });

  const priceError = sellPrice.trim() && !/^\d+(\.\d+)?$/.test(sellPrice.trim()) ? t("Enter a valid price", "Saisissez un prix valide") : null;
  const reorderError = reorderLevel.trim() && !/^\d+(\.\d+)?$/.test(reorderLevel.trim()) ? t("Enter a valid reorder level", "Saisissez un seuil valide") : null;

  function save() {
    if (priceError || reorderError) return;
    const attributes = Object.fromEntries(attrs.map(([k, v]) => [k.trim(), v.trim()]).filter(([k, v]) => k && v));
    m.mutate({
      attributes,
      ...(variant ? (sku.trim() ? { sku: sku.trim() } : {}) : { sku: sku.trim() || null }),
      barcode: barcode.trim() || null,
      sellPrice: sellPrice.trim() ? d(sellPrice).toFixed(2) : "0.00",
      reorderLevel: reorderLevel.trim() ? d(reorderLevel).toString() : "0",
      active,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{variant ? t("Edit variant", "Modifier la variante") : t("Add variant", "Ajouter une variante")}</DialogTitle>
          <DialogDescription>{product.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t("Attributes (size, colour…)", "Attributs (taille, couleur…)")}</Label>
            {attrs.length === 0 && <p className="text-xs text-muted-foreground">{t("No attributes: this is the standard variant.", "Aucun attribut\u00a0: variante standard.")}</p>}
            {attrs.map(([k, v], i) => (
              <div key={i} className="flex gap-2">
                <Input className="w-36" placeholder={t("Size", "Taille")} value={k} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                <Input placeholder={t("Value", "Valeur")} value={v} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                <Button variant="ghost" size="icon" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setAttrs([...attrs, ["", ""]])}><Plus className="mr-1 h-4 w-4" /> {t("Attribute", "Attribut")}</Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={variant ? t("SKU", "Code") : t("SKU (blank = auto)", "Code (vide = auto)")}><Input value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
            <Field label={t("Barcode", "Code-barres")}><Input value={barcode} onChange={(e) => setBarcode(e.target.value)} /></Field>
            <Field label={t("Sell price ($)", "Prix de vente ($)")} error={priceError}><Input inputMode="decimal" usd value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} /></Field>
            <Field label={t("Reorder level", "Seuil de réappro.")} error={reorderError}><Input inputMode="decimal" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} /></Field>
          </div>
          <label className="flex items-center gap-3 text-sm"><Switch checked={active} onCheckedChange={setActive} /> {t("Active", "Actif")}</label>
          {m.error && <ErrorText error={m.error} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={save} disabled={m.isPending}>{t("Save", "Enregistrer")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementsDialog({ variant, productName, onClose }: { variant: ProductVariant; productName: string; onClose: () => void }) {
  const t = useT();
  const q = useQuery<Movement[]>({ queryKey: [`/api/variants/${variant.id}/movements`] });
  const rows = q.data ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Stock movements", "Mouvements de stock")}</DialogTitle>
          <DialogDescription>{productName} · {variant.label} · {variant.sku}</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorText error={q.error} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("No movements yet", "Aucun mouvement")} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Date", "Date")}</TableHead>
                  <TableHead>{t("Type", "Type")}</TableHead>
                  <TableHead>{t("Location", "Emplacement")}</TableHead>
                  <TableHead className="text-right">{t("In", "Entrée")}</TableHead>
                  <TableHead className="text-right">{t("Out", "Sortie")}</TableHead>
                  <TableHead className="text-right">{t("Value", "Valeur")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => {
                  const n = d(m.qty);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap">{date(m.date)}</TableCell>
                      <TableCell>
                        {m.sourceType === "sale" && m.sourceId ? (
                          <Link href={`/sales/${m.sourceId}`} className="text-primary hover:underline">{movementTypeLabel(t, m.type)}</Link>
                        ) : m.sourceType === "container" && m.sourceId ? (
                          <Link href={`/containers/${m.sourceId}`} className="text-primary hover:underline">{movementTypeLabel(t, m.type)}</Link>
                        ) : (
                          movementTypeLabel(t, m.type)
                        )}
                        {m.note && <div className="text-xs text-muted-foreground">{m.note}</div>}
                      </TableCell>
                      <TableCell>{m.locationName}</TableCell>
                      <TableCell className="text-right"><Num className="text-green-800 dark:text-green-400">{n.gt(0) ? qty(m.qty) : ""}</Num></TableCell>
                      <TableCell className="text-right"><Num className="text-destructive">{n.lt(0) ? qty(n.abs().toString()) : ""}</Num></TableCell>
                      <TableCell className="text-right"><Num>{d(m.value).isZero() ? "—" : usd(m.value)}</Num></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
