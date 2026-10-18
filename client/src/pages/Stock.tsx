import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { de } from "@shared/french";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { Link } from "wouter";
import { AlertTriangle, ArrowRightLeft, Bike, CheckCircle2, ChevronDown, ChevronRight, Search, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DecimalInput, Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionLinks } from "@/components/AppLayout";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard, SubmitButton } from "@/components/common";
import { LocationSelect, useLocations, VariantSearch } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { api, withQuery } from "@/lib/api";
import { d, date, monthStart, qty, qtyTotal, todayLocal, unitCost, usd, variantText, variantUnitCost, unclearQty } from "@/lib/format";
import { qtyWithUnit, wholeUnit } from "@/lib/units";
import { useAuth } from "@/lib/auth";
import { useT, count } from "@/lib/i18n";
import type { MotorcycleUnit, VariantRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSystemText } from "@/lib/systemText";

type T = (en: string, fr: string) => string;

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
  value: string;
  sellPrice: string;
  reorderLevel: string;
  avgCost: string;
  retailValue: string;
  low: boolean;
}

interface StockValuation {
  items: StockItem[];
  totalValue: string;
  totalRetailValue: string;
  ledgerInventory: string;
  reconciled: boolean;
}

interface Adjustment {
  id: number;
  number: string;
  date: string;
  locationId: number;
  kind: Kind;
  reason: string;
  journalId: number | null;
  createdAt: string;
  locationName?: string;
  /** Signed stock movements: qty and value are positive in, negative out. */
  lines?: { variantId: number; sku: string; attributes: Record<string, string>; productName: string; qty: string; value: string }[];
  /** Net value change of the adjustment, USD. */
  value?: string;
}

type Kind = "opening" | "count" | "damage" | "loss" | "found" | "other";
const KINDS: Kind[] = ["opening", "count", "damage", "loss", "found", "other"];

function kindLabel(t: T, k: string) {
  const m: Record<string, [string, string]> = {
    opening: ["Opening stock", "Stock d'ouverture"],
    count: ["Stock count correction", "Correction d'inventaire"],
    damage: ["Damaged", "Endommagé"],
    loss: ["Lost / stolen", "Perdu / volé"],
    found: ["Found", "Retrouvé"],
    other: ["Other", "Autre"],
  };
  const x = m[k];
  return x ? t(x[0], x[1]) : k;
}

const isQty = (s: string) => /^-?\d+(\.\d+)?$/.test(s.trim());
const isPositive = (s: string) => /^\d+(\.\d+)?$/.test(s.trim()) && d(s).gt(0);

