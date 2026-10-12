import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { AlertTriangle, Banknote, Minus, Plus, Printer, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, Field, Num, PageHeader } from "@/components/common";
import { LocationSelect, MoneyAccountSelect, PartySelect, VariantSearch, useMoneyAccounts, useRate } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { cdf, d, date as fmtDate, money, qty as fmtQty, todayLocal, usd, variantText } from "@/lib/format";
import type { Account, MotorcycleUnit, Party, Settings, VariantRow } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- Sale shapes (shared with SaleDetail)

export interface SaleLineFull {
  id: number;
  saleId: number;
  variantId: number;
  unitId: number | null;
  qty: string;
  unitPrice: string;
  lineDiscount: string;
  lineTotal: string;
  cogs?: string;
  returnedQty: string;
  sku: string;
  attributes: Record<string, string>;
  productName: string;
  chassisNo: string | null;
  engineNo: string | null;
}

export interface SalePaymentRow {
  id: number;
  saleId: number;
  accountId: number;
  currency: "USD" | "CDF";
  amountNative: string;
  rate: string | null;
  amountUsd: string;
}

export interface SaleReturnRow {
  id: number;
  number: string;
  saleId: number;
  date: string;
  total: string;
  cogs: string;
  refundAccountId: number | null;
  reason: string | null;
  createdAt: string;
}

export interface SaleFull {
  id: number;
  number: string;
  date: string;
  locationId: number;
  customerId: number | null;
  status: "completed" | "voided";
  subtotal: string;
  discount: string;
  total: string;
  paidUsd: string;
  creditUsd: string;
  cogs?: string;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  customer: Party | null;
  lines: SaleLineFull[];
  payments: SalePaymentRow[];
  returns: SaleReturnRow[];
}

const ROUND = Decimal.ROUND_HALF_UP;
const c2 = (x: Decimal) => x.toDecimalPlaces(2, ROUND);

// ---------------------------------------------------------------- Receipt (80mm thermal)

function ReceiptRow({ left, right, bold }: { left: React.ReactNode; right: React.ReactNode; bold?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-2", bold && "font-bold")}>
      <span className="min-w-0">{left}</span>
      <span className="shrink-0 text-right tabular">{right}</span>
    </div>
  );
}

/** The receipt body. Plain black on white so it prints well on thermal paper. */
export function SaleReceipt({ sale }: { sale: SaleFull }) {
  const t = useT();
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] }).data;
  const accounts = useQuery<Account[]>({ queryKey: ["/api/accounts"] }).data ?? [];
  const accName = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  const gross = sale.lines.reduce((s, l) => s.plus(c2(d(l.qty).times(l.unitPrice))), d(0));
  const discount = gross.minus(sale.total);
  const time = sale.createdAt ? new Date(sale.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
  const dash = <div className="my-1.5 border-t border-dashed border-black" />;
  return (
    <div className="mx-auto w-full max-w-[80mm] bg-white p-2 font-mono text-[11px] leading-snug text-black">
      <div className="text-center">
        <p className="text-sm font-bold uppercase">{settings?.shopName || "Huanghe Kalemie"}</p>
        <p>{t("Sales receipt", "Reçu de vente")}</p>
      </div>
      {dash}
      <ReceiptRow left={t("No.", "N°")} right={sale.number} />
      <ReceiptRow left={t("Date", "Date")} right={`${fmtDate(sale.date)} ${time}`} />
      {sale.customer && <ReceiptRow left={t("Customer", "Client")} right={sale.customer.name} />}
      {sale.status === "voided" && <p className="mt-1 text-center font-bold">*** {t("CANCELLED", "ANNULÉE")} ***</p>}
      {dash}
      {sale.lines.map((l) => {
        const label = variantText(l.attributes);
        return (
          <div key={l.id} className="mb-1">
            <p className="font-semibold">{l.productName}{label ? ` ${label}` : ""}</p>
            {l.chassisNo && <p>{t("Chassis", "Châssis")}: {l.chassisNo}{l.engineNo ? ` · ${t("Engine", "Moteur")}: ${l.engineNo}` : ""}</p>}
            <ReceiptRow left={`${fmtQty(l.qty)} x ${usd(l.unitPrice)}`} right={usd(c2(d(l.qty).times(l.unitPrice)).toFixed(2))} />
          </div>
        );
      })}
      {dash}
      {discount.gt(0) && (
        <>
          <ReceiptRow left={t("Subtotal", "Sous-total")} right={usd(gross.toFixed(2))} />
          <ReceiptRow left={t("Discount", "Remise")} right={`-${usd(discount.toFixed(2))}`} />
        </>
      )}
      <ReceiptRow bold left={t("TOTAL", "TOTAL")} right={usd(sale.total)} />
      {sale.payments.length > 0 && dash}
      {sale.payments.map((p) => (
        <ReceiptRow
          key={p.id}
          left={accName(p.accountId)}
          right={p.currency === "CDF" ? `${cdf(p.amountNative)} (${usd(p.amountUsd)})` : usd(p.amountUsd)}
        />
      ))}
      {sale.payments.length > 0 && <ReceiptRow left={t("Paid", "Payé")} right={usd(sale.paidUsd)} />}
      {d(sale.creditUsd).gt(0) && <ReceiptRow bold left={t("On credit (to pay)", "À crédit (reste à payer)")} right={usd(sale.creditUsd)} />}
      {sale.payments.some((p) => p.currency === "CDF") && (
        <p className="mt-1">{t("Rate", "Taux")}: 1 USD = {fmtQty(sale.payments.find((p) => p.currency === "CDF")?.rate)} FC</p>
      )}
      {sale.note && <p className="mt-1">{sale.note}</p>}
      {dash}
      <p className="whitespace-pre-line text-center">{settings?.receiptFooter || t("Thank you for your purchase!", "Merci pour votre achat !")}</p>
    </div>
  );
}

