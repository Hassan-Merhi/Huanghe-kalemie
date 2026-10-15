import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { LocationSelect } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { d, qty as fmtQty, todayLocal, usd } from "@/lib/format";
import { useI18n, useT, count } from "@/lib/i18n";
import { downloadXlsx, readSheet } from "@/lib/sheets";
import type { Product } from "@/lib/types";

type T = (en: string, fr: string) => string;

// ---------------------------------------------------------------- Shared: header aliases and helpers

/** Header names accepted for each field (case, accents, spaces and punctuation are ignored). */
const ITEM_ALIASES = {
  name: ["name", "article", "item", "designation", "désignation", "produit", "product", "nom"],
  category: ["category", "catégorie", "categorie"],
  brand: ["brand", "marque"],
  unit: ["unit", "unité", "unite"],
  size: ["size", "taille", "dimension"],
  colour: ["colour", "color", "couleur"],
  sku: ["sku", "code", "référence", "reference", "ref"],
  barcode: ["barcode", "code-barres", "code barre", "ean", "upc"],
  motorcycle: ["motorcycle", "moto", "moto (oui/non)", "motorcycle (yes/no)"],
};

export const STOCK_FIELDS = {
  ...ITEM_ALIASES,
  sellPrice: ["price", "prix", "prix de vente", "sell price", "selling price", "pv"],
  reorderLevel: ["reorder", "seuil", "seuil de réapprovisionnement", "reorder level", "seuil d'alerte"],
  qty: ["qty", "quantité", "quantite", "quantity", "stock", "qté"],
  unitCost: ["cost", "coût", "cout", "coût unitaire", "unit cost", "prix d'achat", "purchase price"],
};

export const CONTAINER_FIELDS = {
  ...ITEM_ALIASES,
  sellPrice: ["prix de vente", "sell price", "selling price", "pv"],
  quantity: ["qty", "quantité", "quantite", "quantity", "qté"],
  unitPrice: [
    "prix unitaire", "prix unitaire (devise de la facture)", "unit price", "unit price (invoice currency)",
    "price", "prix", "fob", "prix d'achat", "cost", "coût", "coût unitaire", "unit cost",
  ],
  weightKg: ["poids", "poids total", "poids total (kg)", "poids (kg)", "weight", "weight (kg)", "total weight (kg)", "kg"],
  volumeCbm: ["volume", "volume total", "volume total (m³)", "volume (m³)", "total volume (m³)", "cbm", "m3", "m³"],
};

const PRICE_FIELDS = {
  sku: ["sku", "code", "référence", "reference", "ref"],
  barcode: ["barcode", "code-barres", "code barre", "ean", "upc"],
  sellPrice: ["price", "prix", "prix de vente", "sell price", "selling price", "nouveau prix", "new price"],
};

/** "12,5" (French decimal comma) becomes "12.5"; other text is left to the server. */
export function numCell(v: string | null): string | null {
  if (v == null) return null;
  const s = v.replace(/\s/g, "").replace(/\$/g, "");
  if (/^-?\d+,\d{1,2}$/.test(s)) return s.replace(",", ".");
  return s;
}

export interface PreviewRow {
  row: number;
  variantId: number | null;
  sku: string | null;
  status: "existing" | "new_variant" | "new_item" | "error";
  error?: string;
  errorFr?: string;
}

export function StatusBadge({ status }: { status: PreviewRow["status"] }) {
  const t = useT();
  if (status === "existing") return <Badge variant="secondary">{t("Already exists", "Existe déjà")}</Badge>;
  if (status === "new_variant") return <Badge variant="outline" className="border-sky-500 text-sky-700 dark:text-sky-300">{t("New variant", "Nouvelle variante")}</Badge>;
  if (status === "new_item") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600 dark:bg-emerald-500">{t("New item", "Nouvel article")}</Badge>;
  return <Badge variant="destructive">{t("Error", "Erreur")}</Badge>;
}

