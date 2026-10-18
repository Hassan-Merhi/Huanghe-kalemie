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
import { SectionLinks } from "@/components/AppLayout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { LocationSelect } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { curLabel, d, money, number, qty as fmtQty, todayLocal, usd } from "@/lib/format";
import { useI18n, useT, count } from "@/lib/i18n";
import { amountCellUnsure, downloadXlsx, readNumberCell, readSheet, toWire } from "@/lib/sheets";
import { knownUnit, unitLabel, wholeUnit } from "@/lib/units";
import type { Product } from "@/lib/types";
import { typedCurrencyMark } from "@shared/money";

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
  /** The unit of the item the row matched. */
  unit?: string | null;
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
      <Badge variant="outline">{count(t, rows.length - n("error"), ["row to import", "rows to import"], ["ligne à importer", "lignes à importer"])}</Badge>
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

type Cells = Partial<Record<string, string | number>>;

/**
 * Number cells read again now that each row's unit is known (see readNumberCell): `fields` are always
 * measures (weight, volume), `qtyField` only when the row's item is not counted in whole units. A row's
 * unit is its item's own when the item exists (the file cannot change it), else the file's unit for that
 * item (its first row naming one), else pieces.
 * Returns the rows to show and send, per row the question to ask about a "1.000", and per row its unit.
 */
function remeasure<R extends { name: string | null; unit: string | null }>(
  t: T,
  rows: R[],
  cells: Cells[],
  preview: PreviewRow[],
  qtyField: keyof R & string,
  fields: { key: keyof R & string; en: string; fr: string }[],
): { rows: R[]; unsure: (string | null)[]; units: string[] } {
  const fileUnit = new Map<string, string>();
  for (const r of rows) {
    const k = (r.name ?? "").trim().toLowerCase();
    if (r.unit?.trim() && !fileUnit.has(k)) fileUnit.set(k, r.unit.trim());
  }
  const unsure: (string | null)[] = [];
  const units: string[] = [];
  const out = rows.map((r, i) => {
    const unit = preview[i]?.unit ?? fileUnit.get((r.name ?? "").trim().toLowerCase()) ?? "pcs";
    units.push(unit);
    const all = [{ key: qtyField, en: "Quantity", fr: "Quantité", measured: !wholeUnit(unit) }, ...fields.map((f) => ({ ...f, measured: true }))];
    const next = { ...r };
    let question: string | null = null;
    for (const f of all) {
      if (cells[i]?.[f.key] === undefined) continue;
      const { value, unsure: u } = readNumberCell(cells[i][f.key], f.measured);
      (next as Record<string, string | null>)[f.key] = value;
      if (u && !question) {
        const text = String(cells[i][f.key]).trim();
        question = t(`${f.en} "${text}": ${fmtQty(u[0])} or ${fmtQty(u[1])}? Correct the file`, `${f.fr} «\u00a0${text}\u00a0»\u00a0: ${fmtQty(u[0])} ou ${fmtQty(u[1])}\u00a0? Corrigez le fichier`);
      }
    }
    unsure.push(question);
    return next;
  });
  return { rows: out, unsure, units };
}
/** A number cell in the preview; while its row asks "1 000 or 1?", the cell is shown as the file has it. */
const measureCell = (value: string | null, asked: string | number | false | null | undefined) =>
  asked !== undefined && asked !== null && asked !== false && String(asked).trim() ? String(asked).trim() : value ? fmtQty(value) : "—";
/** A price or cost in the preview; one in doubt ("4.125": 4 125 or 4,125?) is shown as the file has it, not as one reading. */
const amountCell = (value: string | null | undefined, raw: string | number | null | undefined, decimals: number) =>
  amountCellUnsure(raw) ? String(raw).trim() : value ? (/^\d+(\.\d+)?$/.test(value) ? number(value, decimals, 2) : value) : "—";
/**
 * The question to ask about a price or cost typed as text that could be thousands or three decimals
 * ("4.125": 4 125 or 4,125?). The server refuses such a cell, so the row cannot be imported until the
 * file says which.
 */
const CUR_NAME: Record<string, [string, string]> = { USD: ["US dollars", "dollars US"], CDF: ["francs", "francs"], CNY: ["yuan", "yuans"] };

