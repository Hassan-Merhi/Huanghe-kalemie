import { useEffect, useMemo, useState, type ReactNode } from "react";
import { de } from "@shared/french";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, Bike, Info, Lock, PackageCheck, Pencil, Plus, Save, Trash2, Undo2, X } from "lucide-react";
import { EmptyState, ErrorText, Field, francDecimalsError, Loading, Num, PageHeader, StatCard, SubmitButton, unclearAmount } from "@/components/common";
import { ContainerRateField, MoneyAccountSelect, PartySelect, perUsdText, useAccounts, useRate, VariantSearch } from "@/components/pickers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { curLabel, d, date, money, pct, qty, todayLocal, typedNumberOk, unitCost, usd, variantText, unclearQty } from "@/lib/format";
import { qtyWithUnit, unitKey, unitLabel, wholeUnit } from "@/lib/units";
import { useT, count } from "@/lib/i18n";
import type { Account, Party, VariantRow } from "@/lib/types";
import { ContainerStatusBadge, useStatusLabel, type ContainerRow, type ContainerStatus } from "./Containers";
import { ContainerImportButton } from "./StockImport";

// ---------------------------------------------------------------- Types

interface ContainerLine {
  id: number;
  variantId: number;
  quantity: string;
  unitPrice: string;
  weightKg: string | null;
  volumeCbm: string | null;
  fobUsd: string | null;
  allocatedUsd: string | null;
  landedTotalUsd: string | null;
  landedUnitCost: string | null;
  sku: string;
  attributes: Record<string, string>;
  productName: string;
  tracksSerials: boolean;
  unit?: string;
}

type Method = "value" | "quantity" | "weight" | "volume" | "line";
const METHODS: Method[] = ["value", "quantity", "weight", "volume", "line"];
const EXPENSE_TYPES = ["freight", "duties", "clearing", "transport", "handling", "offload_labour", "insurance", "other"] as const;
type ExpenseType = (typeof EXPENSE_TYPES)[number];

interface ContainerExpense {
  id: number;
  date: string;
  type: string;
  description: string | null;
  amountNative: string;
  currency: "USD" | "CDF";
  rate: string | null;
  amountUsd: string;
  method: Method;
  targetLineId: number | null;
  paidFromAccountId: number | null;
  payablePartyId: number | null;
}

interface PreviewLine {
  key: number;
  quantity: string;
  fobUsd: string;
  allocatedUsd: string;
  landedTotalUsd: string;
  landedUnitCost: string;
  byExpense: Record<string, string>;
}

interface ContainerFull extends ContainerRow {
  lines: ContainerLine[];
  expenses: ContainerExpense[];
  preview: { lines: PreviewLine[]; fobTotalUsd: string; expensesTotalUsd: string; landedTotalUsd: string } | null;
  previewError: string | null;
}

interface DraftLine {
  key: string;
  variantId: number;
  productName: string;
  attributes: Record<string, string>;
  sku: string;
  tracksSerials: boolean;
  unit?: string;
  quantity: string;
  unitPrice: string;
  weightKg: string;
  volumeCbm: string;
}

// ---------------------------------------------------------------- Helpers

function fmtCur(value: unknown, currency: string) {
  return money(value, currency);
}

function itemLabel(l: { productName: string; attributes: Record<string, string> }) {
  // "1 L", "17 mm": a number and its unit stay on one line.
  const v = variantText(l.attributes).replace(/(\d) (?=\S)/g, "$1\u00a0");
  return v ? `${l.productName} · ${v}` : l.productName;
}

function useLabels() {
  const t = useT();
  const type = (x: string) =>
    ({
      freight: t("Freight", "Fret"),
      duties: t("Customs duties", "Droits de douane"),
      clearing: t("Clearing agent", "Dédouanement"),
      transport: t("Transport to Kalemie", "Transport jusqu'à Kalemie"),
      handling: t("Handling", "Manutention"),
      offload_labour: t("Offloading labour", "Main-d'œuvre de déchargement"),
      insurance: t("Insurance", "Assurance"),
      other: t("Other", "Autre"),
    })[x] ?? x;
  const method = (m: string) =>
    ({
      value: t("By purchase value", "Par valeur d'achat"),
      quantity: t("By quantity", "Par quantité"),
      weight: t("By weight", "Par poids"),
      volume: t("By volume", "Par volume"),
      line: t("All to one line", "Tout sur une ligne"),
    })[m] ?? m;
  return { type, method };
}

function marginPct(sell: string | undefined, cost: string | null | undefined) {
  const s = d(sell);
  if (!sell || s.lte(0) || cost == null) return null;
  return s.minus(d(cost)).dividedBy(s).times(100);
}

/** A margin above this is more likely an invoice price typed a thousand times too small ("6.500" ¥ read as 6,50). */
const SUSPECT_MARGIN = 90;

/** Lines whose landed cost is under a tenth of the selling price. */
function cheapLines(c: ContainerFull, priceOf: Map<number, string>, costs: { key: number | string; landedUnitCost: string | null }[]) {
  return c.lines.flatMap((l) => {
    const r = costs.find((x) => Number(x.key) === l.id);
    const price = priceOf.get(l.variantId);
    const m = r ? marginPct(price, r.landedUnitCost) : null;
    return m && m.gt(SUSPECT_MARGIN) ? [{ l, cost: r!.landedUnitCost, price: price! }] : [];
  });
}

function MarginCell({ sell, cost }: { sell: string | undefined; cost: string | null | undefined }) {
  const m = marginPct(sell, cost);
  if (!m) return <span className="text-muted-foreground">—</span>;
  const cls = m.isNegative() ? "text-destructive font-medium" : m.lt(10) || m.gt(SUSPECT_MARGIN) ? "text-amber-800 dark:text-amber-400 font-medium" : "text-green-800 dark:text-green-400";
  return <Num className={cls}>{pct(m.toNumber(), 1, 1)}</Num>;
}

// ---------------------------------------------------------------- Page

export default function ContainerDetail() {
  const t = useT();
  const { can } = useAuth();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const q = useQuery<ContainerFull>({ queryKey: [`/api/containers/${id}`] });
  const c = q.data;

  const variantIds = useMemo(() => Array.from(new Set((c?.lines ?? []).map((l) => l.variantId))).sort((a, b) => a - b), [c?.lines]);
  const pricesQ = useQuery<VariantRow[]>({
    queryKey: ["/api/variants", { ids: variantIds.join(","), limit: 500 }],
    enabled: variantIds.length > 0,
  });
  const priceOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const v of pricesQ.data ?? []) m.set(v.id, v.sellPrice);
    return m;
  }, [pricesQ.data]);

  const [linesDirty, setLinesDirty] = useState(false);
  const [linesKey, setLinesKey] = useState(0);

  if (q.isLoading) return <Loading />;
  if (q.error || !c) return <ErrorText error={q.error ?? t("Container not found", "Conteneur introuvable")} />;

  const finalized = c.status === "finalized";
  const editable = can("manager") && !finalized;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/containers" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> {t("Containers", "Conteneurs")}
        </Link>
      </div>
      <PageHeader
        title={`${t("Container", "Conteneur")} ${c.number}`}
        description={c.supplierName ? t(`Supplier: ${c.supplierName}`, `Fournisseur\u00a0: ${c.supplierName}`) : undefined}
        actions={
          <>
            {editable && <OffloadButton c={c} priceOf={priceOf} disabledReason={linesDirty ? t("Save the lines first", "Enregistrez d'abord les lignes") : null} />}
            {finalized && can() && <ReverseButton c={c} />}
          </>
        }
      />

      <HeaderCard c={c} />

      {finalized ? (
        <FinalCosts c={c} priceOf={priceOf} />
      ) : (
        <>
          {editable && (
            <div className="flex justify-end">
              <ContainerImportButton
                containerId={c.id}
                currency={c.currency}
                linesDirty={linesDirty}
                onContainer={c.lines.map((l) => l.variantId)}
                onImported={() => { setLinesDirty(false); setLinesKey((k) => k + 1); }}
              />
            </div>
          )}
          <LinesEditor key={linesKey} c={c} editable={editable} onDirtyChange={setLinesDirty} />
          <ExpensesSection c={c} editable={editable} />
          <PreviewSection c={c} priceOf={priceOf} />
        </>
      )}
      {finalized && <ExpensesSection c={c} editable={false} />}
    </div>
  );
}

