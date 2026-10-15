import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Bike, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader } from "@/components/common";
import { CategorySelect } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { d, qty, usd } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { count, useT } from "@/lib/i18n";
import type { Category, Product } from "@/lib/types";

import { UNITS, unitLabel } from "@/lib/units";
export { UNITS, unitLabel };

/** Debounce a value (search boxes). */
function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function priceRange(p: Product) {
  if (p.minPrice == null) return "—";
  if (p.maxPrice == null || d(p.minPrice).equals(d(p.maxPrice))) return usd(p.minPrice);
  return `${usd(p.minPrice)} – ${usd(p.maxPrice)}`;
}

export default function Products() {
  const t = useT();
  const { can } = useAuth();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search.trim());
  const showValue = can("manager", "partner");

  const q = useQuery<Product[]>({
    queryKey: ["/api/products", { search: debounced || undefined, categoryId: categoryId ?? undefined, includeInactive: includeInactive ? "true" : undefined }],
  });
  const rows = q.data ?? [];
  const totalValue = useMemo(() => rows.reduce((s, p) => s.plus(d(p.stockValue)), d(0)), [rows]);

  return (
    <div>
      <PageHeader
        title={t("Items", "Articles")}
        description={t("Motorcycles, spare parts and accessories with their sizes and colours.", "Motos, pièces de rechange et accessoires avec leurs tailles et couleurs.")}
        actions={
          can("manager") && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> {t("New item", "Nouvel article")}
            </Button>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-center">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder={t("Search name, SKU, barcode, size", "Chercher nom, code, code-barres, taille")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <CategorySelect value={categoryId} onChange={setCategoryId} allowAll />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
          {t("Show inactive", "Afficher inactifs")}
        </label>
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No items found", "Aucun article trouvé")}>
          {can("manager") ? t("Create your first item with “New item”.", "Créez votre premier article avec «\u00a0Nouvel article\u00a0».") : null}
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Item", "Article")}</TableHead>
                <TableHead>{t("Category", "Catégorie")}</TableHead>
                <TableHead className="text-right">{t("Variants", "Variantes")}</TableHead>
                <TableHead className="text-right">{t("In stock", "En stock")}</TableHead>
                <TableHead className="text-right">{t("Price", "Prix")}</TableHead>
                {showValue && <TableHead className="text-right">{t("Stock value", "Valeur du stock")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/products/${p.id}`)}>
                  <TableCell>
                    <div className="flex items-center gap-2 font-medium">
                      {p.tracksSerials && <Bike className="h-4 w-4 shrink-0 text-primary" />}
                      <span>{p.name}</span>
                      {!p.active && <Badge variant="secondary">{t("Inactive", "Inactif")}</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{p.brand} · {unitLabel(t, p.unit)}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.categoryName ?? "—"}</TableCell>
                  <TableCell className="text-right"><Num>{p.variantCount ?? 0}</Num></TableCell>
                  <TableCell className="text-right">
                    <Num className={d(p.stockQty).lte(0) ? "text-destructive" : undefined}>{qty(p.stockQty)}</Num>
                  </TableCell>
                  <TableCell className="text-right"><Num>{priceRange(p)}</Num></TableCell>
                  {showValue && <TableCell className="text-right"><Num>{usd(p.stockValue)}</Num></TableCell>}
                </TableRow>
              ))}
              {showValue && (
                <TableRow className="bg-muted/40 font-medium">
                  <TableCell colSpan={5}>{t("Total", "Total")} ({count(t, rows.length, ["item", "items"], ["article", "articles"])})</TableCell>
                  <TableCell className="text-right"><Num>{usd(totalValue.toFixed(2))}</Num></TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && <NewProductDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/products/${id}`)} />}
    </div>
  );
}

// ------------------------------------------------------------------ Create dialog

interface AttrDef {
  name: string;
  values: string;
}

interface VariantDraft {
  key: number;
  attributes: Record<string, string>;
  sku: string;
  barcode: string;
  sellPrice: string;
  reorderLevel: string;
}

let draftKey = 1;
const newDraft = (attributes: Record<string, string> = {}, base?: Partial<VariantDraft>): VariantDraft => ({
  key: draftKey++,
  attributes,
  sku: "",
  barcode: "",
  sellPrice: base?.sellPrice ?? "",
  reorderLevel: base?.reorderLevel ?? "",
});