function amountQuestion(t: T, cells: Cells | undefined, fields: { key: string; en: string; fr: string; currency?: string }[]): string | null {
  for (const f of fields) {
    const raw = cells?.[f.key];
    // "28 000 FC" in a dollar column: the server refuses it, so the row says so first.
    const mark = typedCurrencyMark(raw);
    if (mark && f.currency && mark !== f.currency) {
      const text = String(raw).trim();
      const [isEn, isFr] = CUR_NAME[mark] ?? [mark, mark];
      const [wantEn, wantFr] = CUR_NAME[f.currency] ?? [f.currency, f.currency];
      return mark === "mixed"
        ? t(`${f.en} "${text}" names two currencies: keep one`, `${f.fr} «\u00a0${text}\u00a0» indique deux devises\u00a0: n'en gardez qu'une`)
        : t(`${f.en} "${text}" is in ${isEn}, not ${wantEn}`, `${f.fr} «\u00a0${text}\u00a0» est en ${isFr}, pas en ${wantFr}`);
    }
    const u = amountCellUnsure(raw);
    if (!u) continue;
    const text = String(raw).trim();
    return t(
      // Both readings get their own way out: "4.125" or "1,000" typed as text stays in doubt, so the decimals go
      // in as a number cell.
      `${f.en} "${text}": ${number(u[0], 6)} or ${number(u[1], 6)}? For ${number(u[0], 6)}, write ${u[0]} without the separator; for ${number(u[1], 6)}, write it as a number in Excel`,
      `${f.fr} «\u00a0${text}\u00a0»\u00a0: ${number(u[0], 6)} ou ${number(u[1], 6)}\u00a0? Pour ${number(u[0], 6)}, écrivez ${u[0]} sans séparateur\u00a0; pour ${number(u[1], 6)}, écrivez-le comme nombre dans Excel`,
    );
  }
  return null;
}
const SELL_PRICE = { key: "sellPrice", en: "Sell price", fr: "Prix de vente", currency: "USD" };
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
            <SectionLinks />
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
    t("SKU", "Code"), t("Barcode", "Code-barres"), t("Sell price", "Prix de vente"), t("Reorder level", "Seuil de réapprovisionnement"),
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
  const { user } = useAuth();
  const [fileRows, setRows] = useState<StockRow[]>([]);
  const [cells, setCells] = useState<Cells[]>([]);
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
      const { rows: raw, found, cells: rawCells } = await readSheet(file, STOCK_FIELDS);
      if (!found.includes("name")) {
        setFileError(t("No item name column found. Name a column \"Article\" (or \"Item\", \"Désignation\").", "Aucune colonne de nom d'article trouvée. Nommez une colonne «\u00a0Article\u00a0» (ou «\u00a0Item\u00a0», «\u00a0Désignation\u00a0»)."));
        return;
      }
      if (!raw.length) {
        setFileError(t("The file has no rows.", "Le fichier ne contient aucune ligne."));
        return;
      }
      const clean = raw.map((r) => ({ ...r, sellPrice: numCell(r.sellPrice), reorderLevel: numCell(r.reorderLevel), qty: numCell(r.qty), unitCost: numCell(r.unitCost) }));
      setRows(clean);
      setCells(rawCells);
      setBusy(true);
      const p = await api<PreviewRow[]>("POST", "/api/import/items/preview", { rows: clean.map(({ qty: _q, unitCost: _c, ...r }) => toWire(r)) });
      setPreview(p);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Client-side checks the server would refuse anyway: opening quantity without a cost, 2,5 pieces.
  const localError = (r: StockRow, unit: string): string | null => {
    const q = r.qty ? d(r.qty) : null;
    if (r.qty && !/^-?\d+(\.\d+)?$/.test(r.qty)) return t("Quantity is not a number", "La quantité n'est pas un nombre");
    if (q && q.isNegative()) return t("Quantity cannot be negative", "La quantité ne peut pas être négative");
    if (q && !q.isInteger() && wholeUnit(unit)) return t(`Counted by the ${unitLabel(t, unit, 1)}: the quantity must be a whole number`, `Se compte à l'unité (${unitLabel(t, unit, 1)})\u00a0: la quantité doit être un nombre entier`);
    if (q && q.gt(0) && !r.unitCost) return t("Give the unit cost for the opening quantity", "Indiquez le coût unitaire de la quantité d'ouverture");
    return null;
  };
  // Litres and kilos: "2,250" is 2,25 once the row's unit is known.
  const { rows, unsure, units } = useMemo(() => remeasure(t, fileRows, cells, preview, "qty", []), [t, fileRows, cells, preview]);
  const merged = rows.map((r, i) => {
    const p = preview[i];
    const err = rowError(p?.status === "error" ? p : undefined, lang) ?? unsure[i] ?? amountQuestion(t, cells[i], [SELL_PRICE, { key: "unitCost", en: "Unit cost", fr: "Coût unitaire", currency: "USD" }]) ?? localError(r, units[i]);
    // A unit the shop does not know is kept as typed, and its quantity may have decimals: said, not refused.
    const note = !err && !knownUnit(units[i])
      ? t(`Unknown unit "${units[i].trim()}": kept as typed, decimals allowed`, `Unité «\u00a0${units[i].trim()}\u00a0» inconnue\u00a0: gardée telle quelle, décimales permises`)
      : null;
    return { r, p, err, note, unsure: unsure[i], status: (err ? "error" : p?.status ?? "existing") as PreviewRow["status"] };
  });
  const errors = merged.filter((m) => m.err).length;
  // Quantities are opening stock, which only the owner may enter (the server refuses it): said before "Importer".
  const stockRows = rows.filter((r) => r.qty && !d(r.qty).isZero()).length;
  const ownerOnly = user?.role !== "owner" && stockRows > 0;

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
              "Une ligne par variante (taille ou couleur). Les lignes avec une quantité sont enregistrées comme stock de départ\u00a0; si une ligne est fausse, tout le fichier est refusé.",
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
            {ownerOnly && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="import-owner-only">
                {t(
                  `${stockRows === 1 ? "1 row has" : `${stockRows} rows have`} a quantity: opening stock, which only the owner can import. Remove the quantities from the file to import the items only, or ask the owner.`,
                  `${stockRows === 1 ? "1 ligne a" : `${stockRows} lignes ont`} une quantité\u00a0: c'est du stock d'ouverture, que seul le propriétaire peut importer. Retirez les quantités du fichier pour importer seulement les articles, ou demandez au propriétaire.`,
                )}
              </p>
            )}
            <div className="max-h-[480px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead>{t("Variant", "Variante")}</TableHead>
                    <TableHead>{t("SKU", "Code")}</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className="text-right">{t("Cost", "Coût")}</TableHead>
                    <TableHead>{t("Status", "Statut")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {merged.map(({ r, p, err, note, unsure: asked, status }, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground"><Num>{p?.row ?? i + 2}</Num></TableCell>
                      <TableCell className="min-w-[160px]">
                        <div className="font-medium">{r.name}</div>
                        {r.category && <div className="text-xs text-muted-foreground">{r.category}</div>}
                        {err && <div className="text-xs text-destructive">{err}</div>}
                        {note && <div className="text-xs text-amber-800 dark:text-amber-400">{note}</div>}
                      </TableCell>
                      <TableCell>{variantOf(r) || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{p?.sku ?? r.sku ?? "—"}</TableCell>
                      <TableCell className="text-right"><Num>{measureCell(r.qty, asked && cells[i]?.qty)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{amountCell(r.unitCost, cells[i]?.unitCost, 6)}</Num></TableCell>
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
                blocked={errors > 0 ? t("Fix the errors in the file and load it again", "Corrigez les erreurs dans le fichier et chargez-le à nouveau") : ownerOnly ? t("Opening stock: only the owner can import it", "Stock d'ouverture\u00a0: seul le propriétaire peut l'importer") : !locationId ? t("Choose the location", "Choisissez l'emplacement") : !day && t("Choose the opening stock date", "Choisissez la date du stock d'ouverture")}
                pending={run.isPending}
                onClick={() => run.mutate({ date: day, locationId, updatePrices, rows: rows.map(toWire) })}
              >
                <Upload className="mr-1 h-4 w-4" /> {t("Import", "Importer")} ({rows.length - errors})
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
  const [cells, setCells] = useState<Cells[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);

  function template() {
    downloadXlsx(t("prices-template.xlsx", "modele-prix.xlsx"), [
      [t("SKU", "Code"), t("Barcode", "Code-barres"), t("Sell price", "Prix de vente")],
      ["HH150-RED", "", 1350],
      ["", "6901234567890", 25],
    ], t("Prices", "Prix"));
  }

  async function load(file: File) {
    setFileError(null);
    setUpdated(null);
    setRows([]);
    try {
      const { rows: raw, found, cells: rawCells } = await readSheet(file, PRICE_FIELDS);
      if (!found.includes("sellPrice") || (!found.includes("sku") && !found.includes("barcode"))) {
        setFileError(t("The file needs a SKU or barcode column and a price column.", "Le fichier doit avoir une colonne Code (SKU) ou code-barres et une colonne de prix."));
        return;
      }
      setRows(raw.map((r) => ({ ...r, sellPrice: numCell(r.sellPrice) })));
      setCells(rawCells);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }

  const problem = (r: PriceRow, i: number) => {
    if (!r.sku && !r.barcode) return t("SKU or barcode missing", "Code ou code-barres manquant");
    const unsure = amountQuestion(t, cells[i], [SELL_PRICE]);
    if (unsure) return unsure;
    if (!r.sellPrice || !/^\d+(\.\d+)?$/.test(r.sellPrice)) return t("Price is not a valid number", "Le prix n'est pas un nombre valide");
    return null;
  };
  const errors = rows.filter((r, i) => problem(r, i)).length;

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
          <CardDescription>{t("Items are found by SKU or barcode. Nothing else changes.", "Les articles sont trouvés par leur code ou code-barres. Rien d'autre ne change.")}</CardDescription>
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
            <p className="text-sm text-muted-foreground">{count(t, rows.length - errors, ["price to update", "prices to update"], ["prix à mettre à jour", "prix à mettre à jour"])}{errors > 0 && <span className="text-destructive"> · {count(t, errors, ["error", "errors"], ["erreur", "erreurs"])}</span>}</p>
            <div className="max-h-[420px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>{t("SKU", "Code")}</TableHead>
                    <TableHead>{t("Barcode", "Code-barres")}</TableHead>
                    <TableHead className="text-right">{t("New price", "Nouveau prix")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => {
                    const err = problem(r, i);
                    return (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground"><Num>{i + 2}</Num></TableCell>
                        <TableCell className="font-mono text-xs">{r.sku ?? "—"}{err && <div className="font-sans text-destructive">{err}</div>}</TableCell>
                        <TableCell className="font-mono text-xs">{r.barcode ?? "—"}</TableCell>
                        <TableCell className="text-right"><Num>{amountCellUnsure(cells[i]?.sellPrice) ? String(cells[i]?.sellPrice).trim() : r.sellPrice && !err ? usd(r.sellPrice) : r.sellPrice ?? "—"}</Num></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setRows([])}>{t("Cancel", "Annuler")}</Button>
              <SubmitButton blocked={errors > 0 && t("Fix the errors in the file and load it again", "Corrigez les erreurs dans le fichier et chargez-le à nouveau")} pending={run.isPending} onClick={() => run.mutate({ rows: rows.map(toWire) })}>
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
            "Mêmes colonnes que le modèle d'import\u00a0: modifiez les prix ou les détails dans Excel, puis rechargez le fichier. Laissez la quantité vide pour réimporter, sinon elle est ajoutée comme stock d'ouverture.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorText error={stockQ.error} />
        {stockQ.isLoading ? <Loading /> : <p className="text-sm text-muted-foreground">{count(t, items.length, ["variant", "variants"], ["variante", "variantes"])}</p>}
        <div className="flex flex-wrap gap-2">
          {/* The long labels wrap on a phone rather than push the card wider than the screen. */}
          <Button className="max-w-full whitespace-normal" onClick={() => exportXlsx(false)} disabled={!items.length}><Download className="mr-1 h-4 w-4" /> {t("Export for re-import (no quantities)", "Exporter pour réimport (sans quantités)")}</Button>
          <Button variant="outline" className="max-w-full whitespace-normal" onClick={() => exportXlsx(true)} disabled={!items.length}><Download className="mr-1 h-4 w-4" /> {t("Export with stock and cost", "Exporter avec stock et coût")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Container packing list (used by ContainerDetail)

type ContainerRowIn = Record<keyof typeof CONTAINER_FIELDS, string | null>;

export function ContainerImportButton({ containerId, currency, linesDirty, onContainer = [], onImported }: { containerId: number; currency: string; linesDirty: boolean; onContainer?: number[]; onImported: () => void }) {
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
          onContainer={onContainer}
          onClose={() => setOpen(false)}
          onImported={() => { setOpen(false); onImported(); }}
        />
      )}
    </>
  );
}

function ContainerImportDialog({ containerId, currency, linesDirty, onContainer, onClose, onImported }: { containerId: number; currency: string; linesDirty: boolean; onContainer: number[]; onClose: () => void; onImported: () => void }) {
  const t = useT();
  const { lang } = useI18n();
  const [fileRows, setRows] = useState<ContainerRowIn[]>([]);
  const [cells, setCells] = useState<Cells[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"append" | "replace">("append");

  function template() {
    const yes = t("yes", "oui");
    const no = t("no", "non");
    downloadXlsx(t("packing-list-template.xlsx", "modele-colisage.xlsx"), [
      [
        t("Category", "Catégorie"), t("Item", "Article"), t("Size", "Taille"), t("Colour", "Couleur"), t("SKU", "Code"), t("Motorcycle (yes/no)", "Moto (oui/non)"),
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
      const { rows: raw, found, cells: rawCells } = await readSheet(file, CONTAINER_FIELDS);
      if (!found.includes("name")) {
        setFileError(t("No item name column found. Name a column \"Article\" (or \"Item\").", "Aucune colonne de nom d'article trouvée. Nommez une colonne «\u00a0Article\u00a0» (ou «\u00a0Item\u00a0»)."));
        return;
      }
      if (!found.includes("quantity") || !found.includes("unitPrice")) {
        setFileError(t("The file needs a Quantity and a Unit price column.", "Le fichier doit avoir une colonne Quantité et une colonne Prix unitaire."));
        return;
      }
      const clean = raw.map((r) => ({ ...r, quantity: numCell(r.quantity), unitPrice: numCell(r.unitPrice), weightKg: numCell(r.weightKg), volumeCbm: numCell(r.volumeCbm), sellPrice: numCell(r.sellPrice) }));
      setRows(clean);
      setCells(rawCells);
      setBusy(true);
      setPreview(await api<PreviewRow[]>("POST", "/api/import/items/preview", { rows: clean.map(({ quantity: _q, unitPrice: _p, weightKg: _w, volumeCbm: _v, ...r }) => toWire(r)) }));
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
  // Weights and volumes always, and quantities in litres or kilos: "12,375" kg is 12,375 kg, as typed by hand.
  const { rows, unsure } = useMemo(
    () => remeasure(t, fileRows, cells, preview, "quantity", [{ key: "weightKg", en: "Weight", fr: "Poids" }, { key: "volumeCbm", en: "Volume", fr: "Volume" }]),
    [t, fileRows, cells, preview],
  );
  const merged = rows.map((r, i) => {
    const p = preview[i];
    const err = rowError(p?.status === "error" ? p : undefined, lang) ?? unsure[i] ?? amountQuestion(t, cells[i], [{ key: "unitPrice", en: "Unit price", fr: "Prix unitaire", currency: currency.toUpperCase() }, SELL_PRICE]) ?? localError(r);
    return { r, p, err, unsure: unsure[i], status: (err ? "error" : p?.status ?? "existing") as PreviewRow["status"] };
  });
  const errors = merged.filter((m) => m.err).length;
  // "Ajouter aux lignes" never merges: an item already on the container gets a second line, said before importing.
  const already = new Set(onContainer);
  const twice = mode === "append" ? merged.filter((m) => !m.err && m.p?.variantId && already.has(m.p.variantId)) : [];
  const twiceSkus = Array.from(new Set(twice.map((m) => m.p?.sku ?? m.r.name ?? "")));
  // Rows with an error are not imported, so they are not in the total either.
  const total = merged.filter((m) => !m.err).reduce((s, { r }) => s.plus(d(r.quantity).times(d(r.unitPrice))), d(0));

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
              `One row per item and size. Unit prices are in the invoice currency (${curLabel(currency)}); weight and volume are totals for the line. Missing items are created.`,
              `Une ligne par article et taille. Les prix unitaires sont dans la devise de la facture (${curLabel(currency)})\u00a0; le poids et le volume sont des totaux pour la ligne. Les articles manquants sont créés.`,
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
                      <TableHead className="text-right">{t(`Price (${curLabel(currency)})`, `Prix (${curLabel(currency)})`)}</TableHead>
                      <TableHead className="text-right">{t("Weight (kg)", "Poids (kg)")}</TableHead>
                      <TableHead className="text-right">{t("Volume (m³)", "Volume (m³)")}</TableHead>
                      <TableHead>{t("Status", "Statut")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {merged.map(({ r, p, err, unsure: asked, status }, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground"><Num>{p?.row ?? i + 2}</Num></TableCell>
                        <TableCell className="min-w-[150px]">
                          <div className="font-medium">{r.name}{variantOf(r) && <span className="font-normal text-muted-foreground"> · {variantOf(r)}</span>}</div>
                          <div className="font-mono text-xs text-muted-foreground">{p?.sku ?? r.sku ?? ""}</div>
                          {err && <div className="text-xs text-destructive">{err}</div>}
                        </TableCell>
                        <TableCell className="text-right"><Num>{measureCell(r.quantity, asked && cells[i]?.quantity)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{amountCell(r.unitPrice, cells[i]?.unitPrice, 4)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{measureCell(r.weightKg, asked && cells[i]?.weightKg)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{measureCell(r.volumeCbm, asked && cells[i]?.volumeCbm)}</Num></TableCell>
                        <TableCell>
                          <StatusBadge status={status} />
                          {twice.some((x) => x.p === p) && <div className="text-xs text-amber-800 dark:text-amber-400">{t("already on the container", "déjà sur le conteneur")}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-sm text-muted-foreground">{t("Purchase value:", "Valeur d'achat\u00a0:")} <span className="font-medium text-foreground tabular">{money(total.toFixed(2), currency)}</span></p>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="import-mode" checked={mode === "append"} onChange={() => setMode("append")} /> {t("Add to the lines", "Ajouter aux lignes")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> {t("Replace the lines", "Remplacer les lignes")}
                </label>
              </div>
              {twiceSkus.length > 0 && (
                <p className="text-sm text-amber-800 dark:text-amber-400" data-testid="import-twice">
                  {twiceSkus.length === 1
                    ? t(`${twiceSkus[0]} is already on the container: a second line will be added. Choose "Replace the lines" to start from the file.`, `${twiceSkus[0]} est déjà sur le conteneur\u00a0: une ligne sera ajoutée en plus. Choisissez «\u00a0Remplacer les lignes\u00a0» pour repartir du fichier.`)
                    : t(`${twiceSkus.join(", ")} are already on the container: a second line will be added for each. Choose "Replace the lines" to start from the file.`, `${twiceSkus.join(", ")} sont déjà sur le conteneur\u00a0: une ligne sera ajoutée en plus pour chacun. Choisissez «\u00a0Remplacer les lignes\u00a0» pour repartir du fichier.`)}
                </p>
              )}
            </>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            blocked={!busy && (!rows.length ? t("Load a file with at least one row", "Chargez un fichier avec au moins une ligne") : errors > 0 && t("Fix the errors in the file and load it again", "Corrigez les erreurs dans le fichier et chargez-le à nouveau"))}
            pending={busy || run.isPending}
            onClick={() => run.mutate({ mode, rows: rows.map(toWire) })}
          >
            <Upload className="mr-1 h-4 w-4" /> {mode === "replace" ? t("Replace the lines", "Remplacer les lignes") : t("Add to the lines", "Ajouter aux lignes")} ({rows.length - errors})
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