function PreviewCounts({ rows }: { rows: { status: PreviewRow["status"] }[] }) {
  const t = useT();
  const n = (s: PreviewRow["status"]) => rows.filter((r) => r.status === s).length;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <Badge variant="outline">{count(t, rows.length, ["row", "rows"], ["ligne", "lignes"])}</Badge>
      <Badge variant="secondary">{count(t, n("existing"), ["existing", "existing"], ["existant", "existants"])}</Badge>
      <Badge variant="outline">{count(t, n("new_variant"), ["new variant", "new variants"], ["nouvelle variante", "nouvelles variantes"])}</Badge>
      <Badge variant="outline">{count(t, n("new_item"), ["new item", "new items"], ["nouvel article", "nouveaux articles"])}</Badge>
      {n("error") > 0 && <Badge variant="destructive">{count(t, n("error"), ["error", "errors"], ["erreur", "erreurs"])}</Badge>}
    </div>
  );
}

function FilePicker({ onFile, busy }: { onFile: (f: File) => void; busy?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setName(f.name);
            onFile(f);
          }
          e.target.value = "";
        }}
      />
      <Button variant="outline" onClick={() => ref.current?.click()} disabled={busy}>
        <Upload className="mr-1 h-4 w-4" /> {t("Choose a file (.xlsx, .xls, .csv)", "Choisir un fichier (.xlsx, .xls, .csv)")}
      </Button>
      {name && <span className="flex items-center gap-1 text-sm text-muted-foreground"><FileSpreadsheet className="h-4 w-4" /> {name}</span>}
    </div>
  );
}

const variantOf = (r: { size?: string | null; colour?: string | null }) => [r.size, r.colour].filter(Boolean).join(" / ");
const rowError = (p: PreviewRow | undefined, lang: string) => (p ? (lang === "fr" ? p.errorFr ?? p.error : p.error ?? p.errorFr) : undefined);

// ---------------------------------------------------------------- Page