function splitValues(s: string) {
  return Array.from(new Set(s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)));
}

function combinations(defs: AttrDef[]): Record<string, string>[] {
  const usable = defs.map((a) => ({ name: a.name.trim(), values: splitValues(a.values) })).filter((a) => a.name && a.values.length);
  let out: Record<string, string>[] = [{}];
  for (const a of usable) {
    const next: Record<string, string>[] = [];
    for (const combo of out) for (const v of a.values) next.push({ ...combo, [a.name]: v });
    out = next;
  }
  return usable.length ? out : [];
}

export function QuickCategoryButton({ onCreated }: { onCreated: (id: number) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const m = useApiMutation<{ name: string }, Category>("POST", "/api/categories", {
    success: t("Category added", "Catégorie ajoutée"),
    onSuccess: (c) => {
      onCreated(c.id);
      setOpen(false);
      setName("");
    },
  });
  if (!open) {
    return (
      <Button type="button" variant="outline" size="icon" title={t("Add category", "Ajouter une catégorie")} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <div className="flex gap-1">
      <Input
        autoFocus
        className="w-40"
        placeholder={t("New category", "Nouvelle catégorie")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); if (name.trim()) m.mutate({ name: name.trim() }); }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Button type="button" size="sm" disabled={!name.trim() || m.isPending} onClick={() => m.mutate({ name: name.trim() })}>{t("Add", "Ajouter")}</Button>
      <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
    </div>
  );
}

function NewProductDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [brand, setBrand] = useState("Huanghe");
  const [unit, setUnit] = useState("pcs");
  const [description, setDescription] = useState("");
  const [tracksSerials, setTracksSerials] = useState(false);
  const [mode, setMode] = useState<"none" | "variants">("none");
  const [attrs, setAttrs] = useState<AttrDef[]>([{ name: "", values: "" }]);
  const [single, setSingle] = useState<VariantDraft>(() => newDraft());
  const [rows, setRows] = useState<VariantDraft[]>([]);
  const [defaultPrice, setDefaultPrice] = useState("");
  const [defaultReorder, setDefaultReorder] = useState("");
  const [error, setError] = useState<string | null>(null);

  const attrNames = useMemo(() => {
    const names = new Set<string>();
    attrs.forEach((a) => a.name.trim() && names.add(a.name.trim()));
    rows.forEach((r) => Object.keys(r.attributes).forEach((k) => names.add(k)));
    return Array.from(names);
  }, [attrs, rows]);

  const create = useApiMutation<unknown, Product>("POST", "/api/products", {
    success: t("Item created", "Article créé"),
    onSuccess: (p) => {
      onClose();
      onCreated(p.id);
    },
  });

  function generate() {
    const combos = combinations(attrs);
    if (!combos.length) {
      setError(t("Give each attribute a name and at least one value.", "Donnez un nom et au moins une valeur à chaque attribut."));
      return;
    }
    setError(null);
    // Keep what was already typed for combinations that still exist.
    const keyOf = (a: Record<string, string>) => JSON.stringify(Object.entries(a).sort());
    const existing = new Map(rows.map((r) => [keyOf(r.attributes), r]));
    setRows(combos.map((c) => existing.get(keyOf(c)) ?? newDraft(c, { sellPrice: defaultPrice, reorderLevel: defaultReorder })));
  }

  function updateRow(key: number, patch: Partial<VariantDraft>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function applyDefaults() {
    setRows((rs) => rs.map((r) => ({ ...r, sellPrice: defaultPrice || r.sellPrice, reorderLevel: defaultReorder || r.reorderLevel })));
  }

  function submit() {
    setError(null);
    if (!name.trim()) return setError(t("Give the item a name.", "Donnez un nom à l'article."));
    const drafts = mode === "none" ? [{ ...single, attributes: {} }] : rows;
    if (drafts.length === 0) return setError(t("Generate or add at least one variant.", "Générez ou ajoutez au moins une variante."));
    for (const r of drafts) {
      if (r.sellPrice && (d(r.sellPrice).isNegative() || !/^\d+(\.\d+)?$/.test(r.sellPrice.trim()))) return setError(t("Prices must be positive numbers.", "Les prix doivent être des nombres positifs."));
      if (mode === "variants" && Object.values(r.attributes).every((v) => !v.trim())) return setError(t("Each variant needs at least one attribute value.", "Chaque variante doit avoir au moins une valeur d'attribut."));
    }
    const seen = new Set<string>();
    for (const r of drafts) {
      const k = JSON.stringify(Object.entries(r.attributes).filter(([, v]) => v.trim()).sort());
      if (seen.has(k)) return setError(t("Two variants have the same attributes.", "Deux variantes ont les mêmes attributs."));
      seen.add(k);
    }
    create.mutate({
      name: name.trim(),
      categoryId,
      brand: brand.trim() || null,
      unit,
      description: description.trim() || null,
      tracksSerials,
      variants: drafts.map((r) => ({
        sku: r.sku.trim() || null,
        barcode: r.barcode.trim() || null,
        attributes: Object.fromEntries(Object.entries(r.attributes).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)),
        sellPrice: r.sellPrice.trim() ? d(r.sellPrice).toFixed(2) : "0.00",
        reorderLevel: r.reorderLevel.trim() ? d(r.reorderLevel).toString() : "0",
      })),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* grid-cols-[minmax(0,1fr)]: let wide rows (the variants table) scroll inside instead of widening the dialog on a phone. */}
      <DialogContent className="max-h-[92vh] max-w-4xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("New item", "Nouvel article")}</DialogTitle>
          <DialogDescription>
            {t("Stock is added later by a container offload or an opening-stock adjustment.", "Le stock s'ajoute ensuite par le déchargement d'un conteneur ou un ajustement de stock d'ouverture.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("Name", "Nom")} className="sm:col-span-2" required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Tyre, HJ125-8 motorcycle", "ex. Pneu, Moto HJ125-8")} />
          </Field>
          <Field label={t("Category", "Catégorie")}>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><CategorySelect value={categoryId} onChange={setCategoryId} /></div>
              <QuickCategoryButton onCreated={setCategoryId} />
            </div>
          </Field>
          <Field label={t("Brand", "Marque")}>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label={t("Unit", "Unité")}>
            <Select value={unit} onValueChange={setUnit}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => <SelectItem key={u} value={u}>{unitLabel(t, u)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="tracks" checked={tracksSerials} onCheckedChange={(v) => { setTracksSerials(v); if (v) setUnit("pcs"); }} />
            <div>
              <Label htmlFor="tracks">{t("Motorcycle (track chassis numbers)", "Moto (suivre les numéros de châssis)")}</Label>
              <p className="text-xs text-muted-foreground">{t("Each unit gets its own chassis and engine number.", "Chaque unité a son propre numéro de châssis et de moteur.")}</p>
            </div>
          </div>
          <Field label={t("Description", "Description")} className="sm:col-span-2">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>

        <div className="mt-2 min-w-0 space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{t("Variants (sizes, colours…)", "Variantes (tailles, couleurs…)")}</p>
            <div className="flex flex-wrap rounded-md border p-0.5">
              <Button type="button" size="sm" variant={mode === "none" ? "default" : "ghost"} onClick={() => setMode("none")}>{t("No variants", "Sans variantes")}</Button>
              <Button type="button" size="sm" variant={mode === "variants" ? "default" : "ghost"} onClick={() => setMode("variants")}>{t("Several variants", "Plusieurs variantes")}</Button>
            </div>
          </div>

          {mode === "none" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("Sell price (USD)", "Prix de vente (USD)")}><Input inputMode="decimal" value={single.sellPrice} onChange={(e) => setSingle({ ...single, sellPrice: e.target.value })} /></Field>
              <Field label={t("Reorder level", "Seuil de réappro.")}><Input inputMode="decimal" value={single.reorderLevel} onChange={(e) => setSingle({ ...single, reorderLevel: e.target.value })} /></Field>
              <Field label={t("SKU (blank = auto)", "Code (vide = auto)")}><Input value={single.sku} onChange={(e) => setSingle({ ...single, sku: e.target.value })} /></Field>
              <Field label={t("Barcode", "Code-barres")}><Input value={single.barcode} onChange={(e) => setSingle({ ...single, barcode: e.target.value })} /></Field>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {t("Define attributes, e.g. Size = “2.75-17, 3.00-18” and Colour = “Black, Red”, then generate every combination.", "Définissez les attributs, ex. Taille = «\u00a02.75-17, 3.00-18\u00a0» et Couleur = «\u00a0Noir, Rouge\u00a0», puis générez toutes les combinaisons.")}
              </p>
              <div className="space-y-2">
                {attrs.map((a, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[180px_1fr_auto]">
                    <Input placeholder={t("Attribute (e.g. Size)", "Attribut (ex. Taille)")} value={a.name} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <Input className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" placeholder={t("Values, separated by commas", "Valeurs, séparées par des virgules")} value={a.values} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} />
                    <Button type="button" variant="ghost" size="icon" className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto" onClick={() => setAttrs(attrs.length > 1 ? attrs.filter((_, j) => j !== i) : [{ name: "", values: "" }])}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setAttrs([...attrs, { name: "", values: "" }])}>
                  <Plus className="mr-1 h-4 w-4" /> {t("Attribute", "Attribut")}
                </Button>
                <Field label={t("Default price", "Prix par défaut")} className="w-32"><Input inputMode="decimal" value={defaultPrice} onChange={(e) => setDefaultPrice(e.target.value)} /></Field>
                <Field label={t("Default reorder", "Seuil par défaut")} className="w-32"><Input inputMode="decimal" value={defaultReorder} onChange={(e) => setDefaultReorder(e.target.value)} /></Field>
                <Button type="button" size="sm" onClick={generate}>
                  <Wand2 className="mr-1 h-4 w-4" /> {t("Generate variants", "Générer les variantes")}
                </Button>
                {rows.length > 0 && (
                  <Button type="button" size="sm" variant="ghost" onClick={applyDefaults}>{t("Apply defaults to all", "Appliquer à toutes")}</Button>
                )}
              </div>

              {rows.length > 0 && (
                <div className="max-w-full overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {attrNames.map((n) => <TableHead key={n}>{n}</TableHead>)}
                        <TableHead>{t("SKU (blank = auto)", "Code (vide = auto)")}</TableHead>
                        <TableHead>{t("Barcode", "Code-barres")}</TableHead>
                        <TableHead>{t("Price USD", "Prix USD")}</TableHead>
                        <TableHead>{t("Reorder", "Seuil")}</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.key}>
                          {attrNames.map((n) => (
                            <TableCell key={n} className="p-1">
                              <Input className="h-8 min-w-[90px]" value={r.attributes[n] ?? ""} onChange={(e) => updateRow(r.key, { attributes: { ...r.attributes, [n]: e.target.value } })} />
                            </TableCell>
                          ))}
                          <TableCell className="p-1"><Input className="h-8 min-w-[100px]" value={r.sku} onChange={(e) => updateRow(r.key, { sku: e.target.value })} /></TableCell>
                          <TableCell className="p-1"><Input className="h-8 min-w-[110px]" value={r.barcode} onChange={(e) => updateRow(r.key, { barcode: e.target.value })} /></TableCell>
                          <TableCell className="p-1"><Input className="h-8 w-24" inputMode="decimal" value={r.sellPrice} onChange={(e) => updateRow(r.key, { sellPrice: e.target.value })} /></TableCell>
                          <TableCell className="p-1"><Input className="h-8 w-20" inputMode="decimal" value={r.reorderLevel} onChange={(e) => updateRow(r.key, { reorderLevel: e.target.value })} /></TableCell>
                          <TableCell className="p-1">
                            <Button type="button" variant="ghost" size="icon" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" /></Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={attrNames.length === 0}
                  onClick={() => setRows([...rows, newDraft(Object.fromEntries(attrNames.map((n) => [n, ""])), { sellPrice: defaultPrice, reorderLevel: defaultReorder })])}
                >
                  <Plus className="mr-1 h-4 w-4" /> {t("Add row", "Ajouter une ligne")}
                </Button>
                <span className="text-xs text-muted-foreground">{count(t, rows.length, ["variant", "variants"], ["variante", "variantes"])}</span>
              </div>
            </>
          )}
        </div>

        {error && <ErrorText error={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={submit} disabled={create.isPending}>{t("Create item", "Créer l'article")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