/** Receipt preview plus a hidden copy at the document root that is the only thing printed. */
export function ReceiptDialog({ sale, onClose, extraAction }: { sale: SaleFull; onClose: () => void; extraAction?: React.ReactNode }) {
  const t = useT();
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] max-w-sm overflow-y-auto">
          <DialogHeader><DialogTitle>{t("Receipt", "Reçu")} {sale.number}</DialogTitle></DialogHeader>
          <div className="rounded-md border bg-white p-1">
            <SaleReceipt sale={sale} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => window.print()}><Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}</Button>
            {extraAction}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {createPortal(
        <div className="print-area hidden print:block">
          <SaleReceipt sale={sale} />
        </div>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------- Cart

interface CartLine {
  key: number;
  variant: VariantRow;
  unitId: number | null;
  qty: string;
  unitPrice: string;
  lineDiscount: string;
}

interface PayRow {
  key: number;
  accountId: number | null;
  amount: string;
  /** null = use the day's rate. */
  rate: string | null;
}

interface SaleBody {
  date?: string;
  locationId: number;
  customerId?: number | null;
  discount?: string;
  note?: string | null;
  lines: { variantId: number; unitId?: number | null; qty: string; unitPrice: string; lineDiscount?: string }[];
  payments: { accountId: number; amount: string; rate?: string }[];
}

function ChassisPicker({ line, locationId, takenUnitIds, onChange }: { line: CartLine; locationId: number | null; takenUnitIds: Set<number>; onChange: (unitId: number | null) => void }) {
  const t = useT();
  const q = useQuery<MotorcycleUnit[]>({
    queryKey: ["/api/units", { variantId: line.variant.id, status: "in_stock", locationId: locationId ?? undefined }],
    enabled: !!locationId,
  });
  // Sellable bikes first; the ones still missing a chassis number at the bottom.
  const units = [...(q.data ?? [])].sort((a, b) => Number(!a.chassisNo) - Number(!b.chassisNo) || a.id - b.id);
  const missingChassis = units.filter((u) => !u.chassisNo).length;
  return (
    <div className="space-y-1">
      <Select value={line.unitId ? String(line.unitId) : ""} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className={cn(!line.unitId && "border-amber-500")}>
          <SelectValue placeholder={t("Choose the chassis number", "Choisir le numéro de châssis")} />
        </SelectTrigger>
        <SelectContent>
          {units.map((u) => {
            const taken = takenUnitIds.has(u.id) && u.id !== line.unitId;
            return (
              <SelectItem key={u.id} value={String(u.id)} disabled={!u.chassisNo || taken}>
                {u.chassisNo
                  ? `${u.chassisNo}${u.engineNo ? ` · ${t("engine", "moteur")} ${u.engineNo}` : ""}${u.color ? ` · ${u.color}` : ""}${taken ? ` (${t("already on this sale", "déjà sur cette vente")})` : ""}`
                  : `#${u.id} · ${t("no chassis number yet", "pas encore de numéro de châssis")}`}
              </SelectItem>
            );
          })}
          {units.length === 0 && (
            <div className="px-2 py-2 text-sm text-muted-foreground">{q.isLoading ? "…" : t("No motorcycle of this model in stock here", "Aucune moto de ce modèle en stock ici")}</div>
          )}
        </SelectContent>
      </Select>
      {missingChassis > 0 && (
        <p className="text-xs text-muted-foreground">
          {t(
            `${missingChassis} unit(s) have no chassis number: a manager must enter it on the Motorcycles page before they can be sold.`,
            `${missingChassis} moto(s) sans numéro de châssis : un gérant doit le saisir dans la page Motos avant de pouvoir les vendre.`,
          )}
        </p>
      )}
    </div>
  );
}

export default function POS() {
  const t = useT();
  const { can } = useAuth();
  const today = todayLocal();
  // Managers can enter a past sale (from the paper book after a power cut); cashiers sell today.
  const [saleDate, setSaleDate] = useState(today);
  const backDated = saleDate !== today;
  const [locationId, setLocationId] = useState<number | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState("");
  const [customer, setCustomer] = useState<Party | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [pays, setPays] = useState<PayRow[]>([]);
  const [handed, setHanded] = useState("");
  const [handedCur, setHandedCur] = useState<"USD" | "CDF">("USD");
  const [receipt, setReceipt] = useState<SaleFull | null>(null);
  const keyRef = useRef(1);
  const searchBox = useRef<HTMLDivElement>(null);

  const { data: moneyAccounts } = useMoneyAccounts();
  const rateQ = useRate(saleDate);
  const dayRate = rateQ.data?.cdfPerUsd ?? "";
  const accById = useCallback((id: number | null) => moneyAccounts.find((a) => a.id === id), [moneyAccounts]);

  // Changing location: the chosen motorcycles are at the old location, so pick again.
  const prevLocation = useRef<number | null>(null);
  useEffect(() => {
    if (prevLocation.current !== null && prevLocation.current !== locationId) setLines((ls) => ls.map((l) => ({ ...l, unitId: null })));
    prevLocation.current = locationId;
  }, [locationId]);

  // Live stock at the chosen location for every item in the cart.
  const variantIds = useMemo(() => Array.from(new Set(lines.map((l) => l.variant.id))).sort((a, b) => a - b), [lines]);
  const stockQ = useQuery<VariantRow[]>({
    queryKey: ["/api/variants", { ids: variantIds.join(","), locationId: locationId ?? undefined, limit: 500 }],
    enabled: variantIds.length > 0 && !!locationId,
  });
  const available = (variantId: number, fallback: string) => d(stockQ.data?.find((v) => v.id === variantId)?.locationQty ?? fallback);
  const qtyInCart = (variantId: number) => lines.filter((l) => l.variant.id === variantId).reduce((s, l) => s.plus(d(l.qty)), d(0));

  function addVariant(v: VariantRow) {
    setLines((ls) => {
      if (!v.tracksSerials) {
        const existing = ls.find((l) => l.variant.id === v.id);
        if (existing) return ls.map((l) => (l === existing ? { ...l, qty: d(l.qty).plus(1).toString() } : l));
      }
      return [...ls, { key: keyRef.current++, variant: v, unitId: null, qty: "1", unitPrice: d(v.sellPrice).toFixed(2), lineDiscount: "" }];
    });
  }
  const updateLine = (key: number, patch: Partial<CartLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));

  // ---- totals (exact decimals)
  const lineAmount = (l: CartLine) => c2(d(l.qty).times(d(l.unitPrice))).minus(c2(d(l.lineDiscount)));
  const subtotal = lines.reduce((s, l) => s.plus(lineAmount(l)), d(0));
  const saleDiscount = c2(d(discount));
  const total = subtotal.minus(saleDiscount);

  const payUsd = (p: PayRow) => {
    const acc = accById(p.accountId);
    if (!acc) return d(0);
    const amount = c2(d(p.amount));
    if (acc.currency === "CDF") {
      const r = d(p.rate ?? dayRate);
      return r.gt(0) ? c2(amount.dividedBy(r)) : d(0);
    }
    return amount;
  };
  const paid = pays.reduce((s, p) => s.plus(payUsd(p)), d(0));
  const remaining = total.minus(paid);
  const overpaid = remaining.lt(d("-0.10"));
  const credit = remaining.gt(0) ? remaining : d(0);
  const rateNum = d(dayRate);

  const takenUnitIds = useMemo(() => new Set(lines.map((l) => l.unitId).filter((x): x is number => !!x)), [lines]);

  // ---- validation
  const problems: string[] = [];
  if (!locationId) problems.push(t("Choose the location", "Choisir le lieu"));
  if (lines.length === 0) problems.push(t("Add at least one item", "Ajouter au moins un article"));
  for (const l of lines) {
    if (d(l.qty).lte(0)) problems.push(t(`Quantity of ${l.variant.productName} must be more than zero`, `La quantité de ${l.variant.productName} doit être supérieure à zéro`));
    if (lineAmount(l).lt(0)) problems.push(t(`The discount on ${l.variant.productName} is bigger than the line`, `La remise sur ${l.variant.productName} dépasse la ligne`));
    if (l.variant.tracksSerials && !l.unitId) problems.push(t(`Choose the chassis number for ${l.variant.productName}`, `Choisir le numéro de châssis pour ${l.variant.productName}`));
  }
  if (saleDiscount.lt(0) || saleDiscount.gt(subtotal)) problems.push(t("The sale discount is bigger than the sale", "La remise dépasse le montant de la vente"));
  for (const p of pays) {
    const acc = accById(p.accountId);
    if (!acc && d(p.amount).gt(0)) problems.push(t("Choose the account for each payment", "Choisir le compte pour chaque paiement"));
    if (acc && d(p.amount).lte(0)) problems.push(t("Each payment needs an amount", "Chaque paiement doit avoir un montant"));
    if (acc?.currency === "CDF" && d(p.rate ?? dayRate).lte(0)) problems.push(t("Enter the exchange rate for CDF payments", "Saisir le taux pour les paiements en CDF"));
  }
  if (overpaid) problems.push(t("Payments are more than the total. Enter only the money kept, not the change.", "Les paiements dépassent le total. Saisir seulement l'argent gardé, pas la monnaie rendue."));
  if (credit.gt(0) && !customerId) problems.push(t("Choose a customer to sell the rest on credit", "Choisir un client pour vendre le reste à crédit"));
  const valid = problems.length === 0;

  // ---- payments helpers
  function findCash(currency: "USD" | "CDF") {
    return moneyAccounts.find((a) => a.systemKey === (currency === "USD" ? "cash_usd" : "cash_cdf")) ?? moneyAccounts.find((a) => a.currency === currency);
  }
  function payAllIn(currency: "USD" | "CDF") {
    const acc = findCash(currency);
    if (!acc) return;
    const kept = pays.filter((p) => p.accountId && d(p.amount).gt(0));
    const rest = total.minus(kept.reduce((s, p) => s.plus(payUsd(p)), d(0)));
    if (rest.lte(0)) return setPays(kept);
    const amount = currency === "CDF" ? rest.times(rateNum).toDecimalPlaces(0, ROUND).toFixed(2) : rest.toFixed(2);
    setPays([...kept, { key: keyRef.current++, accountId: acc.id, amount, rate: null }]);
  }
  const updatePay = (key: number, patch: Partial<PayRow>) => setPays((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  // ---- change calculator (helper only)
  const toPay = paid.gt(0) ? paid : total;
  const handedUsd = handedCur === "CDF" ? (rateNum.gt(0) ? d(handed).dividedBy(rateNum) : d(0)) : d(handed);
  const change = handedUsd.minus(toPay);

  // ---- submit
  function reset() {
    setLines([]);
    setDiscount("");
    setCustomer(null);
    setCustomerId(null);
    setNote("");
    setPays([]);
    setHanded("");
  }
  const mutation = useApiMutation<SaleBody, SaleFull>("POST", "/api/sales", {
    success: t("Sale recorded", "Vente enregistrée"),
    onSuccess: (sale) => {
      setReceipt(sale);
      reset();
    },
  });
  function submit() {
    if (!valid || mutation.isPending || !locationId) return;
    mutation.mutate({
      date: backDated ? saleDate : undefined,
      locationId,
      customerId: customerId ?? null,
      discount: saleDiscount.gt(0) ? saleDiscount.toFixed(2) : undefined,
      note: note.trim() || null,
      lines: lines.map((l) => ({
        variantId: l.variant.id,
        unitId: l.variant.tracksSerials ? l.unitId : undefined,
        qty: d(l.qty).toString(),
        unitPrice: c2(d(l.unitPrice)).toFixed(2),
        lineDiscount: c2(d(l.lineDiscount)).gt(0) ? c2(d(l.lineDiscount)).toFixed(2) : undefined,
      })),
      payments: pays
        .filter((p) => p.accountId && d(p.amount).gt(0))
        .map((p) => {
          const acc = accById(p.accountId)!;
          return { accountId: acc.id, amount: c2(d(p.amount)).toFixed(2), ...(acc.currency === "CDF" ? { rate: d(p.rate ?? dayRate).toString() } : {}) };
        }),
    });
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const receiptOpen = !!receipt;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (receiptOpen) return;
      if (e.key === "F9" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receiptOpen]);

  function newSale() {
    setReceipt(null);
    setTimeout(() => searchBox.current?.querySelector("input")?.focus(), 50);
  }

  return (
    <div>
      <PageHeader
        title={t("Point of sale", "Caisse")}
        description={t("Scan or search items, take payment, print the receipt. F9 or Ctrl+Enter to finish.", "Scanner ou chercher les articles, encaisser, imprimer le reçu. F9 ou Ctrl+Entrée pour valider.")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can("manager") && (
              <Input
                type="date"
                className={cn("w-40", backDated && "border-amber-500 text-amber-700 dark:text-amber-400")}
                value={saleDate}
                max={today}
                onChange={(e) => setSaleDate(e.target.value || today)}
                aria-label={t("Sale date", "Date de la vente")}
                title={t("Sale date", "Date de la vente")}
              />
            )}
            <div className="w-48">
              <LocationSelect value={locationId} onChange={setLocationId} />
            </div>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------------- Cart */}
        <div className="space-y-4">
          <div ref={searchBox}>
            <VariantSearch autoFocus locationId={locationId} onPick={addVariant} />
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><ShoppingCart className="h-4 w-4" /> {t("Cart", "Panier")} ({lines.length})</CardTitle>
              {lines.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setLines([])}>{t("Clear", "Vider")}</Button>
              )}
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {lines.length === 0 ? (
                <EmptyState title={t("The cart is empty", "Le panier est vide")}>{t("Scan a barcode or type a name, size or SKU above.", "Scannez un code-barres ou tapez un nom, une taille ou un code ci-dessus.")}</EmptyState>
              ) : (
                <div className="divide-y">
                  {lines.map((l) => {
                    const avail = available(l.variant.id, l.variant.locationQty);
                    const short = qtyInCart(l.variant.id).gt(avail);
                    return (
                      <div key={l.key} className="space-y-2 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{l.variant.productName}{l.variant.label !== "Standard" ? ` · ${l.variant.label}` : ""}</p>
                            <p className="text-xs text-muted-foreground">
                              {l.variant.sku} · {t("in stock here", "en stock ici")}: <span className={cn(short && "font-semibold text-destructive")}>{fmtQty(avail.toString())}</span>
                            </p>
                            {short && (
                              <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                                <AlertTriangle className="h-3 w-3" /> {t("More than the stock available at this location", "Plus que le stock disponible à ce lieu")}
                              </p>
                            )}
                          </div>
                          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => removeLine(l.key)} aria-label={t("Remove", "Retirer")}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        {l.variant.tracksSerials && (
                          <ChassisPicker line={l} locationId={locationId} takenUnitIds={takenUnitIds} onChange={(unitId) => updateLine(l.key, { unitId })} />
                        )}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div>
                            <p className="mb-1 text-xs text-muted-foreground">{t("Qty", "Qté")}</p>
                            {l.variant.tracksSerials ? (
                              <Input value="1" disabled className="h-9" />
                            ) : (
                              <div className="flex items-center gap-1">
                                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => updateLine(l.key, { qty: Decimal.max(d(l.qty).minus(1), 1).toString() })}><Minus className="h-3 w-3" /></Button>
                                <Input className="h-9 min-w-0 text-center" inputMode="decimal" value={l.qty} onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => updateLine(l.key, { qty: d(l.qty).plus(1).toString() })}><Plus className="h-3 w-3" /></Button>
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-muted-foreground">{t("Unit price $", "Prix unitaire $")}</p>
                            <Input className="h-9" inputMode="decimal" value={l.unitPrice} onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })} />
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-muted-foreground">{t("Discount $", "Remise $")}</p>
                            <Input className="h-9" inputMode="decimal" placeholder="0" value={l.lineDiscount} onChange={(e) => updateLine(l.key, { lineDiscount: e.target.value })} />
                          </div>
                          <div className="text-right">
                            <p className="mb-1 text-xs text-muted-foreground">{t("Line total", "Total ligne")}</p>
                            <p className={cn("pt-1.5 font-semibold", lineAmount(l).lt(0) && "text-destructive")}><Num>{usd(lineAmount(l).toFixed(2))}</Num></p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
              <Field label={t("Customer (optional, required for credit)", "Client (facultatif, obligatoire pour le crédit)")}>
                <PartySelect types={["customer"]} value={customerId} onChange={(id, p) => { setCustomerId(id); setCustomer(p ?? null); }} placeholder={t("Walk-in customer", "Client de passage")} />
                {customer && d(customer.balance).gt(0) && (
                  <p className="text-xs text-amber-600">{t("Already owes", "Doit déjà")} {usd(customer.balance)}</p>
                )}
              </Field>
              <Field label={t("Sale discount $", "Remise sur la vente $")}>
                <Input inputMode="decimal" placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </Field>
              <Field label={t("Note", "Note")} className="sm:col-span-2">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </CardContent>
          </Card>
        </div>

        {/* ---------------- Payment */}
        <div className="space-y-4">
          <Card className="lg:sticky lg:top-4">
            <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Payment", "Paiement")}</CardTitle></CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div className="rounded-lg bg-muted p-3">
                <div className="flex justify-between text-sm text-muted-foreground"><span>{t("Subtotal", "Sous-total")}</span><Num>{usd(subtotal.toFixed(2))}</Num></div>
                {saleDiscount.gt(0) && <div className="flex justify-between text-sm text-muted-foreground"><span>{t("Discount", "Remise")}</span><Num>-{usd(saleDiscount.toFixed(2))}</Num></div>}
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{t("Total", "Total")}</span>
                  <span className="text-3xl font-bold tabular">{usd(total.toFixed(2))}</span>
                </div>
                {rateNum.gt(0) && <p className="text-right text-xs text-muted-foreground">≈ {cdf(total.times(rateNum).toDecimalPlaces(0, ROUND).toString())} · 1 USD = {fmtQty(dayRate)} FC</p>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" size="sm" onClick={() => payAllIn("USD")} disabled={total.lte(0) || !findCash("USD")}>
                  <Banknote className="mr-1 h-4 w-4" /> {t("All in USD cash", "Tout en cash USD")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => payAllIn("CDF")} disabled={total.lte(0) || !findCash("CDF") || rateNum.lte(0)}>
                  <Banknote className="mr-1 h-4 w-4" /> {t("All in CDF cash", "Tout en cash CDF")}
                </Button>
              </div>

              {pays.map((p) => {
                const acc = accById(p.accountId);
                return (
                  <div key={p.key} className="space-y-2 rounded-md border p-2">
                    <div className="flex gap-2">
                      <div className="min-w-0 flex-1">
                        <MoneyAccountSelect value={p.accountId} onChange={(id) => updatePay(p.key, { accountId: id })} />
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => setPays((ps) => ps.filter((x) => x.key !== p.key))} aria-label={t("Remove", "Retirer")}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                    <div className={cn("grid gap-2", acc?.currency === "CDF" ? "grid-cols-2" : "grid-cols-1")}>
                      <Input inputMode="decimal" placeholder={acc?.currency === "CDF" ? t("Amount FC", "Montant FC") : t("Amount $", "Montant $")} value={p.amount} onChange={(e) => updatePay(p.key, { amount: e.target.value })} />
                      {acc?.currency === "CDF" && (
                        <Input inputMode="decimal" placeholder={t("Rate", "Taux")} value={p.rate ?? dayRate} onChange={(e) => updatePay(p.key, { rate: e.target.value })} title={t("CDF per 1 USD", "CDF pour 1 USD")} />
                      )}
                    </div>
                    {acc?.currency === "CDF" && (
                      <p className="text-xs text-muted-foreground">= {usd(payUsd(p).toFixed(2))} ({t("rate", "taux")} {fmtQty(p.rate ?? dayRate)} FC/USD)</p>
                    )}
                  </div>
                );
              })}
              <Button variant="outline" size="sm" className="w-full" onClick={() => setPays((ps) => [...ps, { key: keyRef.current++, accountId: findCash("USD")?.id ?? null, amount: remaining.gt(0) ? remaining.toFixed(2) : "", rate: null }])}>
                <Plus className="mr-1 h-4 w-4" /> {t("Add payment", "Ajouter un paiement")}
              </Button>

              <Separator />
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span>{t("Paid (USD)", "Payé (USD)")}</span><Num className="font-medium">{usd(paid.toFixed(2))}</Num></div>
                <div className="flex justify-between">
                  <span>{credit.gt(0) ? t("Remaining → on credit", "Reste → à crédit") : t("Remaining", "Reste")}</span>
                  <Num className={cn("font-semibold", credit.gt(0) && "text-amber-600", overpaid && "text-destructive")}>{usd(remaining.toFixed(2))}</Num>
                </div>
                {credit.gt(0) && !customerId && <p className="text-xs text-amber-600">{t("Choose a customer to sell on credit.", "Choisir un client pour vendre à crédit.")}</p>}
              </div>

              <details className="rounded-md border p-2 text-sm">
                <summary className="cursor-pointer select-none font-medium">{t("Change calculator", "Calcul de la monnaie")}</summary>
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-muted-foreground">{t("Only a helper: record the money kept above, not what the customer handed over.", "Seulement une aide : enregistrer ci-dessus l'argent gardé, pas ce que le client a donné.")}</p>
                  <div className="flex gap-2">
                    <Input inputMode="decimal" placeholder={t("Cash handed over", "Montant reçu")} value={handed} onChange={(e) => setHanded(e.target.value)} />
                    <Select value={handedCur} onValueChange={(v) => setHandedCur(v as "USD" | "CDF")}>
                      <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="CDF">CDF</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-between"><span>{t("To pay", "À payer")}</span><Num>{usd(toPay.toFixed(2))}{rateNum.gt(0) ? ` · ${cdf(toPay.times(rateNum).toDecimalPlaces(0, ROUND).toString())}` : ""}</Num></div>
                  {handed && (
                    <div className={cn("flex justify-between font-semibold", change.lt(0) && "text-destructive")}>
                      <span>{change.lt(0) ? t("Still missing", "Il manque") : t("Change to give", "Monnaie à rendre")}</span>
                      <Num>{usd(c2(change.abs()).toFixed(2))}{rateNum.gt(0) ? ` · ${cdf(change.abs().times(rateNum).toDecimalPlaces(0, ROUND).toString())}` : ""}</Num>
                    </div>
                  )}
                </div>
              </details>

              {!valid && lines.length > 0 && (
                <ul className="space-y-0.5 text-xs text-destructive">
                  {Array.from(new Set(problems)).map((p) => <li key={p}>• {p}</li>)}
                </ul>
              )}
              <Button className="h-12 w-full text-base" disabled={!valid || mutation.isPending} onClick={submit}>
                {mutation.isPending ? "…" : t(`Finish sale ${usd(total.toFixed(2))}`, `Valider la vente ${usd(total.toFixed(2))}`)}
              </Button>
              <p className="text-center text-xs text-muted-foreground">F9 / Ctrl+Entrée</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {receipt && (
        <ReceiptDialog
          sale={receipt}
          onClose={newSale}
          extraAction={<Button onClick={newSale}>{t("New sale", "Nouvelle vente")}</Button>}
        />
      )}
    </div>
  );
}

/** Small helper reused by SaleDetail: show a payment amount in its own currency. */
export function paymentText(p: SalePaymentRow) {
  return p.currency === "CDF" ? `${cdf(p.amountNative)} (${usd(p.amountUsd)})` : money(p.amountUsd, "USD");
}