export default function StockImport() {
  const t = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState("items");
  if (!can("manager")) return <EmptyState title={t("Managers only", "Réservé aux gérants")} />;
  return (
    <div>
      <PageHeader
        title={t("Stock import", "Import de stock")}
        description={t("Load items, opening stock and prices from a spreadsheet, or export the list to edit it.", "Charger les articles, le stock d'ouverture et les prix depuis un tableur, ou exporter la liste pour la modifier.")}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="items">{t("Items and opening stock", "Articles et stock d'ouverture")}</TabsTrigger>
            <TabsTrigger value="prices">{t("Prices", "Prix")}</TabsTrigger>
            <TabsTrigger value="export">{t("Export", "Exporter")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="items"><ItemsImport /></TabsContent>
        <TabsContent value="prices"><PricesImport /></TabsContent>
        <TabsContent value="export"><ExportItems /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- (1) Items and opening stock

function itemHeaders(t: T) {
  return [
    t("Category", "Catégorie"), t("Item", "Article"), t("Brand", "Marque"), t("Unit", "Unité"), t("Size", "Taille"), t("Colour", "Couleur"),
    "SKU", t("Barcode", "Code-barres"), t("Sell price", "Prix de vente"), t("Reorder level", "Seuil de réapprovisionnement"),
    t("Motorcycle (yes/no)", "Moto (oui/non)"), t("Quantity", "Quantité"), t("Unit cost", "Coût unitaire"),
  ];
}

type StockRow = Record<keyof typeof STOCK_FIELDS, string | null>;

interface ImportResult {
  created: number;
  newVariants: number;
  existing: number;
  stockLines: number;
  adjustment: { id?: number; number?: string } | null;
}

function ItemsImport() {
  const t = useT();
  const { lang } = useI18n();
  const [rows, setRows] = useState<StockRow[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [day, setDay] = useState(todayLocal());
  const [updatePrices, setUpdatePrices] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function template() {
    const yes = t("yes", "oui");
    const no = t("no", "non");
    downloadXlsx(t("items-template.xlsx", "modele-articles.xlsx"), [
      itemHeaders(t),
      [t("Tyres", "Pneus"), t("Rear tyre", "Pneu arrière"), "Kenda", t("pc", "pce"), "3.00-18", "", "", "", 25, 10, no, 40, 14.5],
      [t("Tyres", "Pneus"), t("Rear tyre", "Pneu arrière"), "Kenda", t("pc", "pce"), "2.75-18", "", "", "", 22, 10, no, 30, 12.75],
      [t("Motorcycles", "Motos"), "Huanghe HH150", "Huanghe", t("pc", "pce"), "", t("Red", "Rouge"), "HH150-RED", "", 1350, 2, yes, "", ""],
    ], t("Items", "Articles"));
  }

  async function load(file: File) {
    setFileError(null);
    setResult(null);
    setRows([]);
    setPreview([]);
    try {
      const { rows: raw, found } = await readSheet(file, STOCK_FIELDS);
      if (!found.includes("name")) {
        setFileError(t("No item name column found. Name a column \"Article\" (or \"Item\", \"Désignation\").", "Aucune colonne de nom d'article trouvée. Nommez une colonne « Article » (ou « Item », « Désignation »)."));
        return;
      }
      if (!raw.length) {
        setFileError(t("The file has no rows.", "Le fichier ne contient aucune ligne."));
        return;
      }
      const clean = raw.map((r) => ({ ...r, sellPrice: numCell(r.sellPrice), reorderLevel: numCell(r.reorderLevel), qty: numCell(r.qty), unitCost: numCell(r.unitCost) }));
      setRows(clean);
      setBusy(true);
      const p = await api<PreviewRow[]>("POST", "/api/import/items/preview", { rows: clean.map(({ qty: _q, unitCost: _c, ...r }) => r) });
      setPreview(p);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Client-side checks the server would refuse anyway: opening quantity without a cost.
  const localError = (r: StockRow): string | null => {
    const q = r.qty ? d(r.qty) : null;
    if (r.qty && !/^-?\d+(\.\d+)?$/.test(r.qty)) return t("Quantity is not a number", "La quantité n'est pas un nombre");
    if (q && q.isNegative()) return t("Quantity cannot be negative", "La quantité ne peut pas être négative");
    if (q && q.gt(0) && !r.unitCost) return t("Give the unit cost for the opening quantity", "Indiquez le coût unitaire de la quantité d'ouverture");
    return null;
  };
  const merged = rows.map((r, i) => {
    const p = preview[i];
    const err = rowError(p?.status === "error" ? p : undefined, lang) ?? localError(r);
    return { r, p, err, status: (err ? "error" : p?.status ?? "existing") as PreviewRow["status"] };
  });
  const errors = merged.filter((m) => m.err).length;

  const run = useApiMutation<unknown, ImportResult>("POST", "/api/import/items", {
    success: t("Import done", "Importation terminée"),
    onSuccess: (res) => {
      setResult(res);
      setRows([]);
      setPreview([]);
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t("1. Prepare the file", "1. Préparer le fichier")}</CardTitle>
          <CardDescription>
            {t(
              "One row per variant (size or colour). Rows with a quantity are booked as opening stock (Dr stock, Cr opening balances); if one row is wrong the whole file is refused.",
              "Une ligne par variante (taille ou couleur). Les lignes avec une quantité sont enregistrées comme stock d'ouverture (Débit stock, Crédit soldes d'ouverture) ; si une ligne est fausse, tout le fichier est refusé.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={template}><Download className="mr-1 h-4 w-4" /> {t("Download the template", "Télécharger le modèle")}</Button>
          <FilePicker onFile={load} busy={busy || run.isPending} />
        </CardContent>
      </Card>

      {fileError && <ErrorText error={fileError} />}
      {busy && <Loading label={t("Checking the file…", "Vérification du fichier…")} />}

      {result && (
        <Alert className="border-emerald-500">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <AlertDescription className="space-y-1">
            <p className="font-medium">
              {t(
                `${count(t, result.created, ["new item", "new items"], ["", ""])}, ${count(t, result.newVariants, ["new variant", "new variants"], ["", ""])}, ${result.existing} existing, ${count(t, result.stockLines, ["opening stock line", "opening stock lines"], ["", ""])}.`,
                `${count(t, result.created, ["", ""], ["nouvel article", "nouveaux articles"])}, ${count(t, result.newVariants, ["", ""], ["nouvelle variante", "nouvelles variantes"])}, ${count(t, result.existing, ["", ""], ["existant", "existants"])}, ${count(t, result.stockLines, ["", ""], ["ligne de stock d'ouverture", "lignes de stock d'ouverture"])}.`,
              )}
            </p>
            <p className="flex flex-wrap gap-3 text-sm">
              <Link href="/stock?tab=history" className="underline underline-offset-2">{t("See stock movements", "Voir les mouvements de stock")}</Link>
              <Link href="/daybook" className="underline underline-offset-2">{t("Day book", "Journal du jour")}</Link>
              <Link href="/products" className="underline underline-offset-2">{t("Items", "Articles")}</Link>
            </p>
          </AlertDescription>
        </Alert>
      )}

      {rows.length > 0 && !busy && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">{t("2. Check and import", "2. Vérifier et importer")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PreviewCounts rows={merged} />
            <div className="max-h-[480px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead>{t("Variant", "Variante")}</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className="text-right">{t("Cost", "Coût")}</TableHead>
                    <TableHead>{t("Status", "Statut")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {merged.map(({ r, p, err, status }, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground"><Num>{p?.row ?? i + 2}</Num></TableCell>
                      <TableCell className="min-w-[160px]">
                        <div className="font-medium">{r.name}</div>
                        {r.category && <div className="text-xs text-muted-foreground">{r.category}</div>}
                        {err && <div className="text-xs text-destructive">{err}</div>}
                      </TableCell>
                      <TableCell>{variantOf(r) || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{p?.sku ?? r.sku ?? "—"}</TableCell>
                      <TableCell className="text-right"><Num>{r.qty ? fmtQty(r.qty) : "—"}</Num></TableCell>
                      <TableCell className="text-right"><Num>{r.unitCost ? usd(r.unitCost) : "—"}</Num></TableCell>
                      <TableCell><StatusBadge status={status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("Location (opening stock)", "Emplacement (stock d'ouverture)")} required>
                <LocationSelect value={locationId} onChange={setLocationId} />
              </Field>
              <Field label={t("Opening stock date", "Date du stock d'ouverture")} required>
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
              <div className="flex items-center gap-2 sm:pt-7">
                <Checkbox id="upd-prices" checked={updatePrices} onCheckedChange={(v) => setUpdatePrices(v === true)} />
                <Label htmlFor="upd-prices" className="font-normal">{t("Update prices of existing items", "Mettre à jour les prix des articles existants")}</Label>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" onClick={() => { setRows([]); setPreview([]); }}>{t("Cancel", "Annuler")}</Button>
              <SubmitButton
                blocked={errors > 0 ? t("Fix the errors in the file and load it again", "Corrigez les erreurs dans le fichier et chargez-le à nouveau") : !locationId ? t("Choose the location", "Choisissez l'emplacement") : !day && t("Choose the opening stock date", "Choisissez la date du stock d'ouverture")}
                pending={run.isPending}
                onClick={() => run.mutate({ date: day, locationId, updatePrices, rows })}
              >
                <Upload className="mr-1 h-4 w-4" /> {t("Import", "Importer")} ({rows.length})
              </SubmitButton>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- (2) Prices

type PriceRow = Record<keyof typeof PRICE_FIELDS, string | null>;

function PricesImport() {
  const t = useT();
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);

  function template() {
    downloadXlsx(t("prices-template.xlsx", "modele-prix.xlsx"), [
      ["SKU", t("Barcode", "Code-barres"), t("Sell price", "Prix de vente")],
      ["HH150-RED", "", 1350],
      ["", "6901234567890", 25],
    ], t("Prices", "Prix"));
  }

  async function load(file: File) {
    setFileError(null);
    setUpdated(null);
    setRows([]);
    try {
      const { rows: raw, found } = await readSheet(file, PRICE_FIELDS);
      if (!found.includes("sellPrice") || (!found.includes("sku") && !found.includes("barcode"))) {
        setFileError(t("The file needs a SKU or barcode column and a price column.", "Le fichier doit avoir une colonne SKU ou code-barres et une colonne de prix."));
        return;
      }
      setRows(raw.map((r) => ({ ...r, sellPrice: numCell(r.sellPrice) })));
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }

  const problem = (r: PriceRow) => {
    if (!r.sku && !r.barcode) return t("SKU or barcode missing", "SKU ou code-barres manquant");
    if (!r.sellPrice || !/^\d+(\.\d+)?$/.test(r.sellPrice)) return t("Price is not a valid number", "Le prix n'est pas un nombre valide");
    return null;
  };
  const errors = rows.filter((r) => problem(r)).length;

  const run = useApiMutation<unknown, { updated: number }>("POST", "/api/import/prices", {
    success: t("Prices updated", "Prix mis à jour"),
    onSuccess: (res) => {
      setUpdated(res.updated);
      setRows([]);
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t("Update sell prices", "Mettre à jour les prix de vente")}</CardTitle>
          <CardDescription>{t("Items are found by SKU or barcode. Nothing else changes.", "Les articles sont trouvés par SKU ou code-barres. Rien d'autre ne change.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={template}><Download className="mr-1 h-4 w-4" /> {t("Download the template", "Télécharger le modèle")}</Button>
          <FilePicker onFile={load} busy={run.isPending} />
        </CardContent>
      </Card>
      {fileError && <ErrorText error={fileError} />}
      {updated !== null && (
        <Alert className="border-emerald-500">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <AlertDescription>{t(`${updated} prices updated.`, `${updated} prix mis à jour.`)}</AlertDescription>
        </Alert>
      )}
      {rows.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">{count(t, rows.length, ["row", "rows"], ["ligne", "lignes"])}{errors > 0 && <span className="text-destructive"> · {count(t, errors, ["error", "errors"], ["erreur", "erreurs"])}</span>}</p>
            <div className="max-h-[420px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>{t("Barcode", "Code-barres")}</TableHead>
                    <TableHead className="text-right">{t("New price", "Nouveau prix")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => {
                    const err = problem(r);
                    return (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground"><Num>{i + 2}</Num></TableCell>
                        <TableCell className="font-mono text-xs">{r.sku ?? "—"}{err && <div className="font-sans text-destructive">{err}</div>}</TableCell>
                        <TableCell className="font-mono text-xs">{r.barcode ?? "—"}</TableCell>
                        <TableCell className="text-right"><Num>{r.sellPrice && !err ? usd(r.sellPrice) : r.sellPrice ?? "—"}</Num></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setRows([])}>{t("Cancel", "Annuler")}</Button>
              <SubmitButton blocked={errors > 0 && t("Fix the errors in the file and load it again", "Corrigez les erreurs dans le fichier et chargez-le à nouveau")} pending={run.isPending} onClick={() => run.mutate({ rows })}>
                <Upload className="mr-1 h-4 w-4" /> {t("Update prices", "Mettre à jour les prix")} ({rows.length})
              </SubmitButton>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- (3) Export

interface StockItem {
  variantId: number;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  productId: number;
  productName: string;
  categoryName: string | null;
  unit: string;
  qty: string;
  sellPrice: string;
  reorderLevel: string;
  avgCost: string;
}

/** Split a variant's attributes into size and colour columns, matching the template. */
function sizeColour(attributes: Record<string, string>) {
  let size = "";
  let colour = "";
  const rest: string[] = [];
  for (const [k, v] of Object.entries(attributes ?? {})) {
    const key = k.toLowerCase();
    if (!colour && /colou?r|couleur/.test(key)) colour = v;
    else if (!size && /size|taille/.test(key)) size = v;
    else rest.push(v);
  }
  if (!size && rest.length) size = rest.shift()!;
  if (rest.length) size = [size, ...rest].filter(Boolean).join(" ");
  return { size, colour };
}

function ExportItems() {
  const t = useT();
  const stockQ = useQuery<{ items: StockItem[] }>({ queryKey: ["/api/stock"] });
  const productsQ = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const byProduct = useMemo(() => new Map((productsQ.data ?? []).map((p) => [p.id, p])), [productsQ.data]);
  const items = stockQ.data?.items ?? [];

  function exportXlsx(withStock: boolean) {
    const yes = t("yes", "oui");
    const no = t("no", "non");
    const rows: unknown[][] = [itemHeaders(t)];
    for (const i of items) {
      const p = byProduct.get(i.productId);
      const { size, colour } = sizeColour(i.attributes);
      rows.push([
        i.categoryName ?? "", i.productName, p?.brand ?? "", i.unit ?? "", size, colour, i.sku, i.barcode ?? "",
        Number(i.sellPrice), Number(i.reorderLevel), p?.tracksSerials ? yes : no,
        withStock ? Number(i.qty) : "", withStock ? Number(i.avgCost) : "",
      ]);
    }
    downloadXlsx(`${t("items", "articles")}_${todayLocal()}.xlsx`, rows, t("Items", "Articles"));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("Export the item list", "Exporter la liste des articles")}</CardTitle>
        <CardDescription>
          {t(
            "Same columns as the import template: edit prices or details in Excel, then load it again. Leave Quantity empty when re-importing, otherwise it is added as opening stock.",
            "Mêmes colonnes que le modèle d'import : modifiez les prix ou les détails dans Excel, puis rechargez le fichier. Laissez la quantité vide pour réimporter, sinon elle est ajoutée comme stock d'ouverture.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorText error={stockQ.error} />
        {stockQ.isLoading ? <Loading /> : <p className="text-sm text-muted-foreground">{count(t, items.length, ["variant", "variants"], ["variante", "variantes"])}</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => exportXlsx(false)} disabled={!items.length}><Download className="mr-1 h-4 w-4" /> {t("Export for re-import (no quantities)", "Exporter pour réimport (sans quantités)")}</Button>
          <Button variant="outline" onClick={() => exportXlsx(true)} disabled={!items.length}><Download className="mr-1 h-4 w-4" /> {t("Export with stock and cost", "Exporter avec stock et coût")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Container packing list (used by ContainerDetail)

type ContainerRowIn = Record<keyof typeof CONTAINER_FIELDS, string | null>;

export function ContainerImportButton({ containerId, currency, linesDirty, onImported }: { containerId: number; currency: string; linesDirty: boolean; onImported: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileSpreadsheet className="mr-1 h-4 w-4" /> {t("Import the packing list (Excel)", "Importer la liste de colisage (Excel)")}
      </Button>
      {open && (
        <ContainerImportDialog
          containerId={containerId}
          currency={currency}
          linesDirty={linesDirty}
          onClose={() => setOpen(false)}
          onImported={() => { setOpen(false); onImported(); }}
        />
      )}
    </>
  );
}

function ContainerImportDialog({ containerId, currency, linesDirty, onClose, onImported }: { containerId: number; currency: string; linesDirty: boolean; onClose: () => void; onImported: () => void }) {
  const t = useT();
  const { lang } = useI18n();
  const [rows, setRows] = useState<ContainerRowIn[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"append" | "replace">("append");

  function template() {
    const yes = t("yes", "oui");
    const no = t("no", "non");
    downloadXlsx(t("packing-list-template.xlsx", "modele-colisage.xlsx"), [
      [
        t("Category", "Catégorie"), t("Item", "Article"), t("Size", "Taille"), t("Colour", "Couleur"), "SKU", t("Motorcycle (yes/no)", "Moto (oui/non)"),
        t("Quantity", "Quantité"), t("Unit price (invoice currency)", "Prix unitaire (devise de la facture)"),
        t("Total weight (kg)", "Poids total (kg)"), t("Total volume (m³)", "Volume total (m³)"), t("Sell price", "Prix de vente"),
      ],
      [t("Motorcycles", "Motos"), "Huanghe HH150", "", t("Red", "Rouge"), "HH150-RED", yes, 20, 650, 2400, 12, 1350],
      [t("Tyres", "Pneus"), t("Rear tyre", "Pneu arrière"), "3.00-18", "", "", no, 200, 9.5, 900, 3.5, 25],
    ], t("Packing list", "Colisage"));
  }

  async function load(file: File) {
    setFileError(null);
    setRows([]);
    setPreview([]);
    try {
      const { rows: raw, found } = await readSheet(file, CONTAINER_FIELDS);
      if (!found.includes("name")) {
        setFileError(t("No item name column found. Name a column \"Article\" (or \"Item\").", "Aucune colonne de nom d'article trouvée. Nommez une colonne « Article » (ou « Item »)."));
        return;
      }
      if (!found.includes("quantity") || !found.includes("unitPrice")) {
        setFileError(t("The file needs a Quantity and a Unit price column.", "Le fichier doit avoir une colonne Quantité et une colonne Prix unitaire."));
        return;
      }
      const clean = raw.map((r) => ({ ...r, quantity: numCell(r.quantity), unitPrice: numCell(r.unitPrice), weightKg: numCell(r.weightKg), volumeCbm: numCell(r.volumeCbm), sellPrice: numCell(r.sellPrice) }));
      setRows(clean);
      setBusy(true);
      setPreview(await api<PreviewRow[]>("POST", "/api/import/items/preview", { rows: clean.map(({ quantity: _q, unitPrice: _p, weightKg: _w, volumeCbm: _v, ...r }) => r) }));
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const localError = (r: ContainerRowIn) => {
    if (!r.quantity || !/^\d+(\.\d+)?$/.test(r.quantity) || d(r.quantity).lte(0)) return t("Quantity must be above zero", "La quantité doit être supérieure à zéro");
    if (!r.unitPrice || !/^\d+(\.\d+)?$/.test(r.unitPrice)) return t("Enter the unit price", "Entrez le prix unitaire");
    return null;
  };
  const merged = rows.map((r, i) => {
    const p = preview[i];
    const err = rowError(p?.status === "error" ? p : undefined, lang) ?? localError(r);
    return { r, p, err, status: (err ? "error" : p?.status ?? "existing") as PreviewRow["status"] };
  });
  const errors = merged.filter((m) => m.err).length;
  const total = rows.reduce((s, r) => s.plus(d(r.quantity).times(d(r.unitPrice))), d(0));

  const run = useApiMutation<unknown, { imported: number; created: number; newVariants: number }>("POST", `/api/containers/${containerId}/import-lines`, {
    success: t("Lines imported", "Lignes importées"),
    onSuccess: onImported,
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Import the packing list", "Importer la liste de colisage")}</DialogTitle>
          <DialogDescription>
            {t(
              `One row per item and size. Unit prices are in the invoice currency (${currency}); weight and volume are totals for the line. Missing items are created.`,
              `Une ligne par article et taille. Les prix unitaires sont dans la devise de la facture (${currency}) ; le poids et le volume sont des totaux pour la ligne. Les articles manquants sont créés.`,
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {linesDirty && (
            <Alert variant="destructive">
              <AlertDescription>
                {t(
                  "The lines below have unsaved changes. Importing reloads the lines from the server and those changes will be lost. Save them first if you want to keep them.",
                  "Les lignes ont des modifications non enregistrées. L'importation recharge les lignes depuis le serveur et ces modifications seront perdues. Enregistrez-les d'abord pour les garder.",
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={template}><Download className="mr-1 h-4 w-4" /> {t("Download the template", "Télécharger le modèle")}</Button>
            <FilePicker onFile={load} busy={busy || run.isPending} />
          </div>
          {fileError && <ErrorText error={fileError} />}
          {busy && <Loading label={t("Checking the file…", "Vérification du fichier…")} />}
          {rows.length > 0 && !busy && (
            <>
              <PreviewCounts rows={merged} />
              <div className="max-h-[320px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>{t("Item", "Article")}</TableHead>
                      <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                      <TableHead className="text-right">{t(`Price (${currency})`, `Prix (${currency})`)}</TableHead>
                      <TableHead>{t("Status", "Statut")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {merged.map(({ r, p, err, status }, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground"><Num>{p?.row ?? i + 2}</Num></TableCell>
                        <TableCell className="min-w-[150px]">
                          <div className="font-medium">{r.name}{variantOf(r) && <span className="font-normal text-muted-foreground"> · {variantOf(r)}</span>}</div>
                          <div className="font-mono text-xs text-muted-foreground">{p?.sku ?? r.sku ?? ""}</div>
                          {err && <div className="text-xs text-destructive">{err}</div>}
                        </TableCell>
                        <TableCell className="text-right"><Num>{r.quantity ? fmtQty(r.quantity) : "—"}</Num></TableCell>
                        <TableCell className="text-right"><Num>{r.unitPrice ?? "—"}</Num></TableCell>
                        <TableCell><StatusBadge status={status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-sm text-muted-foreground">{t("Purchase value", "Valeur d'achat")} : <span className="font-medium text-foreground tabular">{total.toFixed(2)} {currency}</span></p>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="import-mode" checked={mode === "append"} onChange={() => setMode("append")} /> {t("Add to the lines", "Ajouter aux lignes")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> {t("Replace the lines", "Remplacer les lignes")}
                </label>
              </div>
            </>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            blocked={!busy && (!rows.length ? t("Load a file with at least one row", "Chargez un fichier avec au moins une ligne") : errors > 0 && t("Fix the errors in the file and load it again", "Corrigez les erreurs dans le fichier et chargez-le à nouveau"))}
            pending={busy || run.isPending}
            onClick={() => run.mutate({ mode, rows })}
          >
            <Upload className="mr-1 h-4 w-4" /> {mode === "replace" ? t("Replace the lines", "Remplacer les lignes") : t("Add to the lines", "Ajouter aux lignes")} ({rows.length})
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