export default function Stock() {
  const t = useT();
  const { can } = useAuth();
  const { data: locations = [] } = useLocations();
  const isManager = can("manager");
  const multiLocation = locations.filter((l) => l.active).length > 1;
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get("tab") ?? "valuation");

  return (
    <div>
      <PageHeader
        title={t("Stock", "Stock")}
        description={t("Stock is valued at weighted average cost (purchase price plus container costs).", "Le stock est valorisé au coût moyen pondéré (prix d'achat plus frais du conteneur).")}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="valuation">{t("Valuation", "Valorisation")}</TabsTrigger>
          {isManager && <TabsTrigger value="adjust">{t("Adjust stock", "Ajuster le stock")}</TabsTrigger>}
          <TabsTrigger value="history">{t("Adjustments", "Ajustements")}</TabsTrigger>
          {isManager && multiLocation && <TabsTrigger value="transfer">{t("New transfer", "Nouveau transfert")}</TabsTrigger>}
          <TabsTrigger value="transfers">{t("Transfers", "Transferts")}</TabsTrigger>
          <SectionLinks />
        </TabsList>
        <TabsContent value="valuation"><Valuation /></TabsContent>
        {isManager && <TabsContent value="adjust"><AdjustForm onDone={() => setTab("history")} /></TabsContent>}
        <TabsContent value="history"><AdjustmentHistory /></TabsContent>
        {isManager && multiLocation && <TabsContent value="transfer"><TransferForm onDone={() => setTab("transfers")} /></TabsContent>}
        <TabsContent value="transfers"><TransferHistory multiLocation={multiLocation} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ------------------------------------------------------------------ Valuation

function Valuation() {
  const t = useT();
  const q = useQuery<StockValuation>({ queryKey: ["/api/stock"] });
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const data = q.data;
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => {
      if (lowOnly && !i.low) return false;
      if (hideEmpty && d(i.qty).isZero()) return false;
      if (!term) return true;
      return [i.productName, i.sku, i.barcode ?? "", i.categoryName ?? "", variantText(i.attributes)].some((x) => x.toLowerCase().includes(term));
    });
  }, [data, search, lowOnly, hideEmpty]);
  const shown = useMemo(
    () => ({
      qty: qtyTotal(rows),
      value: rows.reduce((s, i) => s.plus(d(i.value)), d(0)),
      retail: rows.reduce((s, i) => s.plus(d(i.retailValue)), d(0)),
    }),
    [rows],
  );

  if (q.isLoading) return <Loading />;
  if (q.error || !data) return <ErrorText error={q.error} />;
  const lowCount = data.items.filter((i) => i.low).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
        <StatCard label={t("Stock value (cost)", "Valeur du stock (coût)")} value={usd(data.totalValue)} />
        <StatCard
          label={t("Retail value", "Valeur de vente")}
          value={usd(data.totalRetailValue)}
          sub={t(`Potential margin ${usd(d(data.totalRetailValue).minus(d(data.totalValue)).toFixed(2))}`, `Marge potentielle ${usd(d(data.totalRetailValue).minus(d(data.totalValue)).toFixed(2))}`)}
        />
        <StatCard label={t("Low stock items", "Articles en stock bas")} value={lowCount} tone={lowCount ? "bad" : "neutral"} />
      </div>

      {data.reconciled ? (
        <p className="flex items-center gap-2 text-sm text-green-800 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" /> {t("Stock value matches the ledger", "La valeur du stock correspond à la comptabilité")} ({usd(data.ledgerInventory)})
        </p>
      ) : (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("Stock value does not match the ledger", "La valeur du stock ne correspond pas à la comptabilité")}</AlertTitle>
          <AlertDescription>
            {t("Items: ", "Articles\u00a0: ")}{usd(data.totalValue)} · {t("Inventory account: ", "Compte Stock\u00a0: ")}{usd(data.ledgerInventory)} · {t("Difference: ", "Écart\u00a0: ")}{usd(d(data.totalValue).minus(d(data.ledgerInventory)).toFixed(2))}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder={t("Item, SKU, category, size", "Article, code, catégorie, taille")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm"><Switch checked={lowOnly} onCheckedChange={setLowOnly} /> {t("Low stock only", "Stock bas seulement")}</label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={hideEmpty} onCheckedChange={setHideEmpty} /> {t("Hide zero stock", "Masquer stock zéro")}</label>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t("No items", "Aucun article")} />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Item", "Article")}</TableHead>
                <TableHead>{t("SKU", "Code")}</TableHead>
                <TableHead>{t("Category", "Catégorie")}</TableHead>
                <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                <TableHead className="text-right">{t("Avg cost", "Coût moyen")}</TableHead>
                <TableHead className="text-right">{t("Value", "Valeur")}</TableHead>
                <TableHead className="text-right">{t("Retail value", "Valeur de vente")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => (
                <TableRow key={i.variantId}>
                  <TableCell>
                    <Link href={`/products/${i.productId}`} className="font-medium hover:underline">{i.productName}</Link>
                    {variantText(i.attributes) && <div className="text-xs text-muted-foreground">{variantText(i.attributes)}</div>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{i.sku}</TableCell>
                  <TableCell className="text-muted-foreground">{i.categoryName ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Num className={d(i.qty).lte(0) ? "text-destructive" : undefined}>{qtyWithUnit(t, i.qty, i.unit)}</Num>
                    {i.low && <Badge variant="destructive" className="ml-2">{t("Low", "Bas")}</Badge>}
                  </TableCell>
                  <TableCell className="text-right"><Num>{unitCost(i.avgCost)}</Num></TableCell>
                  <TableCell className="text-right"><Num>{usd(i.value)}</Num></TableCell>
                  <TableCell className="text-right"><Num>{usd(i.retailValue)}</Num></TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-medium">
                <TableCell colSpan={3}>{t("Total", "Total")} ({count(t, rows.length, ["line", "lines"], ["ligne", "lignes"])})</TableCell>
                <TableCell className="text-right"><Num>{shown.qty}</Num></TableCell>
                <TableCell />
                <TableCell className="text-right"><Num>{usd(shown.value.toFixed(2))}</Num></TableCell>
                <TableCell className="text-right"><Num>{usd(shown.retail.toFixed(2))}</Num></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Adjust stock

interface Serial {
  chassisNo: string;
  engineNo: string;
  color: string;
}

interface AdjLine {
  key: number;
  variant: VariantRow;
  qty: string;
  /** Count mode: the quantity counted on the shelf; qty is then counted − what the system holds here. */
  counted?: string;
  unitCost: string;
  serials: Serial[];
  unitIds: number[];
}

let lineKey = 1;

/** Body of POST /api/stock/adjustments without the date (the shape an optional voucher stores). */
export interface AdjustmentPayload {
  locationId?: number | null;
  kind?: Kind;
  reason?: string;
  lines?: { variantId: number; qtyChange: string; unitCost?: string; unitIds?: number[]; serials?: { chassisNo: string; engineNo?: string | null; color?: string | null }[] }[];
}

export interface AdjustmentDraft {
  date: string;
  memo: string | null;
  payload: AdjustmentPayload;
}

/**
 * Stock adjustment form. On the Stock page it only posts; the Vouchers page also passes
 * `initial` (an optional voucher to prefill) and `onSaveDraft` (save as optional voucher).
 */
export function AdjustForm({
  onDone,
  initial,
  onSaveDraft,
  savingDraft,
  readOnly,
}: {
  onDone: (result: { id: number; number: string; journalId: number | null }) => void;
  initial?: { date?: string; payload: AdjustmentPayload } | null;
  onSaveDraft?: (draft: AdjustmentDraft) => void;
  savingDraft?: boolean;
  readOnly?: boolean;
}) {
  const t = useT();
  const [dateValue, setDateValue] = useState(todayLocal());
  const [locationId, setLocationId] = useState<number | null>(null);
  const [kind, setKind] = useState<Kind>("count");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<AdjLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const onlyRemove = kind === "damage" || kind === "loss";
  const onlyAdd = kind === "opening";
  const signed = !onlyRemove && !onlyAdd;
  // Stock found is a gain shared by the partners, so staff do not price it (the server refuses): an item in
  // stock comes back at its average cost, one out of stock at what it cost when bought (within 10 %).
  const { can } = useAuth();
  const staffCost = !can() && kind !== "opening";
  // A count is typed as what is on the shelf; the difference with the system is worked out.
  const [countMode, setCountMode] = useState<"counted" | "change">("counted");
  const byCount = kind === "count" && countMode === "counted";

  const m = useApiMutation<unknown, { id: number; number: string; journalId: number | null }>("POST", "/api/stock/adjustments", {
    success: t("Stock adjusted", "Stock ajusté"),
    onSuccess: (result) => {
      setLines([]);
      setReason("");
      onDone(result);
    },
  });

  // Changing location invalidates picked motorcycles (but not while loading an optional voucher).
  const prevLocation = useRef<number | null>(null);
  const hydrating = useRef(false);
  useEffect(() => {
    if (prevLocation.current !== null && prevLocation.current !== locationId && !hydrating.current) {
      setLines((ls) => ls.map((l) => ({ ...l, unitIds: [] })));
    }
    hydrating.current = false;
    prevLocation.current = locationId;
  }, [locationId]);

  // Prefill from an optional voucher.
  useEffect(() => {
    if (!initial) return;
    let cancelled = false;
    const p = initial.payload ?? {};
    const k = p.kind && KINDS.includes(p.kind) ? p.kind : "count";
    const draftLines = Array.isArray(p.lines) ? p.lines : [];
    (async () => {
      const ids = draftLines.map((l) => l.variantId).filter(Boolean);
      const variants = ids.length
        ? await api<VariantRow[]>("GET", withQuery("/api/variants", { ids: ids.join(","), locationId: p.locationId ?? undefined, limit: 500 })).catch(() => [] as VariantRow[])
        : [];
      if (cancelled) return;
      if (initial.date) setDateValue(initial.date);
      setKind(k);
      // A pending voucher holds the change itself, not what was counted.
      setCountMode("change");
      setReason(p.reason ?? "");
      if (p.locationId && p.locationId !== prevLocation.current) {
        hydrating.current = true;
        setLocationId(p.locationId);
      }
      const rows: AdjLine[] = [];
      for (const l of draftLines) {
        const v = variants.find((x) => x.id === l.variantId);
        if (!v) continue;
        const q = d(l.qtyChange);
        rows.push({
          key: lineKey++,
          variant: v,
          qty: k === "damage" || k === "loss" ? q.abs().toString() : q.toString(),
          unitCost: l.unitCost ?? "",
          serials: (l.serials ?? []).map((s) => ({ chassisNo: s.chassisNo ?? "", engineNo: s.engineNo ?? "", color: s.color ?? "" })),
          unitIds: l.unitIds ?? [],
        });
      }
      setLines(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [initial]);

  function draftPayload(): AdjustmentPayload {
    return {
      locationId,
      kind,
      reason: reason.trim(),
      lines: lines.map((l) => {
        const c = change(l);
        return {
          variantId: l.variant.id,
          qtyChange: c.toString(),
          ...(c.gt(0) && l.unitCost.trim() ? { unitCost: d(l.unitCost).toString() } : {}),
          ...(c.gt(0) && l.variant.tracksSerials
            ? { serials: l.serials.map((s) => ({ chassisNo: s.chassisNo.trim().toUpperCase(), engineNo: s.engineNo.trim().toUpperCase() || null, color: s.color.trim() || null })) }
            : {}),
          ...(c.lt(0) && l.variant.tracksSerials ? { unitIds: l.unitIds } : {}),
        };
      }),
    };
  }

  function change(l: AdjLine) {
    if (!isQty(l.qty)) return d(0);
    const n = d(l.qty);
    if (onlyRemove) return n.abs().negated();
    if (onlyAdd) return n.abs();
    return n;
  }

  function update(key: number, patch: Partial<AdjLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function setQty(l: AdjLine, value: string) {
    const patch: Partial<AdjLine> = { qty: value };
    if (l.variant.tracksSerials) {
      const n = isQty(value) ? Number(value) : 0;
      const count = Number.isInteger(n) ? n : 0;
      const adding = onlyAdd || (!onlyRemove && count > 0);
      const want = adding ? Math.min(Math.abs(count), 200) : 0;
      const serials = l.serials.slice(0, want);
      while (serials.length < want) serials.push({ chassisNo: "", engineNo: "", color: "" });
      patch.serials = serials;
    }
    update(l.key, patch);
  }

  function setCounted(l: AdjLine, value: string) {
    const diff = isQty(value) ? d(value).minus(d(l.variant.locationQty)) : null;
    setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, counted: value } : x)));
    setQty({ ...l, counted: value }, diff ? diff.toString() : "");
  }

  function addVariant(v: VariantRow) {
    if (lines.some((l) => l.variant.id === v.id)) return;
    const cost = d(v.stockQty).gt(0) ? d(v.avgCost).toDecimalPlaces(4).toString() : "";
    setLines((ls) => [...ls, { key: lineKey++, variant: v, qty: "", unitCost: cost, serials: [], unitIds: [] }]);
  }

  function submit() {
    setError(null);
    if (!locationId) return setError(t("Choose a location.", "Choisissez un emplacement."));
    if (!reason.trim()) return setError(t("Give a reason.", "Indiquez un motif."));
    // "1.000" pieces (or litres) is asked about by its field (1 000 or 1?), never read as 1; asked first,
    // since such a line reads as no quantity at all.
    for (const l of lines) {
      const unclear = unclearQty(t, byCount ? l.counted : l.qty);
      if (unclear) return setError(`${unclear} (${l.variant.productName} · ${l.variant.sku})`);
    }
    const active = lines.filter((l) => !change(l).isZero());
    if (active.length === 0) return setError(t("Add at least one item with a quantity.", "Ajoutez au moins un article avec une quantité."));
    const payload = [];
    for (const l of lines) {
      const name = `${l.variant.productName} (${l.variant.sku})`;
      if (byCount && isQty(l.counted ?? "") && d(l.qty).isZero()) return setError(t(`${name}: the count matches the stock, nothing to adjust. Remove the line.`, `${name}\u00a0: le comptage correspond au stock, rien à ajuster. Retirez la ligne.`));
      if (!isQty(l.qty) || d(l.qty).isZero()) return setError(t(`Enter a quantity for ${name} or remove the line.`, `Saisissez une quantité pour ${name} ou retirez la ligne.`));
      const c = change(l);
      if (l.variant.tracksSerials && !c.isInteger()) return setError(t("Motorcycles must be whole units.", "Les motos doivent être en unités entières."));
      if (!c.isInteger() && wholeUnit(l.variant.unit)) return setError(t(`${name} is counted in whole units: use a whole number.`, `${name} se compte à l'unité\u00a0: saisissez un nombre entier.`));
      const line: { variantId: number; qtyChange: string; unitCost?: string; unitIds?: number[]; serials?: { chassisNo: string; engineNo: string | null; color: string | null }[] } = {
        variantId: l.variant.id,
        qtyChange: c.toString(),
      };
      if (c.gt(0)) {
        if (staffCost && d(l.variant.stockQty).gte(1)) {
          // Goes in at the average cost: nothing to send.
        } else if (l.unitCost.trim()) {
          if (!/^\d+(\.\d+)?$/.test(l.unitCost.trim())) return setError(t(`Invalid cost for ${name}.`, `Coût invalide pour ${name}.`));
          line.unitCost = d(l.unitCost).toString();
        } else if (d(l.variant.stockQty).lte(0) && !staffCost) {
          return setError(t(`Give a cost per unit for ${name}: it has no stock to take an average from.`, `Indiquez un coût unitaire pour ${name}\u00a0: il n'a pas de stock pour calculer une moyenne.`));
        }
        if (l.variant.tracksSerials) {
          const chassis = l.serials.map((s) => s.chassisNo.trim().toUpperCase()).filter(Boolean);
          if (new Set(chassis).size !== chassis.length) return setError(t("The same chassis number is typed twice.", "Le même numéro de châssis est saisi deux fois."));
          line.serials = l.serials.map((s) => ({ chassisNo: s.chassisNo.trim().toUpperCase(), engineNo: s.engineNo.trim().toUpperCase() || null, color: s.color.trim() || null }));
        }
      } else if (l.variant.tracksSerials) {
        if (l.unitIds.length !== c.abs().toNumber()) {
          return setError(t(`Pick exactly ${count(t, c.abs().toNumber(), ["motorcycle", "motorcycles"], ["", ""])} of ${name} to remove.`, `Choisissez exactement ${count(t, c.abs().toNumber(), ["", ""], ["moto", "motos"])} ${de(name)} à retirer.`));
        }
        line.unitIds = l.unitIds;
      }
      payload.push(line);
    }
    const body = { date: dateValue, locationId, kind, reason: reason.trim(), lines: payload };
    // A gain or loss of 100 $ or more is asked about first: one tap should not book a 4 000 $ loss,
    // even when as much is found elsewhere (2 000 $ lost and 1 950 $ found nets only 50 $).
    if (kind !== "opening" && (found.gte(CONFIRM_ABOVE_USD) || lost.gte(CONFIRM_ABOVE_USD))) return setConfirming(body);
    m.mutate(body);
  }

  /**
   * Value of the stock found and of the stock lost, worked out to the cent as the server books it: stock found
   * at the cost typed (else the exact average), stock lost as its share of the item's stock value.
   */
  const valueOf = (l: AdjLine) => {
    const c = change(l);
    const sq = d(l.variant.stockQty);
    const sv = d(l.variant.stockValue);
    if (c.gt(0)) {
      const fixed = staffCost && sq.gte(1);
      const cost = !fixed && l.unitCost.trim() ? d(l.unitCost) : sq.gt(0) ? sv.dividedBy(sq) : d(0);
      return c.times(cost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    if (c.isZero() || !sq.gt(0)) return d(0);
    return (c.abs().gte(sq) ? sv : sv.times(c.abs()).dividedBy(sq).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)).negated();
  };
  const found = lines.reduce((s, l) => (valueOf(l).gt(0) ? s.plus(valueOf(l)) : s), d(0));
  const lost = lines.reduce((s, l) => (valueOf(l).lt(0) ? s.plus(valueOf(l).abs()) : s), d(0));
  const totalChange = found.minus(lost);
  const [confirming, setConfirming] = useState<Record<string, unknown> | null>(null);

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription className="text-sm">
          {kind === "opening"
            ? t(
                "Opening stock is the stock already in the shop when you start using the system. Its value is posted against “Opening balances” (capital), not as profit or loss.",
                "Le stock d'ouverture est le stock déjà présent au magasin quand vous commencez à utiliser le système. Sa valeur est passée en «\u00a0Soldes d'ouverture\u00a0» (capital), pas en profit ni en perte.",
              )
            : t(
                "Counts, damage, losses and found items are booked as stock losses or gains at average cost. They reduce or increase the gross profit shared by both partners at month close.",
                "Les comptages, casses, pertes et articles retrouvés sont passés en pertes ou gains de stock au coût moyen. Ils diminuent ou augmentent la marge brute partagée par les deux associés à la clôture du mois.",
              )}
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Date", "Date")}><Input type="date" value={dateValue} onChange={(e) => setDateValue(e.target.value)} /></Field>
          <Field label={t("Location", "Emplacement")} required><LocationSelect value={locationId} onChange={setLocationId} /></Field>
          <Field label={t("Kind", "Type")}>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{kindLabel(t, k)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label={t("Reason", "Motif")} className="sm:col-span-2 lg:col-span-1" required>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === "opening" ? t("Stock at start", "Stock au démarrage") : t("e.g. monthly count", "ex. inventaire mensuel")} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Items", "Articles")}</CardTitle>
          {kind === "count" && (
            <div className="flex flex-wrap items-center gap-2 pt-1" role="radiogroup" aria-label={t("How to type the count", "Comment saisir le comptage")}>
              {(["counted", "change"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={countMode === m}
                  variant={countMode === m ? "default" : "outline"}
                  onClick={() => {
                    setCountMode(m);
                    setLines((ls) => ls.map((l) => ({ ...l, qty: "", counted: "", serials: [], unitIds: [] })));
                  }}
                >
                  {m === "counted" ? t("Quantity counted", "Quantité comptée") : t("Change (+/−)", "Variation (+/−)")}
                </Button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {byCount
              ? t("Type what is on the shelf: the difference with the stock in the system is worked out.", "Saisissez ce qui est sur l'étagère\u00a0: l'écart avec le stock du système est calculé.")
              : onlyRemove
              ? t("Type the quantity removed.", "Saisissez la quantité retirée.")
              : onlyAdd
                ? t("Type the quantity on hand and its cost per unit.", "Saisissez la quantité en main et son coût unitaire.")
                : t("Type + to add (e.g. 3) or − to remove (e.g. -2).", "Saisissez + pour ajouter (ex. 3) ou − pour retirer (ex. -2).")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <VariantSearch onPick={addVariant} locationId={locationId} showCost />
          {lines.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">{t("Search or scan items to adjust.", "Cherchez ou scannez les articles à ajuster.")}</p>}
          {lines.map((l) => {
            const c = change(l);
            const needsCost = c.gt(0) && d(l.variant.stockQty).lte(0) && !staffCost;
            const fixedCost = c.gt(0) && staffCost && d(l.variant.stockQty).gte(1);
            return (
              <div key={l.key} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 font-medium">
                      {l.variant.tracksSerials && <Bike className="h-4 w-4 text-primary" />}
                      {l.variant.productName}{l.variant.label !== "Standard" ? ` · ${l.variant.label}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {l.variant.sku} · {t("here", "ici")} {qtyWithUnit(t, l.variant.locationQty, l.variant.unit)} · {t("total", "total")} {qtyWithUnit(t, l.variant.stockQty, l.variant.unit)} · {t("avg cost", "coût moyen")} {variantUnitCost(l.variant)}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label={t("Remove", "Retirer")} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" /></Button>
                </div>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  {byCount ? (
                    <Field
                      label={t("Quantity counted", "Quantité comptée")}
                      hint={t(`In the system here: ${qtyWithUnit(t, l.variant.locationQty, l.variant.unit)}`, `Dans le système ici\u00a0: ${qtyWithUnit(t, l.variant.locationQty, l.variant.unit)}`)}
                      required
                    >
                      <DecimalInput inputMode={wholeUnit(l.variant.unit) ? "numeric" : "decimal"} whole={wholeUnit(l.variant.unit)} measured={!wholeUnit(l.variant.unit)} inlineAlert value={l.counted ?? ""} onChange={(e) => setCounted(l, e.target.value)} />
                    </Field>
                  ) : (
                    <Field label={onlyRemove ? t("Qty removed", "Qté retirée") : onlyAdd ? t("Qty", "Qté") : t("Qty change (+/−)", "Variation (+/−)")} required>
                      <DecimalInput inputMode={signed ? "text" : wholeUnit(l.variant.unit) ? "numeric" : "decimal"} whole={wholeUnit(l.variant.unit)} measured={!wholeUnit(l.variant.unit)} inlineAlert value={l.qty} onChange={(e) => setQty(l, e.target.value)} />
                    </Field>
                  )}
                  {fixedCost && (
                    <div className="text-sm">
                      <p className="mb-1 text-xs text-muted-foreground">{t("Cost per unit", "Coût unitaire")}</p>
                      <p className="font-medium tabular">{variantUnitCost(l.variant)}</p>
                      <p className="text-xs text-muted-foreground">{t("Stock found goes in at its average cost; only the owner can change it.", "Le stock retrouvé entre à son coût moyen\u00a0; seul le propriétaire peut le changer.")}</p>
                    </div>
                  )}
                  {c.gt(0) && !fixedCost && (
                    <Field
                      label={t("Cost per unit ($)", "Coût unitaire ($)")}
                      hint={
                        needsCost
                          ? t("Required: no stock yet", "Obligatoire\u00a0: pas encore de stock")
                          : staffCost
                            ? t("Blank = what it cost when bought; only the owner can go more than 10% from it", "Vide = son coût d'achat\u00a0; seul le propriétaire peut s'en écarter de plus de 10\u00a0%")
                            : t("Blank = current average cost", "Vide = coût moyen actuel")
                      }
                      required={needsCost}
                    >
                      <Input inputMode="decimal" usd value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} className={cn(needsCost && !l.unitCost.trim() && "border-destructive")} />
                    </Field>
                  )}
                  {byCount && isQty(l.counted ?? "") && c.isZero() && (
                    <div className="flex items-end pb-2 text-sm text-muted-foreground">{t("Matches the stock", "Conforme au stock")}</div>
                  )}
                  {!c.isZero() && (
                    <div className="flex items-end pb-2 text-sm">
                      <span className={c.lt(0) ? "text-destructive" : "text-green-800 dark:text-green-400"}>
                        {byCount ? `${t("Difference", "Écart")} ` : ""}{c.gt(0) ? "+" : ""}{qtyWithUnit(t, c.toString(), l.variant.unit)} · ≈ {usd(valueOf(l).toFixed(2))}
                      </span>
                    </div>
                  )}
                </div>
                {l.variant.tracksSerials && c.gt(0) && l.serials.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("Chassis numbers (can be entered later in Motorcycles; a bike cannot be sold without one).", "Numéros de châssis (peuvent être saisis plus tard dans Motos\u00a0; une moto ne peut pas être vendue sans).")}
                    </p>
                    {l.serials.map((s, i) => (
                      <div key={i} className="grid grid-cols-[24px_1fr] gap-2 sm:grid-cols-[24px_1fr_1fr_140px]">
                        <span className="pt-2 text-xs text-muted-foreground">{i + 1}.</span>
                        <Input className="font-mono uppercase" placeholder={t("Chassis no.", "N° de châssis")} value={s.chassisNo} onChange={(e) => update(l.key, { serials: l.serials.map((x, j) => (j === i ? { ...x, chassisNo: e.target.value } : x)) })} />
                        <Input className="col-start-2 font-mono uppercase sm:col-start-auto" placeholder={t("Engine no.", "N° de moteur")} value={s.engineNo} onChange={(e) => update(l.key, { serials: l.serials.map((x, j) => (j === i ? { ...x, engineNo: e.target.value } : x)) })} />
                        <Input className="col-start-2 sm:col-start-auto" placeholder={t("Colour", "Couleur")} value={s.color} onChange={(e) => update(l.key, { serials: l.serials.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })} />
                      </div>
                    ))}
                  </div>
                )}
                {l.variant.tracksSerials && c.lt(0) && locationId && (
                  <UnitPicker variantId={l.variant.id} locationId={locationId} needed={c.abs().toNumber()} value={l.unitIds} onChange={(ids) => update(l.key, { unitIds: ids })} />
                )}
              </div>
            );
          })}
          {lines.length > 0 && (
            <p className="text-right text-sm">
              {t("Estimated value change:", "Variation de valeur estimée\u00a0:")} <span className="font-semibold">{usd(totalChange.toFixed(2))}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {error && <ErrorText error={error} />}
      {!readOnly && (
        <div className="flex flex-wrap justify-end gap-2">
          {onSaveDraft && (
            <Button variant="outline" disabled={savingDraft || lines.length === 0} onClick={() => onSaveDraft({ date: dateValue, memo: reason.trim() || null, payload: draftPayload() })}>
              {t("Save as pending", "Mettre en attente")}
            </Button>
          )}
          <SubmitButton onClick={submit} blocked={lines.length === 0 && t("Add at least one item", "Ajoutez au moins un article")} pending={m.isPending}>{t("Save adjustment", "Enregistrer l'ajustement")}</SubmitButton>
        </div>
      )}
      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{found.gt(0) && lost.gt(0)
                ? t(`Book ${usd(found.toFixed(2))} of stock found and ${usd(lost.toFixed(2))} lost?`, `Passer ${usd(found.toFixed(2))} de stock retrouvé et ${usd(lost.toFixed(2))} de stock perdu\u00a0?`)
                : totalChange.isNegative() ? t(`Book a stock loss of ${usd(lost.minus(found).toFixed(2))}?`, `Passer une perte de stock de ${usd(lost.minus(found).toFixed(2))}\u00a0?`) : t(`Book a stock gain of ${usd(totalChange.toFixed(2))}?`, `Passer un gain de stock de ${usd(totalChange.toFixed(2))}\u00a0?`)}</DialogTitle>
              <DialogDescription>
                {t("It changes the gross profit both partners share at month close. Check the quantities before saving.", "Cela modifie la marge brute partagée par les deux associés à la clôture du mois. Vérifiez les quantités avant d'enregistrer.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <div className="flex justify-between"><span>{t("Stock found", "Stock retrouvé")}</span><Num className="text-green-800 dark:text-green-400">+{usd(found.toFixed(2))}</Num></div>
              <div className="flex justify-between"><span>{t("Stock lost", "Stock perdu")}</span><Num className="text-destructive">−{usd(lost.toFixed(2))}</Num></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><span>{t("Net", "Net")}</span><Num className={totalChange.isNegative() ? "text-destructive" : "text-green-800 dark:text-green-400"}>{usd(totalChange.toFixed(2))}</Num></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>{t("Back to the count", "Revenir au comptage")}</Button>
              <SubmitButton
                variant={totalChange.isNegative() ? "destructive" : "default"}
                pending={m.isPending}
                onClick={() => m.mutate(confirming, { onSettled: () => setConfirming(null) })}
              >
                {t("Save adjustment", "Enregistrer l'ajustement")}
              </SubmitButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** A stock count whose stock found or stock lost is worth this much (in dollars) asks for confirmation before it is saved. */
const CONFIRM_ABOVE_USD = 100;

function UnitPicker({ variantId, locationId, needed, value, onChange }: { variantId: number; locationId: number; needed: number; value: number[]; onChange: (ids: number[]) => void }) {
  const t = useT();
  const q = useQuery<MotorcycleUnit[]>({ queryKey: ["/api/units", { variantId, locationId, status: "in_stock" }] });
  const units = q.data ?? [];
  return (
    <div className="mt-3 space-y-2">
      <p className={cn("text-xs", value.length === needed ? "text-muted-foreground" : "text-destructive")}>
        {t(`Pick the motorcycles: ${value.length} of ${needed} selected.`, `Choisissez les motos\u00a0: ${value.length} sur ${needed} ${value.length < 2 ? "sélectionnée" : "sélectionnées"}.`)}
      </p>
      {q.isLoading ? (
        <Loading />
      ) : units.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No motorcycle of this variant in stock here.", "Aucune moto de cette variante en stock ici.")}</p>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {units.map((u) => {
            const checked = value.includes(u.id);
            return (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-sm hover:bg-muted">
                <Checkbox
                  checked={checked}
                  disabled={!checked && value.length >= needed}
                  onCheckedChange={(v) => onChange(v ? [...value, u.id] : value.filter((x) => x !== u.id))}
                />
                <span className="font-mono text-xs">{u.chassisNo ?? t("(no chassis no.)", "(sans n° de châssis)")}</span>
                <span className="text-xs text-muted-foreground">{[u.engineNo, u.color].filter(Boolean).join(" · ")}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ History

function AdjustmentHistory() {
  const t = useT();
  const sys = useSystemText();
  const q = useQuery<Adjustment[]>({ queryKey: ["/api/stock/adjustments"] });
  const { data: locations = [] } = useLocations();
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorText error={q.error} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <EmptyState title={t("No adjustments yet", "Aucun ajustement")} />;
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const signed = (v: string) => (d(v).gt(0) ? `+${usd(v)}` : d(v).lt(0) ? `−${usd(d(v).abs().toFixed(2))}` : usd(v));
  const tone = (v: string) => (d(v).gt(0) ? "text-green-800 dark:text-green-400" : d(v).lt(0) ? "text-destructive" : "");
  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>{t("Number", "Numéro")}</TableHead>
            <TableHead>{t("Date", "Date")}</TableHead>
            <TableHead>{t("Location", "Emplacement")}</TableHead>
            <TableHead>{t("Kind", "Type")}</TableHead>
            <TableHead>{t("Reason", "Motif")}</TableHead>
            <TableHead className="text-right">{t("Items", "Articles")}</TableHead>
            <TableHead className="text-right">{t("Value", "Valeur")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a) => {
            const lines = a.lines ?? [];
            const expanded = open.has(a.id);
            return (
              <Fragment key={a.id}>
                <TableRow className={cn(lines.length > 0 && "cursor-pointer")} onClick={() => lines.length > 0 && toggle(a.id)}>
                  <TableCell className="px-2">
                    {lines.length > 0 && (
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-expanded={expanded} aria-label={expanded ? t("Hide items", "Masquer les articles") : t("Show items", "Voir les articles")}>
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{a.number}</TableCell>
                  <TableCell className="whitespace-nowrap">{date(a.date)}</TableCell>
                  <TableCell className="whitespace-nowrap">{a.locationName ?? locations.find((l) => l.id === a.locationId)?.name ?? `#${a.locationId}`}</TableCell>
                  <TableCell><Badge variant={a.kind === "opening" ? "default" : a.kind === "damage" || a.kind === "loss" ? "destructive" : "outline"}>{kindLabel(t, a.kind)}</Badge></TableCell>
                  <TableCell className="max-w-[320px] truncate" title={sys.memo(a.reason)}>{sys.memo(a.reason)}</TableCell>
                  <TableCell className="text-right"><Num>{lines.length}</Num></TableCell>
                  <TableCell className="text-right">{a.value !== undefined && <Num className={cn("font-medium", tone(a.value))}>{signed(a.value)}</Num>}</TableCell>
                </TableRow>
                {expanded && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell />
                    <TableCell colSpan={7} className="py-2">
                      <div className="divide-y text-sm">
                        {lines.map((l, i) => (
                          <div key={`${l.variantId}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                            <span className="min-w-0">
                              <span className="font-medium">{l.productName}</span> <span className="text-muted-foreground">{variantText(l.attributes)}</span>
                              <span className="ml-2 font-mono text-xs text-muted-foreground">{l.sku}</span>
                            </span>
                            <span className="flex gap-4">
                              <Num className={tone(l.qty)}>{d(l.qty).gt(0) ? "+" : ""}{qty(l.qty)}</Num>
                              <Num className={cn("w-24 text-right", tone(l.value))}>{signed(l.value)}</Num>
                            </span>
                          </div>
                        ))}
                        {a.value !== undefined && (
                          <div className="flex justify-between gap-4 py-1.5 font-medium">
                            <span>{t("Total value change", "Variation de valeur totale")}</span>
                            <Num className={cn("w-24 text-right", tone(a.value))}>{signed(a.value)}</Num>
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// ------------------------------------------------------------------ Transfer

interface TransferLine {
  variant: VariantRow;
  qty: string;
  unitIds: number[];
}

function TransferForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { data: locations = [] } = useLocations();
  const active = locations.filter((l) => l.active);
  const [dateValue, setDateValue] = useState(todayLocal());
  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<TransferLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const m = useApiMutation("POST", "/api/stock/transfers", {
    success: t("Stock transferred", "Stock transféré"),
    onSuccess: () => { setLines([]); setNote(""); onDone(); },
  });

  useEffect(() => {
    if (fromId && (!toId || toId === fromId)) {
      const other = active.find((l) => l.id !== fromId);
      if (other) setToId(other.id);
    }
  }, [fromId, toId, active]);
  // Quantities shown are for the source location; reset the list when it changes.
  useEffect(() => setLines([]), [fromId]);

  function submit() {
    setError(null);
    if (!fromId || !toId || fromId === toId) return setError(t("Pick two different locations.", "Choisissez deux emplacements différents."));
    if (lines.length === 0) return setError(t("Add at least one item.", "Ajoutez au moins un article."));
    for (const l of lines) {
      const unclear = unclearQty(t, l.qty);
      if (unclear) return setError(`${unclear} (${l.variant.productName})`);
      if (!isPositive(l.qty)) return setError(t(`Enter a quantity for ${l.variant.productName}.`, `Saisissez une quantité pour ${l.variant.productName}.`));
      if (d(l.qty).gt(d(l.variant.locationQty))) return setError(t(`Not enough ${l.variant.productName} at the source location.`, `Pas assez ${de(l.variant.productName)} à l'emplacement de départ.`));
      if (!d(l.qty).isInteger() && wholeUnit(l.variant.unit)) return setError(t(`${l.variant.productName} is counted in whole units: use a whole number.`, `${l.variant.productName} se compte à l'unité\u00a0: saisissez un nombre entier.`));
      if (l.variant.tracksSerials) {
        if (!d(l.qty).isInteger()) return setError(t("Motorcycles must be whole units.", "Les motos doivent être en unités entières."));
        if (l.unitIds.length !== d(l.qty).toNumber()) return setError(t(`Pick exactly ${count(t, Number(l.qty), ["motorcycle", "motorcycles"], ["", ""])} of ${l.variant.productName} to move.`, `Choisissez exactement ${count(t, Number(l.qty), ["", ""], ["moto", "motos"])} ${de(l.variant.productName)} à déplacer.`));
      }
    }
    m.mutate({
      date: dateValue,
      fromLocationId: fromId,
      toLocationId: toId,
      note: note.trim() || undefined,
      lines: lines.map((l) => ({ variantId: l.variant.id, qty: d(l.qty).toString(), ...(l.variant.tracksSerials ? { unitIds: l.unitIds } : {}) })),
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Date", "Date")}><Input type="date" value={dateValue} onChange={(e) => setDateValue(e.target.value)} /></Field>
          <Field label={t("From", "De")} required><LocationSelect value={fromId} onChange={setFromId} /></Field>
          <Field label={t("To", "Vers")} required>
            <Select value={toId ? String(toId) : ""} onValueChange={(v) => setToId(Number(v))}>
              <SelectTrigger><SelectValue placeholder={t("Choose…", "Choisir…")} /></SelectTrigger>
              <SelectContent>
                {active.filter((l) => l.id !== fromId).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("Note", "Note")}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><ArrowRightLeft className="h-4 w-4" /> {t("Items to move", "Articles à déplacer")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("A transfer moves quantity only; the stock value does not change.", "Un transfert déplace seulement la quantité\u00a0; la valeur du stock ne change pas.")}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <VariantSearch
            locationId={fromId}
            onPick={(v) => {
              setError(null);
              if (!lines.some((l) => l.variant.id === v.id)) setLines([...lines, { variant: v, qty: "", unitIds: [] }]);
            }}
          />
          {lines.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Item", "Article")}</TableHead>
                    <TableHead className="text-right">{t("Available", "Disponible")}</TableHead>
                    <TableHead>{t("Qty", "Qté")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l, i) => (
                    <Fragment key={l.variant.id}>
                    <TableRow>
                      <TableCell>
                        <div className="font-medium">{l.variant.productName}{l.variant.label !== "Standard" ? ` · ${l.variant.label}` : ""}</div>
                        <div className="text-xs text-muted-foreground">{l.variant.sku}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right"><Num>{qtyWithUnit(t, l.variant.locationQty, l.variant.unit)}</Num></TableCell>
                      <TableCell><Input className="w-24" aria-label={t(`Quantity to transfer: ${l.variant.productName}`, `Quantité à transférer\u00a0: ${l.variant.productName}`)} inputMode={wholeUnit(l.variant.unit) ? "numeric" : "decimal"} whole={wholeUnit(l.variant.unit)} measured={!wholeUnit(l.variant.unit)} inlineAlert value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></TableCell>
                      <TableCell><Button variant="ghost" size="icon" aria-label={t("Remove", "Retirer")} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button></TableCell>
                    </TableRow>
                    {l.variant.tracksSerials && fromId && isPositive(l.qty) && (
                      <TableRow>
                        <TableCell colSpan={4}>
                          <UnitPicker variantId={l.variant.id} locationId={fromId} needed={d(l.qty).toNumber()} value={l.unitIds} onChange={(ids) => setLines(lines.map((x, j) => (j === i ? { ...x, unitIds: ids } : x)))} />
                        </TableCell>
                      </TableRow>
                    )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {error && <ErrorText error={error} />}
      <div className="flex justify-end">
        <SubmitButton onClick={submit} blocked={lines.length === 0 && t("Add at least one item to move", "Ajoutez au moins un article à déplacer")} pending={m.isPending}>{t("Transfer", "Transférer")}</SubmitButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Transfer history

interface TransferRow {
  id: number;
  date: string;
  qty: string;
  note: string | null;
  sku: string;
  productName: string;
  unit?: string;
  label: string;
  fromName: string;
  toName: string;
  username: string | null;
  /** Full name of who moved it, the login when none is set. */
  userName?: string | null;
}

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function TransferHistory({ multiLocation }: { multiLocation: boolean }) {
  const t = useT();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const ok = validDate(from) && validDate(to);
  const q = useQuery<TransferRow[]>({ queryKey: ["/api/stock/transfers", { from, to }], enabled: ok });
  const rows = q.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("From", "Du")}>
          <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t("To", "Au")}>
          <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No transfers in this period", "Aucun transfert sur cette période")}>
          {/* With one place there is nowhere to move stock to: say what makes this tab useful. */}
          {!multiLocation && t(
            "Transfers move stock from one location to another: add a second location (warehouse, second shop) in Settings › Locations.",
            "Les transferts déplacent le stock d'un emplacement à un autre\u00a0: ajoutez un second emplacement (dépôt, deuxième boutique) dans Paramètres › Emplacements.",
          )}
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Date", "Date")}</TableHead>
                <TableHead>{t("Item", "Article")}</TableHead>
                <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                <TableHead>{t("From → to", "De → vers")}</TableHead>
                <TableHead>{t("Note", "Note")}</TableHead>
                <TableHead>{t("User", "Utilisateur")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{date(r.date)}</TableCell>
                  <TableCell className="min-w-[180px]">
                    <div className="font-medium">{r.productName}{r.label && r.label !== "Standard" ? ` · ${r.label}` : ""}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.sku}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right"><Num>{qtyWithUnit(t, r.qty, r.unit)}</Num></TableCell>
                  <TableCell className="whitespace-nowrap">{r.fromName} <span className="text-muted-foreground">→</span> {r.toName}</TableCell>
                  <TableCell className="max-w-[260px] truncate" title={r.note ?? undefined}>{r.note || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.userName ?? r.username ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