// ---------------------------------------------------------------- Header

function HeaderCard({ c }: { c: ContainerFull }) {
  const t = useT();
  const { can } = useAuth();
  const statusLabel = useStatusLabel();
  const [editing, setEditing] = useState(false);
  const finalized = c.status === "finalized";
  const patch = useApiMutation<{ status: ContainerStatus }>("PATCH", `/api/containers/${c.id}`, { success: t("Status updated", "Statut mis à jour") });

  return (
    <Card>
      <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">{t("Status", "Statut")}</p>
          {can("manager") && !finalized ? (
            <Select value={c.status} onValueChange={(v) => patch.mutate({ status: v as ContainerStatus })}>
              <SelectTrigger className="mt-1 h-9 w-full sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["draft", "in_transit", "arrived"] as const).map((s) => (
                  <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="mt-1"><ContainerStatusBadge status={c.status} /></div>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("Invoice currency", "Devise de la facture")}</p>
          <p className="mt-1 font-medium">
            {c.currency === "CDF" ? "FC" : c.currency}
            {c.currency !== "USD" && <span className="ml-2 text-sm font-normal text-muted-foreground">1 $ = {qty(perUsdText(c.rateToUsd))} {c.currency === "CDF" ? "FC" : c.currency}</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("Dates", "Dates")}</p>
          <p className="mt-1 text-sm">
            {t("Shipped: ", "Expédié\u00a0: ")}{c.shipDate ? date(c.shipDate) : "—"}
            <br />
            {t("Arrival: ", "Arrivée\u00a0: ")}{c.arrivalDate ? date(c.arrivalDate) : "—"}
            {c.offloadDate && (
              <>
                <br />
                {t("Offloaded: ", "Déchargé\u00a0: ")}{date(c.offloadDate)}
              </>
            )}
          </p>
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t("Notes", "Notes")}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{c.notes || <span className="text-muted-foreground">—</span>}</p>
          </div>
          {can("manager") && (
            <Button variant="ghost" size="icon" onClick={() => setEditing(true)} title={t("Edit details", "Modifier les détails")}>
              <Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
      {editing && <EditDetailsDialog c={c} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function EditDetailsDialog({ c, onClose }: { c: ContainerFull; onClose: () => void }) {
  const t = useT();
  const finalized = c.status === "finalized";
  const [shipDate, setShipDate] = useState(c.shipDate ?? "");
  const [arrivalDate, setArrivalDate] = useState(c.arrivalDate ?? "");
  const [notes, setNotes] = useState(c.notes ?? "");
  const [currency, setCurrency] = useState(c.currency);
  const [rate, setRate] = useState(d(c.rateToUsd).toString());
  const patch = useApiMutation<Record<string, unknown>>("PATCH", `/api/containers/${c.id}`, { success: t("Saved", "Enregistré"), onSuccess: onClose });
  const cur = currency.trim().toUpperCase();
  const rateOk = cur === "USD" || d(rate).gt(0);
  function save() {
    const body: Record<string, unknown> = { shipDate: shipDate || null, arrivalDate: arrivalDate || null, notes: notes.trim() || null };
    if (!finalized) {
      body.currency = cur;
      body.rateToUsd = cur === "USD" ? "1" : d(rate).toString();
    }
    patch.mutate(body);
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Container details", "Détails du conteneur")}</DialogTitle>
          {finalized && <DialogDescription>{t("This container is offloaded: only dates and notes can change.", "Ce conteneur est déchargé\u00a0: seules les dates et les notes peuvent changer.")}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {!finalized && (
            <>
              <Field label={t("Invoice currency", "Devise de la facture")} required>
                <Select value={currency} onValueChange={(v) => { setCurrency(v); setRate(v === c.currency ? d(c.rateToUsd).toString() : ""); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">{t("Dollar ($)", "Dollar ($)")}</SelectItem>
                    <SelectItem value="CNY">{t("Yuan (CNY)", "Yuan (CNY)")}</SelectItem>
                    <SelectItem value="CDF">{t("Congolese franc (FC)", "Franc congolais (FC)")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {cur !== "USD" ? <ContainerRateField key={cur} currency={cur} value={rate} onChange={setRate} /> : <div className="hidden sm:block" />}
            </>
          )}
          <Field label={t("Ship date", "Date d'expédition")}>
            <Input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          </Field>
          <Field label={t("Arrival date", "Date d'arrivée")}>
            <Input type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} />
          </Field>
          <Field label={t("Notes", "Notes")} className="sm:col-span-2">
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            onClick={save}
            blocked={cur.length !== 3 ? t("Enter a 3-letter currency code", "Saisissez un code de devise à 3 lettres") : !rateOk ? t("Enter the rate (how much one dollar buys)", "Saisissez le taux (combien vaut 1 $)") : null}
            pending={patch.isPending}
          >
            {t("Save", "Enregistrer")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Lines editor

function toDraft(lines: ContainerLine[]): DraftLine[] {
  return lines.map((l) => ({
    key: `s${l.id}`,
    variantId: l.variantId,
    productName: l.productName,
    attributes: l.attributes,
    sku: l.sku,
    tracksSerials: l.tracksSerials,
    unit: l.unit,
    quantity: d(l.quantity).toString(),
    unitPrice: d(l.unitPrice).toString(),
    weightKg: l.weightKg ? d(l.weightKg).toString() : "",
    volumeCbm: l.volumeCbm ? d(l.volumeCbm).toString() : "",
  }));
}

let draftSeq = 0;
/** A line whose price is simply not typed yet (not an error to show in red). */
const PENDING = "pending";

function LinesEditor({ c, editable, onDirtyChange }: { c: ContainerFull; editable: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<DraftLine[]>(() => toDraft(c.lines));
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (v: boolean) => {
    setDirtyState(v);
    onDirtyChange(v);
  };

  // Follow the server while there is nothing unsaved.
  useEffect(() => {
    if (!dirty) setDraft(toDraft(c.lines));
  }, [c.lines, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const save = useApiMutation<{ lines: unknown[] }>("PUT", `/api/containers/${c.id}/lines`, {
    success: t("Lines saved", "Lignes enregistrées"),
    onSuccess: () => setDirty(false),
  });

  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const touch = (key: string) => setTouched((s) => (s.has(key) ? s : new Set(s).add(key)));
  function update(key: string, patch: Partial<DraftLine>) {
    setDraft((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function remove(key: string) {
    setDraft((rows) => rows.filter((r) => r.key !== key));
    setDirty(true);
  }
  function add(v: VariantRow) {
    setDraft((rows) => {
      const existing = rows.find((r) => r.variantId === v.id);
      if (existing) return rows.map((r) => (r === existing ? { ...r, quantity: d(r.quantity).plus(1).toString() } : r));
      return [
        ...rows,
        {
          key: `n${++draftSeq}`,
          variantId: v.id,
          productName: v.productName,
          attributes: v.attributes,
          sku: v.sku,
          tracksSerials: v.tracksSerials,
          unit: v.unit,
          quantity: "1",
          unitPrice: "",
          weightKg: "",
          volumeCbm: "",
        },
      ];
    });
    setDirty(true);
  }
  function discard() {
    setDraft(toDraft(c.lines));
    setDirty(false);
  }

  const rate = d(c.rateToUsd);
  const problems = draft.map((r) => {
    const q = d(r.quantity);
    // "1.000" pieces is asked about by its field (1 000 or 1?), never read as 1.
    if (!typedNumberOk(r.quantity)) return unclearQty(t, r.quantity) ?? t("Correct the quantity", "Corrigez la quantité");
    if (!r.quantity.trim() || q.lte(0)) return t("Quantity must be above zero", "La quantité doit être supérieure à zéro");
    if (r.tracksSerials && !q.isInteger()) return t("Motorcycles must be whole units", "Les motos se comptent en unités entières");
    if (!q.isInteger() && wholeUnit(r.unit)) return t(`Counted by the ${unitLabel(t, r.unit, 1)}: enter a whole number`, `Se compte à l'unité (${unitLabel(t, r.unit, 1)})\u00a0: saisissez un nombre entier`);
    // A line just added has no price yet: only say so once the field was left or saving was tried.
    if (!r.unitPrice.trim()) return touched.has(r.key) ? t("Enter the unit price", "Entrez le prix unitaire") : PENDING;
    if (!typedNumberOk(r.unitPrice)) return unclearAmount(t, r.unitPrice, c.currency) ?? t("Correct the unit price", "Corrigez le prix unitaire");
    if (d(r.unitPrice).isNegative()) return t("Price cannot be negative", "Le prix ne peut pas être négatif");
    return null;
  });
  const shown = problems.map((p) => (p === PENDING ? null : p));
  const totalNative = draft.reduce((s, r) => s.plus(d(r.quantity).times(d(r.unitPrice))), d(0));
  // In dollars, the sum of each line's value rounded to the cent, as the server works the landed cost and the
  // offload (11 118,05 $), not the total converted at once (11 118,06 $). Half up, like the server.
  const totalUsd = draft.reduce((s, r) => s.plus(d(r.quantity).times(d(r.unitPrice)).times(rate).toDecimalPlaces(2)), d(0));
  // Ten motorcycles and two hundred tyres make no total: quantities add up only within one product.
  const oneProduct = draft.length > 0 && draft.every((r) => r.productName === draft[0].productName && unitKey(r.unit) === unitKey(draft[0].unit));
  const totalQty = oneProduct ? qtyWithUnit(t, draft.reduce((s, r) => s.plus(d(r.quantity)), d(0)).toString(), draft[0].unit) : null;

  function submit() {
    save.mutate({
      lines: draft.map((r) => ({
        variantId: r.variantId,
        quantity: d(r.quantity).toString(),
        unitPrice: d(r.unitPrice).toString(),
        weightKg: r.weightKg.trim() ? d(r.weightKg).toString() : null,
        volumeCbm: r.volumeCbm.trim() ? d(r.volumeCbm).toString() : null,
      })),
    });
  }

  const foreign = c.currency !== "USD";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("Items in the container", "Articles du conteneur")}</CardTitle>
        <CardDescription>
          {t(
            `Unit prices are in the supplier invoice currency (${curLabel(c.currency)}). Weight and volume are totals for the whole line (all units together), only needed if you split a cost by weight or volume.`,
            `Les prix unitaires sont dans la devise de la facture fournisseur (${curLabel(c.currency)}). Le poids et le volume sont des totaux pour toute la ligne (toutes les unités ensemble) et ne servent que si vous répartissez un frais par poids ou par volume.`,
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {editable && <VariantSearch onPick={add} placeholder={t("Scan or search an item", "Scanner ou chercher")} />}
        {dirty && (
          <Alert className="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("Unsaved changes", "Modifications non enregistrées")}</AlertTitle>
            <AlertDescription>
              {t(
                "Save the lines to update the landed cost preview. Expenses charged to one line may need their line picked again after saving.",
                "Enregistrez les lignes pour mettre à jour l'aperçu du coût de revient. Les frais affectés à une seule ligne devront peut-être être réaffectés après l'enregistrement.",
              )}
            </AlertDescription>
          </Alert>
        )}
        {draft.length === 0 ? (
          <EmptyState title={t("No items yet", "Aucun article pour l'instant")}>
            {editable ? t("Search above to add the items on the supplier invoice.", "Cherchez ci-dessus pour ajouter les articles de la facture fournisseur.") : null}
          </EmptyState>
        ) : (
          <>
          {/* Phone: one stacked card per line so every field can be edited. */}
          <div className="space-y-2 md:hidden">
            {draft.map((r, i) => {
              const value = d(r.quantity).times(d(r.unitPrice));
              return (
                <div key={r.key} className="rounded-md border p-3" role="group" aria-label={itemLabel(r)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{itemLabel(r)}</div>
                      <div className="text-xs text-muted-foreground">{r.sku}{r.tracksSerials ? ` · ${t("motorcycle", "moto")}` : ""}</div>
                    </div>
                    {editable && (
                      <Button variant="ghost" size="icon" className="-mr-2 -mt-1 shrink-0" onClick={() => remove(r.key)} aria-label={t("Remove", "Retirer")}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {editable && shown[i] && <div className="mt-1 text-xs text-destructive">{shown[i]}</div>}
                  {editable ? (
                    <div className="mt-2 grid grid-cols-2 items-end gap-2">
                      <Field label={t("Quantity", "Quantité")}>
                        <Input className="text-right" inputMode={wholeUnit(r.unit) ? "numeric" : "decimal"} whole={wholeUnit(r.unit)} measured={!wholeUnit(r.unit)} noAlert aria-label={t(`Quantity of ${itemLabel(r)}`, `Quantité ${de(itemLabel(r))}`)} value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} />
                      </Field>
                      <Field label={t(`Price each (${curLabel(c.currency)})`, `Prix/unité (${curLabel(c.currency)})`)}>
                        {/* The question about "1.200" is said above the card's fields (as for the quantity): a box under the price would cover the volume. */}
                        <Input className="text-right" inputMode="decimal" currency={c.currency} noAlert aria-label={t(`Price each of ${itemLabel(r)}`, `Prix unitaire ${de(itemLabel(r))}`)} value={r.unitPrice} placeholder="0" onBlur={() => touch(r.key)} onChange={(e) => update(r.key, { unitPrice: e.target.value })} />
                      </Field>
                      <Field label={t("Total weight (kg)", "Poids total (kg)")}>
                        <Input className="text-right" inputMode="decimal" placeholder={t("total kg", "kg total")} aria-label={t(`Total weight of ${itemLabel(r)} (kg)`, `Poids total ${de(itemLabel(r))} (kg)`)} value={r.weightKg} onChange={(e) => update(r.key, { weightKg: e.target.value })} />
                      </Field>
                      <Field label={t("Total volume (m³)", "Volume total (m³)")}>
                        <Input className="text-right" inputMode="decimal" placeholder={t("total m³", "m³ total")} aria-label={t(`Total volume of ${itemLabel(r)} (m³)`, `Volume total ${de(itemLabel(r))} (m³)`)} value={r.volumeCbm} onChange={(e) => update(r.key, { volumeCbm: e.target.value })} />
                      </Field>
                    </div>
                  ) : (
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">{t("Quantity", "Quantité")}</dt><dd className="text-right"><Num>{qty(r.quantity)}</Num></dd>
                      <dt className="text-muted-foreground">{t("Unit price", "Prix unitaire")}</dt><dd className="text-right"><Num>{fmtCur(r.unitPrice, c.currency)}</Num></dd>
                      <dt className="text-muted-foreground">{t("Total weight (kg)", "Poids total (kg)")}</dt><dd className="text-right"><Num>{r.weightKg ? qty(r.weightKg) : "—"}</Num></dd>
                      <dt className="text-muted-foreground">{t("Total volume (m³)", "Volume total (m³)")}</dt><dd className="text-right"><Num>{r.volumeCbm ? qty(r.volumeCbm) : "—"}</Num></dd>
                    </dl>
                  )}
                  <div className="mt-2 flex items-baseline justify-between border-t pt-2 text-sm">
                    <span className="text-muted-foreground">{t("Purchase value", "Valeur d'achat")}</span>
                    <span className="text-right">
                      <Num className="font-medium">{fmtCur(value.toFixed(2), c.currency)}</Num>
                      {foreign && <span className="block text-xs text-muted-foreground"><Num>{usd(value.times(rate).toFixed(2))}</Num></span>}
                    </span>
                  </div>
                </div>
              );
            })}
            <div className="flex items-baseline justify-between rounded-md bg-muted/50 px-3 py-2 text-sm font-medium">
              <span>{t("Total", "Total")} ({count(t, draft.length, ["line", "lines"], ["ligne", "lignes"])}){totalQty ? ` · ${totalQty}` : ""}</span>
              <span className="text-right">
                <Num className="font-semibold">{fmtCur(totalNative.toFixed(2), c.currency)}</Num>
                {foreign && <span className="block text-xs font-normal text-muted-foreground"><Num>{usd(totalUsd.toFixed(2))}</Num></span>}
              </span>
            </div>
          </div>
          <div className="hidden overflow-x-auto rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Item", "Article")}</TableHead>
                  <TableHead className="text-right">{t("Quantity", "Quantité")}</TableHead>
                  <TableHead className="text-right">{t(`Unit price (${curLabel(c.currency)})`, `Prix unitaire (${curLabel(c.currency)})`)}</TableHead>
                  <TableHead className="text-right">{t("Total weight (kg)", "Poids total (kg)")}</TableHead>
                  <TableHead className="text-right">{t("Total volume (m³)", "Volume total (m³)")}</TableHead>
                  <TableHead className="text-right">{t("Purchase value", "Valeur d'achat")}</TableHead>
                  {editable && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.map((r, i) => {
                  const value = d(r.quantity).times(d(r.unitPrice));
                  return (
                    <TableRow key={r.key}>
                      <TableCell className="min-w-[180px]">
                        <div className="font-medium">{itemLabel(r)}</div>
                        <div className="text-xs text-muted-foreground">{r.sku}{r.tracksSerials ? ` · ${t("motorcycle", "moto")}` : ""}</div>
                        {editable && shown[i] && <div className="text-xs text-destructive">{shown[i]}</div>}
                      </TableCell>
                      {editable ? (
                        <>
                          <TableCell className="text-right">
                            <Input className="ml-auto w-20 text-right" inputMode={wholeUnit(r.unit) ? "numeric" : "decimal"} whole={wholeUnit(r.unit)} measured={!wholeUnit(r.unit)} noAlert aria-label={t(`Quantity of ${itemLabel(r)}`, `Quantité ${de(itemLabel(r))}`)} value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input className="ml-auto w-28 text-right" inputMode="decimal" currency={c.currency} inlineAlert aria-label={t(`Unit price of ${itemLabel(r)}`, `Prix unitaire ${de(itemLabel(r))}`)} value={r.unitPrice} placeholder="0" onBlur={() => touch(r.key)} onChange={(e) => update(r.key, { unitPrice: e.target.value })} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input className="ml-auto w-24 text-right" inputMode="decimal" aria-label={t("Total weight for the line (kg)", "Poids total de la ligne (kg)")} placeholder={t("total kg", "kg total")} value={r.weightKg} onChange={(e) => update(r.key, { weightKg: e.target.value })} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input className="ml-auto w-24 text-right" inputMode="decimal" aria-label={t("Total volume for the line (m³)", "Volume total de la ligne (m³)")} placeholder={t("total m³", "m³ total")} value={r.volumeCbm} onChange={(e) => update(r.key, { volumeCbm: e.target.value })} />
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="text-right"><Num>{qty(r.quantity)}</Num></TableCell>
                          <TableCell className="text-right"><Num>{fmtCur(r.unitPrice, c.currency)}</Num></TableCell>
                          <TableCell className="text-right"><Num>{r.weightKg ? qty(r.weightKg) : "—"}</Num></TableCell>
                          <TableCell className="text-right"><Num>{r.volumeCbm ? qty(r.volumeCbm) : "—"}</Num></TableCell>
                        </>
                      )}
                      <TableCell className="text-right">
                        <Num className="font-medium">{fmtCur(value.toFixed(2), c.currency)}</Num>
                        {foreign && <div className="text-xs text-muted-foreground"><Num>{usd(value.times(rate).toFixed(2))}</Num></div>}
                      </TableCell>
                      {editable && (
                        <TableCell>
                          <Button variant="ghost" size="icon" onClick={() => remove(r.key)} title={t("Remove", "Retirer")}>
                            <X className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">{t("Total", "Total")} ({count(t, draft.length, ["line", "lines"], ["ligne", "lignes"])})</TableCell>
                  <TableCell className="text-right"><Num>{totalQty ?? ""}</Num></TableCell>
                  <TableCell colSpan={3} />
                  <TableCell className="text-right">
                    <Num className="font-semibold">{fmtCur(totalNative.toFixed(2), c.currency)}</Num>
                    {foreign && <div className="text-xs text-muted-foreground"><Num>{usd(totalUsd.toFixed(2))}</Num></div>}
                  </TableCell>
                  {editable && <TableCell />}
                </TableRow>
              </TableFooter>
            </Table>
          </div>
          </>
        )}
        {editable && (dirty || draft.length > 0) && (
          <div className="flex flex-wrap justify-end gap-2">
            {dirty && (
              <Button variant="outline" onClick={discard}>
                {t("Discard changes", "Annuler les modifications")}
              </Button>
            )}
            <SubmitButton
              onClick={submit}
              blocked={!dirty ? t("No changes to save", "Aucune modification à enregistrer") : problems.some((p) => p && p !== PENDING) ? t("Fix the lines marked in red", "Corrigez les lignes signalées en rouge") : problems.includes(PENDING) ? t("Enter the unit price of every line", "Saisissez le prix unitaire de chaque ligne") : null}
              pending={save.isPending}
            >
              <Save className="mr-1 h-4 w-4" /> {t("Save lines", "Enregistrer les lignes")}
            </SubmitButton>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Expenses

function ExpensesSection({ c, editable }: { c: ContainerFull; editable: boolean }) {
  const t = useT();
  const L = useLabels();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ContainerExpense | null>(null);
  const accountsQ = useAccounts();
  const partiesQ = useQuery<Party[]>({ queryKey: ["/api/parties"] });
  const accountName = (id: number | null) => accountsQ.data?.find((a) => a.id === id)?.name ?? `#${id}`;
  const partyName = (id: number | null) => partiesQ.data?.find((p) => p.id === id)?.name ?? `#${id}`;
  const total = c.expenses.reduce((s, e) => s.plus(d(e.amountUsd)), d(0));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="text-lg">{t("Container costs", "Frais du conteneur")}</CardTitle>
          <CardDescription className="mt-1">
            {t(
              "Freight, duties, clearing, transport to Kalemie… These are added to the cost of the items when you offload, so both partners share them through the item cost. They are not shop running costs.",
              "Fret, douane, dédouanement, transport jusqu'à Kalemie… Ces frais s'ajoutent au coût des articles au déchargement\u00a0: les deux associés les partagent donc via le coût des articles. Ce ne sont pas des dépenses de fonctionnement.",
            )}
          </CardDescription>
        </div>
        {editable && (
          <Button onClick={() => setAdding(true)} className="shrink-0">
            <Plus className="mr-1 h-4 w-4" /> {t("Add expense", "Ajouter un frais")}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {c.expenses.length === 0 ? (
          <EmptyState title={t("No costs recorded yet", "Aucun frais enregistré")} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Date", "Date")}</TableHead>
                  <TableHead>{t("Type", "Type")}</TableHead>
                  <TableHead className="text-right">{t("Amount", "Montant")}</TableHead>
                  {/* Named in full: on a phone each heading labels its value on the card. */}
                  <TableHead className="text-right">{t("In $", "En $")}</TableHead>
                  <TableHead>{t("Split", "Répartition")}</TableHead>
                  <TableHead>{t("Payment", "Règlement")}</TableHead>
                  {editable && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.expenses.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{date(e.date)}</TableCell>
                    <TableCell className="min-w-[140px]">
                      <div className="font-medium">{L.type(e.type)}</div>
                      {e.description && <div className="text-xs text-muted-foreground">{e.description}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Num>{money(e.amountNative, e.currency)}</Num>
                      {e.currency === "CDF" && e.rate && <div className="text-xs text-muted-foreground">{t("rate", "taux")} {qty(e.rate)}</div>}
                    </TableCell>
                    <TableCell className="text-right"><Num className="font-medium">{usd(e.amountUsd)}</Num></TableCell>
                    <TableCell className="min-w-[190px]">
                      {editable ? <SplitEditor c={c} e={e} /> : <SplitText c={c} e={e} />}
                    </TableCell>
                    <TableCell className="min-w-[140px] text-sm">
                      {e.paidFromAccountId ? (
                        <>{t("Paid from", "Payé par")} {accountName(e.paidFromAccountId)}</>
                      ) : (
                        <span className="text-amber-800 dark:text-amber-400">{t("Owed to", "Dû à")} {partyName(e.payablePartyId)}</span>
                      )}
                    </TableCell>
                    {editable && (
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => setDeleting(e)} title={t("Delete", "Supprimer")} aria-label={t(`Delete ${L.type(e.type).toLowerCase()} ${money(e.amountNative, e.currency)}`, `Supprimer ${L.type(e.type).toLowerCase()} ${money(e.amountNative, e.currency)}`)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="font-medium">{t("Total container costs", "Total des frais du conteneur")}</TableCell>
                  <TableCell className="text-right"><Num className="font-semibold">{usd(total.toFixed(2))}</Num></TableCell>
                  <TableCell colSpan={editable ? 3 : 2} />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>
      {adding && <AddExpenseDialog c={c} onClose={() => setAdding(false)} />}
      {deleting && <DeleteExpenseDialog c={c} e={deleting} onClose={() => setDeleting(null)} />}
    </Card>
  );
}

function SplitText({ c, e }: { c: ContainerFull; e: ContainerExpense }) {
  const L = useLabels();
  const t = useT();
  const line = c.lines.find((l) => l.id === e.targetLineId);
  return (
    <span className="text-sm">
      {L.method(e.method)}
      {e.method === "line" && <span className="block text-xs text-muted-foreground">{line ? itemLabel(line) : t("no line picked", "aucune ligne choisie")}</span>}
    </span>
  );
}

function SplitEditor({ c, e }: { c: ContainerFull; e: ContainerExpense }) {
  const t = useT();
  const L = useLabels();
  const [pendingLine, setPendingLine] = useState(false);
  const patch = useApiMutation<{ method: Method; targetLineId: number | null }>("PATCH", `/api/containers/${c.id}/expenses/${e.id}`, {
    success: t("Split updated", "Répartition mise à jour"),
    onSuccess: () => setPendingLine(false),
  });
  const showLine = e.method === "line" || pendingLine;
  const missingLine = e.method === "line" && !c.lines.some((l) => l.id === e.targetLineId);
  return (
    <div className="space-y-1">
      <Select
        value={pendingLine ? "line" : e.method}
        onValueChange={(v) => {
          if (v === "line") {
            if (c.lines.length === 1) patch.mutate({ method: "line", targetLineId: c.lines[0].id });
            else setPendingLine(true);
          } else {
            setPendingLine(false);
            patch.mutate({ method: v as Method, targetLineId: null });
          }
        }}
      >
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {METHODS.map((m) => (
            <SelectItem key={m} value={m} disabled={m === "line" && c.lines.length === 0}>{L.method(m)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showLine && (
        <Select value={e.method === "line" && e.targetLineId ? String(e.targetLineId) : ""} onValueChange={(v) => patch.mutate({ method: "line", targetLineId: Number(v) })}>
          <SelectTrigger className={missingLine || pendingLine ? "h-8 border-destructive text-xs" : "h-8 text-xs"}>
            <SelectValue placeholder={t("Pick the line", "Choisir la ligne")} />
          </SelectTrigger>
          <SelectContent>
            {c.lines.map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>{itemLabel(l)} ({qty(l.quantity)})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function DeleteExpenseDialog({ c, e, onClose }: { c: ContainerFull; e: ContainerExpense; onClose: () => void }) {
  const t = useT();
  const L = useLabels();
  const del = useApiMutation<void>("DELETE", `/api/containers/${c.id}/expenses/${e.id}?date=${todayLocal()}`, {
    success: t("Expense deleted", "Frais supprimé"),
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Delete this cost?", "Supprimer ce frais\u00a0?")}</DialogTitle>
          <DialogDescription>
            {L.type(e.type)} · {money(e.amountNative, e.currency)}{e.currency !== "USD" && ` (${usd(e.amountUsd)})`}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          {e.paidFromAccountId
            ? t(
                "The payment is reversed today: the money goes back into the account it was paid from.",
                "Le paiement est annulé aujourd'hui\u00a0: l'argent revient dans le compte qui l'avait payé.",
              )
            : t(
                "The debt is reversed today: we no longer owe this amount to the agent or supplier.",
                "La dette est annulée aujourd'hui\u00a0: nous ne devons plus ce montant à l'agent ou au fournisseur.",
              )}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Keep", "Garder")}</Button>
          <Button variant="destructive" onClick={() => del.mutate(undefined)} disabled={del.isPending}>
            {t("Delete", "Supprimer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddExpenseDialog({ c, onClose }: { c: ContainerFull; onClose: () => void }) {
  const t = useT();
  const L = useLabels();
  const [day, setDay] = useState(todayLocal());
  const [type, setType] = useState<ExpenseType>("freight");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"paid" | "owed">("paid");
  const [account, setAccount] = useState<Account | null>(null);
  const [partyId, setPartyId] = useState<number | null>(null);
  const [owedCurrency, setOwedCurrency] = useState<"USD" | "CDF">("USD");
  const [rate, setRate] = useState("");
  const [rateTouched, setRateTouched] = useState(false);
  const [method, setMethod] = useState<Method>("value");
  const [targetLineId, setTargetLineId] = useState<number | null>(null);
  const rateQ = useRate(day);
  useEffect(() => {
    if (!rateTouched && rateQ.data?.cdfPerUsd) setRate(d(rateQ.data.cdfPerUsd).toString());
  }, [rateQ.data?.cdfPerUsd, rateTouched]);

  const currency: "USD" | "CDF" = mode === "paid" ? (account?.currency ?? "USD") : owedCurrency;
  const isCdf = currency === "CDF";
  const amt = d(amount);
  const usdValue = isCdf ? (d(rate).gt(0) ? amt.dividedBy(d(rate)) : null) : amt;

  const create = useApiMutation<Record<string, unknown>>("POST", `/api/containers/${c.id}/expenses`, {
    success: t("Cost added", "Frais ajoutés"),
    onSuccess: onClose,
  });
  // The paying account's balance before and after, as on the supplier payment: a cost it cannot cover is
  // stopped here rather than by the server's "Solde insuffisant" after the confirmations.
  const { can } = useAuth();
  const balances = useAccounts("/api/accounts/balances", { enabled: mode === "paid" && can("manager", "partner") }).data;
  const drawer = mode === "paid" && account ? balances?.find((a) => a.id === account.id) : undefined;
  const drawerNow = drawer ? d(drawer.currency === "CDF" ? drawer.nativeBalance : drawer.balance) : null;
  const drawerAfter = drawerNow ? drawerNow.minus(amt.gt(0) && !unclearAmount(t, amount, currency) ? amt : 0) : null;
  const drawerShort = drawerNow && drawerAfter?.lt(0)
    ? t(`Not enough money: balance ${money(drawerNow.toFixed(2), currency)} → after ${money(drawerAfter.toFixed(2), currency)}`, `Fonds insuffisants\u00a0: solde ${money(drawerNow.toFixed(2), currency)} → après ${money(drawerAfter.toFixed(2), currency)}`)
    : null;
  const blocked =
    mode === "paid" && !account
      ? t("Choose the account it was paid from", "Choisissez le compte de paiement")
      : mode === "owed" && !partyId
        ? t("Choose who it is owed to", "Choisissez à qui c'est dû")
        : unclearAmount(t, amount, currency)
          ?? (!amt.gt(0)
          ? t("Enter an amount above zero", "Saisissez un montant supérieur à zéro")
          : isCdf && !d(rate).gt(0)
            ? t("Enter the exchange rate", "Saisissez le taux de change")
            : method === "line" && !targetLineId
              ? t("Choose the line", "Choisissez la ligne")
              : drawerShort);

  // A cost above the purchase value itself is most often francs typed with the currency left on dollars
  // (3 370 000 "$" of duty on an 11 243 $ container): said under the amount and confirmed before saving.
  const fob = c.preview ? d(c.preview.fobTotalUsd) : null;
  const tooBig = fob && fob.gt(0) && usdValue && usdValue.gt(fob) ? usdValue.dividedBy(fob).times(100) : null;
  const bigText = tooBig
    ? isCdf
      ? t(
          `${usd(usdValue!.toFixed(2))} is ${pct(tooBig.toNumber(), 0)} of the purchase value (${usd(fob!.toFixed(2))}): check the amount and the rate`,
          `${usd(usdValue!.toFixed(2))}, c'est ${pct(tooBig.toNumber(), 0)} de la valeur d'achat (${usd(fob!.toFixed(2))})\u00a0: vérifiez le montant et le taux`,
        )
      : t(
          `${usd(usdValue!.toFixed(2))} is ${pct(tooBig.toNumber(), 0)} of the purchase value (${usd(fob!.toFixed(2))}): is it an amount in francs?`,
          `${usd(usdValue!.toFixed(2))}, c'est ${pct(tooBig.toNumber(), 0)} de la valeur d'achat (${usd(fob!.toFixed(2))})\u00a0: est-ce un montant en francs\u00a0?`,
        )
    : null;
  const [confirmBig, setConfirmBig] = useState(false);

  function save() {
    create.mutate({
      date: day,
      type,
      description: description.trim() || null,
      amount: amt.toFixed(2),
      currency,
      ...(isCdf ? { rate: d(rate).toString() } : {}),
      method,
      targetLineId: method === "line" ? targetLineId : null,
      ...(mode === "paid" ? { paidFromAccountId: account!.id } : { payablePartyId: partyId }),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Add a container cost", "Ajouter un frais du conteneur")}</DialogTitle>
          <DialogDescription>
            {t("It will be added to the cost of the items when the container is offloaded.", "Il sera ajouté au coût des articles au déchargement du conteneur.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={t("Type", "Type")}>
            <Select value={type} onValueChange={(v) => setType(v as ExpenseType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXPENSE_TYPES.map((x) => (
                  <SelectItem key={x} value={x}>{L.type(x)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("Description (optional)", "Description (facultatif)")} className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("e.g. Dar es Salaam → Kalemie truck", "ex. camion Dar es Salaam → Kalemie")} />
          </Field>

          <div className="space-y-2 sm:col-span-2">
            <div className="inline-flex rounded-md border p-0.5">
              <Button type="button" size="sm" variant={mode === "paid" ? "default" : "ghost"} onClick={() => setMode("paid")}>
                {t("Paid now", "Payé maintenant")}
              </Button>
              <Button type="button" size="sm" variant={mode === "owed" ? "default" : "ghost"} onClick={() => setMode("owed")}>
                {t("Not paid yet", "Pas encore payé")}
              </Button>
            </div>
          </div>
          {mode === "paid" ? (
            <Field
              label={t("Paid from", "Payé depuis")}
              hint={drawerNow && drawerAfter ? `${t("Balance", "Solde")} ${money(drawerNow.toFixed(2), currency)}${drawerAfter.equals(drawerNow) ? "" : ` → ${t("after", "après")} ${money(drawerAfter.toFixed(2), currency)}`}` : undefined}
              error={drawerShort}
              required
            >
              <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
            </Field>
          ) : (
            <>
              <Field label={t("Owed to (agent or supplier)", "Dû à (agent ou fournisseur)")} required>
                <PartySelect types={["agent", "supplier"]} value={partyId} onChange={(id) => setPartyId(id)} />
              </Field>
              <Field label={t("Currency of the bill", "Devise de la facture")}>
                <Select value={owedCurrency} onValueChange={(v) => setOwedCurrency(v as "USD" | "CDF")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">{t("Dollars ($)", "Dollars ($)")}</SelectItem>
                    <SelectItem value="CDF">{t("Francs (FC)", "Francs (FC)")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
          <Field
            label={t(`Amount (${curLabel(currency)})`, `Montant (${curLabel(currency)})`)}
            error={francDecimalsError(t, currency, amount)}
            hint={bigText && <span role="alert" className="font-medium text-amber-800 dark:text-amber-400">{bigText}</span>}
            required
          >
            <Input inputMode="decimal" usd={currency === "USD"} thousands={isCdf} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </Field>
          {isCdf && (
            <Field
              label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")}
              hint={usdValue ? `= ${usd(usdValue.toFixed(2))}` : undefined}
              required
            >
              <Input inputMode="decimal" thousands rate value={rate} onChange={(e) => { setRate(e.target.value); setRateTouched(true); }} />
            </Field>
          )}

          <Field
            label={t("Split across the items", "Répartition sur les articles")}
            className="sm:col-span-2"
            hint={
              method === "value"
                ? t("Recommended: each item takes a share in proportion to what it cost.", "Recommandé\u00a0: chaque article prend une part proportionnelle à son prix d'achat.")
                : method === "weight"
                  ? t("Needs the weight of the lines.", "Nécessite le poids des lignes.")
                  : method === "volume"
                    ? t("Needs the volume of the lines.", "Nécessite le volume des lignes.")
                    : method === "quantity"
                      ? t("Every unit takes the same share.", "Chaque unité prend la même part.")
                      : t("The whole amount goes to one line (e.g. duty on motorcycles only).", "Tout le montant va sur une ligne (ex. douane sur les motos seulement).")
            }
          >
            <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m} disabled={m === "line" && c.lines.length === 0}>
                    {L.method(m)}{m === "value" ? ` (${t("recommended", "recommandé")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {method === "line" && (
            <Field label={t("Line", "Ligne")} className="sm:col-span-2" required>
              <Select value={targetLineId ? String(targetLineId) : ""} onValueChange={(v) => setTargetLineId(Number(v))}>
                <SelectTrigger><SelectValue placeholder={t("Pick the line", "Choisir la ligne")} /></SelectTrigger>
                <SelectContent>
                  {c.lines.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>{itemLabel(l)} ({qty(l.quantity)})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={() => (bigText ? setConfirmBig(true) : save())} blocked={blocked} pending={create.isPending}>{t("Add", "Ajouter")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmBig} onOpenChange={setConfirmBig}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("A cost above the purchase value?", "Un frais supérieur à la valeur d'achat\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{L.type(type)} · {money(amt.toFixed(2), currency)}</p>
                <p>{bigText}{bigText?.endsWith("?") ? "" : "."}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmBig(false);
                save();
              }}
            >
              {t(`Add ${money(amt.toFixed(2), currency)}`, `Ajouter ${money(amt.toFixed(2), currency)}`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Landed cost preview

function PreviewSection({ c, priceOf }: { c: ContainerFull; priceOf: Map<number, string> }) {
  const t = useT();
  const L = useLabels();
  const p = c.preview;
  if (c.lines.length === 0) return null;
  const cheap = p ? cheapLines(c, priceOf, p.lines) : [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("Landed cost preview", "Aperçu du coût de revient")}</CardTitle>
        <CardDescription>
          {t(
            "What each item will cost once in Kalemie: purchase value plus its share of the container costs. Based on the saved lines.",
            "Ce que chaque article coûtera une fois à Kalemie\u00a0: valeur d'achat plus sa part des frais du conteneur. Calculé sur les lignes enregistrées.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {c.previewError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("Cannot compute the landed cost", "Impossible de calculer le coût de revient")}</AlertTitle>
            <AlertDescription>
              {c.previewError}
              <div className="mt-1 text-xs">
                {t("Fix the lines (e.g. add weights) or change the split of that cost.", "Corrigez les lignes (ex. ajoutez les poids) ou changez la répartition de ce frais.")}
              </div>
            </AlertDescription>
          </Alert>
        )}
        {p && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
              <StatCard label={t("Purchase value", "Valeur d'achat")} value={usd(p.fobTotalUsd)} />
              <StatCard label={t("Container costs", "Frais du conteneur")} value={usd(p.expensesTotalUsd)} sub={d(p.fobTotalUsd).gt(0) ? `+${pct(d(p.expensesTotalUsd).dividedBy(d(p.fobTotalUsd)).times(100).toNumber())}` : undefined} />
              <StatCard label={t("Landed total", "Coût de revient total")} value={usd(p.landedTotalUsd)} />
            </div>
            {cheap.length > 0 && <CheapAlert cheap={cheap} currency={c.currency} />}
            <p className="text-xs text-muted-foreground hidden sm:block md:hidden">{t("Swipe the table sideways to see every column →", "Faites glisser le tableau sur le côté pour voir toutes les colonnes →")}</p>
            <div className="max-w-full overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                    <TableHead className="text-right">{t("Purchase ($)", "Achat ($)")}</TableHead>
                    {c.expenses.map((e) => (
                      <TableHead key={e.id} className="hidden text-right md:table-cell" data-card-label={`${L.type(e.type)} · ${L.method(e.method)}`}>
                        <span className="block whitespace-nowrap">{L.type(e.type)}</span>
                        <span className="block text-[10px] font-normal">{L.method(e.method)}</span>
                      </TableHead>
                    ))}
                    <TableHead className="text-right">{t("Costs added", "Frais ajoutés")}</TableHead>
                    <TableHead className="text-right">{t("Landed total", "Total de revient")}</TableHead>
                    <TableHead className="text-right">{t("Cost per unit", "Coût unitaire")}</TableHead>
                    <TableHead className="text-right">{t("Sell price", "Prix de vente")}</TableHead>
                    <TableHead className="text-right">{t("Margin", "Marge")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.lines.map((l) => {
                    const r = p.lines.find((x) => Number(x.key) === l.id);
                    if (!r) return null;
                    const sell = priceOf.get(l.variantId);
                    return (
                      <TableRow key={l.id}>
                        <TableCell className="min-w-[160px]">
                          <div className="font-medium">{itemLabel(l)}</div>
                          <div className="text-xs text-muted-foreground">{l.sku}</div>
                        </TableCell>
                        <TableCell className="text-right"><Num>{qty(l.quantity)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{usd(r.fobUsd)}</Num></TableCell>
                        {c.expenses.map((e) => (
                          <TableCell key={e.id} className="hidden text-right md:table-cell">
                            <Num className="text-muted-foreground">{usd(r.byExpense[String(e.id)] ?? 0)}</Num>
                          </TableCell>
                        ))}
                        <TableCell className="text-right"><Num>{usd(r.allocatedUsd)}</Num></TableCell>
                        <TableCell className="text-right"><Num className="font-medium">{usd(r.landedTotalUsd)}</Num></TableCell>
                        <TableCell className="text-right"><Num className="font-semibold">{unitCost(r.landedUnitCost)}</Num></TableCell>
                        <TableCell className="text-right"><Num>{sell !== undefined ? usd(sell) : "—"}</Num></TableCell>
                        <TableCell className="text-right"><MarginCell sell={sell} cost={r.landedUnitCost} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2} className="font-medium">{t("Total", "Total")}</TableCell>
                    <TableCell className="text-right"><Num>{usd(p.fobTotalUsd)}</Num></TableCell>
                    {c.expenses.map((e) => (
                      <TableCell key={e.id} className="hidden text-right md:table-cell"><Num>{usd(e.amountUsd)}</Num></TableCell>
                    ))}
                    <TableCell className="text-right"><Num>{usd(p.expensesTotalUsd)}</Num></TableCell>
                    <TableCell className="text-right"><Num className="font-semibold">{usd(p.landedTotalUsd)}</Num></TableCell>
                    <TableCell colSpan={3} />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t(
                "Margin compares the current sell price with the landed cost per unit. Stock already on hand is averaged with this cost (weighted average).",
                "La marge compare le prix de vente actuel au coût de revient unitaire. Le stock déjà présent est moyenné avec ce coût (coût moyen pondéré).",
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Costs so far under the selling price that an invoice price was probably mistyped. */
function CheapAlert({ cheap, currency, children }: { cheap: ReturnType<typeof cheapLines>; currency: string; children?: ReactNode }) {
  const t = useT();
  return (
    <Alert className="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("Cost far below the selling price", "Coût très inférieur au prix de vente")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <ul className="space-y-0.5">
          {cheap.map(({ l, cost, price }) => (
            <li key={l.id}>
              {itemLabel(l)}{t(": ", "\u00a0: ")}{t("cost", "coût")} {unitCost(cost)} · {t("sold at", "vendu")} {usd(price)}
            </li>
          ))}
        </ul>
        <p>
          {/* Franc prices read "6.500" as 6 500 (thousands), so the dollar example would be wrong for them. */}
          {currency === "CDF"
            ? t(
                `A margin above ${pct(SUSPECT_MARGIN, 0)} usually means an invoice price is missing a zero or the rate is wrong. Check the unit prices of these lines and the FC rate.`,
                `Une marge de plus de ${pct(SUSPECT_MARGIN, 0)} vient souvent d'un prix de facture auquel il manque un zéro, ou d'un taux erroné. Vérifiez les prix unitaires de ces lignes et le taux en FC.`,
              )
            : t(
                `A margin above ${pct(SUSPECT_MARGIN, 0)} usually means an invoice price was typed too small (6.500 read as 6.50 instead of 6,500). Check the unit prices of these lines.`,
                `Une marge de plus de ${pct(SUSPECT_MARGIN, 0)} vient souvent d'un prix de facture saisi trop petit (6.500 lu 6,50 au lieu de 6\u00a0500). Vérifiez les prix unitaires de ces lignes.`,
              )}
        </p>
        {children}
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------- Offload

function OffloadButton({ c, disabledReason, priceOf }: { c: ContainerFull; disabledReason: string | null; priceOf: Map<number, string> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [offloadDate, setOffloadDate] = useState(todayLocal());
  const finalize = useApiMutation<{ offloadDate: string }>("POST", `/api/containers/${c.id}/finalize`, {
    success: t("Container offloaded into stock", "Conteneur déchargé en stock"),
    onSuccess: () => setOpen(false),
  });
  const p = c.preview;
  const unpinned = c.expenses.some((e) => e.method === "line" && !c.lines.some((l) => l.id === e.targetLineId));
  const blocked =
    disabledReason ??
    (c.lines.length === 0
      ? t("Add the items first", "Ajoutez d'abord les articles")
      : c.previewError
        ? t("Fix the landed cost problem first", "Corrigez d'abord le problème de coût de revient")
        : unpinned
          ? t("A cost charged to one line has no line", "Un frais affecté à une ligne n'a pas de ligne")
          : null);
  const motos = c.lines.filter((l) => l.tracksSerials).reduce((s, l) => s.plus(d(l.quantity)), d(0));
  /** What the supplier is owed, in the invoice currency: the books keep a yuan or franc debt in that currency. */
  const owedNative = c.lines.reduce((s, l) => s.plus(d(l.quantity).times(d(l.unitPrice))), d(0)).toDecimalPlaces(2);
  const owedIn = fmtCur(owedNative.toFixed(2), c.currency);
  const owedText = c.currency === "USD" ? (p ? usd(p.fobTotalUsd) : usd(owedNative.toFixed(2))) : `${owedIn}${p ? ` (${usd(p.fobTotalUsd)})` : ""}`;
  /** Items that would cost more than they sell for once the container's costs are added. */
  const losing = p
    ? c.lines.flatMap((l) => {
        const pl = p.lines.find((x) => x.key === l.id);
        const price = priceOf.get(l.variantId);
        return pl && price && d(price).gt(0) && d(pl.landedUnitCost).gt(d(price)) ? [{ l, cost: pl.landedUnitCost, price }] : [];
      })
    : [];
  const noCosts = !!p && d(p.expensesTotalUsd).isZero();
  const [noCostsOk, setNoCostsOk] = useState(false);
  const cheap = p ? cheapLines(c, priceOf, p.lines) : [];
  const [cheapOk, setCheapOk] = useState(false);
  const [losingOk, setLosingOk] = useState(false);
  return (
    <>
      {/* The main button only once the container has arrived; before that, offloading is the exception. */}
      <SubmitButton variant={c.status === "arrived" ? "default" : "outline"} onClick={() => setOpen(true)} blocked={blocked} title={blocked ?? undefined}>
        <PackageCheck className="mr-1 h-4 w-4" /> {t("Offload into stock", "Décharger en stock")}
      </SubmitButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(`Offload container ${c.number}`, `Décharger le conteneur ${c.number}`)}</DialogTitle>
            <DialogDescription>{t("Check the totals before confirming.", "Vérifiez les totaux avant de confirmer.")}</DialogDescription>
          </DialogHeader>
          <Field label={t("Offload date", "Date de déchargement")} required>
            <Input type="date" value={offloadDate} onChange={(e) => setOffloadDate(e.target.value)} />
          </Field>
          {p && (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <div className="flex justify-between"><span>{t("Purchase value", "Valeur d'achat")}</span><Num>{usd(p.fobTotalUsd)}</Num></div>
              <div className="flex justify-between"><span>{t("Container costs", "Frais du conteneur")}</span><Num>{usd(p.expensesTotalUsd)}</Num></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><span>{t("Landed total into stock", "Total de revient en stock")}</span><Num>{usd(p.landedTotalUsd)}</Num></div>
              <div className="flex flex-wrap justify-between gap-x-2 border-t pt-1">
                <span>{t("Owed to the supplier", "Dû au fournisseur")}</span>
                <Num className="font-medium">{owedText}</Num>
              </div>
            </div>
          )}
          {losing.length > 0 && (
            <Alert className="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t("Cost above the selling price", "Coût supérieur au prix de vente")}</AlertTitle>
              <AlertDescription>
                <ul className="space-y-0.5">
                  {losing.map(({ l, cost, price }) => (
                    <li key={l.id}>
                      {itemLabel(l)}{t(": ", "\u00a0: ")}{t("cost", "coût")} {unitCost(cost)} · {t("sold at", "vendu")} {usd(price)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">{t("Raise the selling price on the item page after the offload, or check the invoice prices and the costs.", "Relevez le prix de vente dans la fiche article après le déchargement, ou vérifiez les prix de la facture et les frais.")}</p>
                <label className="mt-2 flex items-start gap-2">
                  <Checkbox checked={losingOk} onCheckedChange={(v) => setLosingOk(v === true)} className="mt-0.5" />
                  <span>{t("I checked: offload at these costs", "J'ai vérifié\u00a0: décharger à ces coûts")}</span>
                </label>
              </AlertDescription>
            </Alert>
          )}
          {cheap.length > 0 && (
            <CheapAlert cheap={cheap} currency={c.currency}>
              <label className="flex items-start gap-2">
                <Checkbox checked={cheapOk} onCheckedChange={(v) => setCheapOk(v === true)} className="mt-0.5" />
                <span>{t("I checked: these prices are right", "J'ai vérifié\u00a0: ces prix sont justes")}</span>
              </label>
            </CheapAlert>
          )}
          {noCosts && (
            <Alert className="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t("No container costs entered", "Aucun frais de conteneur saisi")}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  {t(
                    "Freight, customs and transport are usually part of the cost. Without them the stock is valued at the purchase price only, and margins look higher than they are. Costs cannot be added after the offload unless it is reversed.",
                    "Fret, douane et transport font normalement partie du coût. Sans eux le stock est valorisé au seul prix d'achat et les marges paraissent plus hautes qu'en réalité. Les frais ne peuvent plus être ajoutés après le déchargement, sauf en l'annulant.",
                  )}
                </p>
                <label className="flex items-start gap-2">
                  <Checkbox checked={noCostsOk} onCheckedChange={(v) => setNoCostsOk(v === true)} className="mt-0.5" />
                  <span>{t("This container really has no costs", "Ce conteneur n'a vraiment aucun frais")}</span>
                </label>
              </AlertDescription>
            </Alert>
          )}
          <div className="text-sm">
            <p className="mb-1 font-medium">{t("What will happen", "Ce qui va se passer")}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t("Every item is added to stock at its landed cost per unit.", "Chaque article entre en stock à son coût de revient unitaire.")}</li>
              <li>
                {t(`${c.supplierName ?? "The supplier"} is recorded as owed ${owedText}.`, `${c.supplierName ? `Il est noté que vous devez ${owedText} à ${c.supplierName}` : `Il est noté que vous devez ${owedText} au fournisseur`}.`)}
              </li>
              {motos.gt(0) && (
                <li>{motos.equals(1)
                    ? t("1 motorcycle record is created; add its chassis number before selling.", "1 fiche moto est créée\u00a0; ajoutez le numéro de châssis avant de vendre.")
                    : t(`${motos.toString()} motorcycle records are created; add their chassis numbers before selling.`, `${motos.toString()} fiches moto sont créées\u00a0; ajoutez les numéros de châssis avant de vendre.`)}</li>
              )}
              <li>{t("The container is locked: lines and costs can no longer change.", "Le conteneur est verrouillé\u00a0: lignes et frais ne peuvent plus changer.")}</li>
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("Cancel", "Annuler")}</Button>
            <SubmitButton onClick={() => finalize.mutate({ offloadDate })} blocked={!offloadDate ? t("Choose the offload date", "Choisissez la date de déchargement") : noCosts && !noCostsOk ? t("Confirm there are no costs, or add them first", "Confirmez l'absence de frais, ou ajoutez-les d'abord") : cheap.length > 0 && !cheapOk ? t("Confirm the prices of the lines with a very high margin", "Confirmez les prix des lignes à marge très élevée") : losing.length > 0 && !losingOk ? t("Confirm the lines that cost more than they sell for", "Confirmez les lignes qui coûtent plus que leur prix de vente") : null} pending={finalize.isPending}>
              <Lock className="mr-1 h-4 w-4" /> {t("Confirm offload", "Confirmer le déchargement")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReverseButton({ c }: { c: ContainerFull }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(todayLocal());
  const reverse = useApiMutation<{ date: string }>("POST", `/api/containers/${c.id}/reverse`, {
    success: t("Offload reversed", "Déchargement annulé"),
    onSuccess: () => setOpen(false),
  });
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Undo2 className="mr-1 h-4 w-4" /> {t("Reverse offload", "Annuler le déchargement")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("Reverse the offload?", "Annuler le déchargement\u00a0?")}</DialogTitle>
            <DialogDescription>
              {t(
                "The container's stock is taken back out, the supplier debt is cancelled and the container can be edited again. This only works while all of its stock is still on hand (no motorcycle sold). Chassis numbers already entered are kept and reused when the container is offloaded again.",
                "Le stock du conteneur est retiré, la dette fournisseur est annulée et le conteneur redevient modifiable. Possible seulement si tout son stock est encore en magasin (aucune moto vendue). Les numéros de châssis déjà saisis sont conservés et réutilisés au prochain déchargement.",
              )}
            </DialogDescription>
          </DialogHeader>
          <Field label={t("Reversal date", "Date d'annulation")} required>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("Back", "Retour")}</Button>
            <SubmitButton variant="destructive" onClick={() => reverse.mutate({ date: day })} blocked={!day && t("Choose the reversal date", "Choisissez la date d'annulation")} pending={reverse.isPending}>
              {t("Reverse", "Annuler le déchargement")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- After offload

function FinalCosts({ c, priceOf }: { c: ContainerFull; priceOf: Map<number, string> }) {
  const t = useT();
  const hasMotos = c.lines.some((l) => l.tracksSerials);
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
        <StatCard label={t("Purchase value", "Valeur d'achat")} value={usd(c.fobTotalUsd)} />
        <StatCard label={t("Container costs", "Frais du conteneur")} value={usd(c.expensesTotalUsd)} />
        <StatCard label={t("Landed total", "Coût de revient total")} value={usd(c.landedTotalUsd)} sub={c.offloadDate ? `${t("Offloaded on", "Déchargé le")} ${date(c.offloadDate)}` : undefined} />
      </div>
      {hasMotos && (
        <Alert>
          <Bike className="h-4 w-4" />
          <AlertTitle>{t("Register the chassis numbers", "Enregistrez les numéros de châssis")}</AlertTitle>
          <AlertDescription>
            {t("A motorcycle needs its chassis number before it can be sold.", "Une moto doit avoir son numéro de châssis avant d'être vendue.")}{" "}
            <Link href="/motorcycles" className="font-medium text-primary underline">
              {t("Go to Motorcycles", "Aller aux Motos")}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lock className="h-4 w-4" /> {t("Final landed costs", "Coûts de revient définitifs")}
          </CardTitle>
          <CardDescription>{t("These items went into stock at these costs.", "Ces articles sont entrés en stock à ces coûts.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Item", "Article")}</TableHead>
                  <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                  {/* The invoice's unit price sits under the purchase value, so the margin stays in view at 1280 px. */}
                  <TableHead className="text-right">{t("Purchase ($)", "Achat ($)")}</TableHead>
                  <TableHead className="text-right">{t("Costs added", "Frais ajoutés")}</TableHead>
                  <TableHead className="text-right">{t("Landed total", "Total de revient")}</TableHead>
                  <TableHead className="text-right">{t("Cost per unit", "Coût unitaire")}</TableHead>
                  <TableHead className="text-right">{t("Sell price", "Prix de vente")}</TableHead>
                  <TableHead className="text-right">{t("Margin", "Marge")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.lines.map((l) => {
                  const sell = priceOf.get(l.variantId);
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="min-w-[160px]">
                        <div className="font-medium">{itemLabel(l)}</div>
                        <div className="text-xs text-muted-foreground">{l.sku}</div>
                      </TableCell>
                      <TableCell className="text-right"><Num>{qty(l.quantity)}</Num></TableCell>
                      <TableCell className="text-right">
                        <Num>{usd(l.fobUsd)}</Num>
                        <span className="block whitespace-nowrap text-xs text-muted-foreground">{fmtCur(l.unitPrice, c.currency)} {t("each", "l'unité")}</span>
                      </TableCell>
                      <TableCell className="text-right"><Num>{usd(l.allocatedUsd)}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-medium">{usd(l.landedTotalUsd)}</Num></TableCell>
                      <TableCell className="text-right"><Num className="font-semibold">{unitCost(l.landedUnitCost)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{sell !== undefined ? usd(sell) : "—"}</Num></TableCell>
                      <TableCell className="text-right"><MarginCell sell={sell} cost={l.landedUnitCost} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

