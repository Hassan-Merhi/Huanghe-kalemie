import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { de } from "@shared/french";
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
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { EmptyState, Field, Num, PageHeader, SubmitButton, unclearAmount } from "@/components/common";
import { LocationSelect, MoneyAccountSelect, PartySelect, RateInput, VariantSearch, useAccounts, useMoneyAccounts, useRate } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { cdf, curLabel, d, date as fmtDate, fcRounding, frenchPunctuation, MINUS, money, pct as fmtPct, qty as fmtQty, refusedUnit, todayLocal, typedNumberOk, unclearQty, usd, variantText } from "@/lib/format";
import { cartCount, unitLabel, wholeUnit } from "@/lib/units";
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
  unit?: string;
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
  lines?: { saleLineId: number; qty: string; amount: string }[];
  /** Money actually handed back: in the drawer's currency (francs for a franc drawer) and in dollars. */
  refundNative?: string | null;
  refundUsd?: string | null;
  refundCurrency?: "USD" | "CDF" | null;
  refundToBalanceUsd?: string;
  /** No refund account: the part that cleared the customer's debt, the rest went on their avoir. */
  offDebtUsd?: string | null;
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
  cashierName?: string | null;
  lines: SaleLineFull[];
  payments: SalePaymentRow[];
  returns: SaleReturnRow[];
  /** The franc rounding of the till alone and with the returns' refunds, + when the shop kept a few cents. */
  saleFcRoundingUsd?: string;
  fcRoundingUsd?: string;
  /** "Payé": the cash really kept, payments and refunds at their own rates; Payé − total = fcRoundingUsd. */
  paidKeptUsd?: string;
  /** The part of the credit the customer's avoir covered: after returns (at most the credit left), when the sale was made, and the avoir left then. */
  avoirUsedUsd?: string | null;
  avoirAtSaleUsd?: string | null;
  avoirLeftUsd?: string | null;
  /** Credit still on the sale after returns, however they were refunded. */
  creditLeftUsd?: string;
}

const ROUND = Decimal.ROUND_HALF_UP;
/** Francs over or under a sale that count as its rounding (as on the server). */
const FRANC_ROUNDING = new Decimal(100);
const c2 = (x: Decimal) => x.toDecimalPlaces(2, ROUND);

// ---------------------------------------------------------------- Receipt (80mm thermal)

/**
 * The receipt is set in a monospaced font, where the minus sign (U+2212) takes one cell and reads as a
 * hyphen ("-124 200 FC"): it is drawn in the text font, at its full width, like everywhere else.
 */
function withMinus(text: React.ReactNode): React.ReactNode {
  if (typeof text !== "string" || !text.includes(MINUS)) return text;
  return text.split(MINUS).map((part, i) => (i === 0 ? part : <Fragment key={i}><span className="font-sans">{MINUS}</span>{part}</Fragment>));
}

function ReceiptRow({ left, right, bold }: { left: React.ReactNode; right: React.ReactNode; bold?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-2", bold && "font-bold")}>
      <span className="min-w-0">{left}</span>
      <span className="shrink-0 text-right tabular">{withMinus(right)}</span>
    </div>
  );
}

/**
 * "Réglé sur l'avoir 11,00 $ · avoir restant 15 739,00 $": a credit sale to a customer who had paid ahead owes
 * nothing new; only what the avoir did not cover is still to pay.
 */
export function avoirSplit(sale: Pick<SaleFull, "creditUsd" | "avoirUsedUsd" | "avoirLeftUsd">) {
  const used = d(sale.avoirUsedUsd ?? 0);
  return { used, left: d(sale.avoirLeftUsd ?? 0), toPay: Decimal.max(d(sale.creditUsd).minus(used), 0) };
}

/** The receipt body. Plain black on white so it prints well on thermal paper. */
export function SaleReceipt({ sale }: { sale: SaleFull }) {
  const t = useT();
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] }).data;
  const accounts = useAccounts().data ?? [];
  // The customer reads "Cash", not the shop's account names.
  const accName = (id: number, currency: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a || a.systemKey === "cash_usd" || a.systemKey === "cash_cdf") return currency === "CDF" ? t("Cash FC", "Espèces FC") : t("Cash $", "Espèces $");
    return a.name;
  };
  const saleRate = useRate(sale.date).data?.cdfPerUsd;
  const cdfRate = sale.payments.find((p) => p.currency === "CDF")?.rate ?? saleRate ?? null;
  const gross = sale.lines.reduce((s, l) => s.plus(c2(d(l.qty).times(l.unitPrice))), d(0));
  const discount = gross.minus(sale.total);
  // Franc change goes in 100 FC steps, so the payment lines can miss what the sale counts as paid by a few
  // cents (35,61 − 8,62 for 27,00 $): the receipt shows that rounding as its own line, the till's own (the
  // returns come later, on their slips), signed as the books and the Sales list keep it.
  const paymentsUsd = sale.payments.reduce((s, p) => s.plus(d(p.amountUsd)), d(0));
  const keptUsd = sale.saleFcRoundingUsd !== undefined ? d(sale.saleFcRoundingUsd) : paymentsUsd.minus(sale.paidUsd);
  const paidInFrancs = sale.payments.some((p) => p.currency === "CDF");
  // The same rounding in francs, as the till showed it: what was handed over less what was counted as paid,
  // each franc payment at its own rate (16 FC, where 0,01 $ alone would not say how many francs). Shown even
  // when the dollars round to 0,00 $ (7 FC over), as the till did; never on a credit sale, which has none.
  const keptFc = paidInFrancs && !d(sale.creditUsd).gt(0) && cdfRate && d(cdfRate).gt(0)
    ? sale.payments
        .reduce((s, p) => s.plus(p.currency === "CDF" && d(p.rate ?? cdfRate).gt(0) ? d(p.amountNative).dividedBy(d(p.rate ?? cdfRate)) : d(p.amountUsd)), d(0))
        .minus(sale.paidUsd)
        .times(d(cdfRate))
        .toDecimalPlaces(0, ROUND)
    : null;
  const rounding = paidInFrancs ? fcRounding(t, keptUsd, keptFc) : null;
  // The receipt shows the sale as it was made, before any return.
  const avoir = avoirSplit({ ...sale, avoirUsedUsd: sale.avoirAtSaleUsd ?? sale.avoirUsedUsd });
  // The shop's clock (Kalemie), whatever time zone the phone or computer is set to.
  const time = sale.createdAt ? new Date(sale.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lubumbashi" }) : "";
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
      {sale.cashierName && <ReceiptRow left={t("Served by", "Servi par")} right={sale.cashierName} />}
      {sale.customer && <ReceiptRow left={t("Customer", "Client")} right={sale.customer.name} />}
      {sale.status === "voided" && <p className="mt-1 text-center font-bold">*** {t("CANCELLED", "ANNULÉE")} ***</p>}
      {dash}
      {sale.lines.map((l) => {
        const label = variantText(l.attributes);
        return (
          <div key={l.id} className="mb-1">
            <p className="font-semibold">{l.productName}{label ? ` ${label}` : ""}</p>
            {l.chassisNo && <p>{t("Chassis:", "Châssis\u00a0:")} {l.chassisNo}{l.engineNo ? ` · ${t("Engine:", "Moteur\u00a0:")} ${l.engineNo}` : ""}</p>}
            <ReceiptRow left={`${fmtQty(l.qty)}\u00a0×\u00a0${usd(l.unitPrice)}`} right={usd(c2(d(l.qty).times(l.unitPrice)).toFixed(2))} />
          </div>
        );
      })}
      {dash}
      {discount.gt(0) && (
        <>
          <ReceiptRow left={t("Subtotal", "Sous-total")} right={usd(gross.toFixed(2))} />
          <ReceiptRow left={t("Discount", "Remise")} right={`−${usd(discount.toFixed(2))}`} />
        </>
      )}
      <ReceiptRow bold left={t("TOTAL", "TOTAL")} right={usd(sale.total)} />
      {cdfRate && d(cdfRate).gt(0) && <ReceiptRow left="" right={`≈ ${cdf(d(sale.total).times(cdfRate).toDecimalPlaces(0, ROUND).toString())}`} />}
      {sale.payments.length > 0 && dash}
      {sale.payments.map((p) => (
        <ReceiptRow
          key={p.id}
          // On a narrow receipt the drawer goes under "Monnaie rendue" whole, never "FC)" alone under the amount.
          left={d(p.amountUsd).isNegative() ? <>{t("Change given", "Monnaie rendue")} <span className="whitespace-nowrap">({accName(p.accountId, p.currency)})</span></> : accName(p.accountId, p.currency)}
          right={p.currency === "CDF" ? `${cdf(p.amountNative)} (${usd(p.amountUsd)})` : usd(p.amountUsd)}
        />
      ))}
      {rounding && (
        <ReceiptRow
          left={<>{t("FC rounding", "Arrondi FC")} <span className="whitespace-nowrap">({rounding.words})</span></>}
          right={rounding.figure}
        />
      )}
      {/* The money really kept, as the till, the sale page and the Sales list say "Payé" (26,99 $ for 75 800 FC
          on 27,00 $): the payment lines above add up to it, and the rounding line explains the cents to the total. */}
      {sale.payments.length > 0 && <ReceiptRow left={t("Paid", "Payé")} right={usd(paymentsUsd.toFixed(2))} />}
      {/* Credit the customer's avoir covered is not owed: only the rest is "to pay". */}
      {avoir.used.gt(0) && (
        <>
          <ReceiptRow left={t("Settled from the customer's credit", "Réglé sur l'avoir")} right={usd(avoir.used.toFixed(2))} />
          <ReceiptRow left={t("Credit left", "Avoir restant")} right={usd(avoir.left.toFixed(2))} />
        </>
      )}
      {avoir.toPay.gt(0) && <ReceiptRow bold left={t("On credit (to pay)", "À crédit (reste à payer)")} right={usd(avoir.toPay.toFixed(2))} />}
      {cdfRate && d(cdfRate).gt(0) && (
        <p className="mt-1">{t("Rate", "Taux")}{"\u00a0"}: 1 $ = {fmtQty(cdfRate)} FC</p>
      )}
      {sale.note && <p className="mt-1">{sale.note}</p>}
      {dash}
      <p className="whitespace-pre-line text-center">{(settings?.receiptFooter && frenchPunctuation(settings.receiptFooter)) || t("Thank you for your purchase!", "Merci pour votre achat\u00a0!")}</p>
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
          {/* Paper preview: the receipt itself stays black on white in every theme. */}
          <div className="rounded-md border bg-muted p-3">
            <div className="mx-auto max-w-[80mm] shadow-sm ring-1 ring-black/5">
              <SaleReceipt sale={sale} />
            </div>
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
  change?: { accountId: number; amount: string; rate?: string } | null;
  /** The franc rate the till showed; the server refuses the sale if the day's rate has moved since. */
  tillRate?: string;
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
            `${missingChassis === 1 ? "1 unit has" : `${missingChassis} units have`} no chassis number: a manager must enter it on the Motorcycles page before they can be sold.`,
            `${missingChassis === 1 ? "1 moto" : `${missingChassis} motos`} sans numéro de châssis\u00a0: un gérant doit le saisir dans la page Motos avant de pouvoir les vendre.`,
          )}
        </p>
      )}
    </div>
  );
}

/** The server's limit on payment lines per sale (MAX_SALE_PAYMENTS). */
const MAX_PAYMENTS = 10;
/** Cash received above this many times the total is asked about before the sale is saved. */
const UNUSUAL_RECEIVED = 10;

export default function POS() {
  const t = useT();
  const { can, user } = useAuth();
  const shop = useQuery<Settings>({ queryKey: ["/api/settings"] }).data;
  // Same limit the server applies: the owner has none.
  const maxDiscountPct =
    !user || user.role === "owner" ? null : d(user.role === "manager" ? shop?.managerDiscountPct ?? "20" : shop?.cashierDiscountPct ?? "10");
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
  /** Change handed back from another drawer (francs taken, dollars given back). Empty amount: worked out. */
  const [changeAccId, setChangeAccId] = useState<number | null>(null);
  const [changeAmt, setChangeAmt] = useState("");
  /** "Tout rendre en francs" was pressed: the francs drawer was chosen on purpose, so no second question. */
  const [francsChosen, setFrancsChosen] = useState(false);
  const [handedCur, setHandedCur] = useState<"USD" | "CDF">("USD");
  const [receipt, setReceipt] = useState<SaleFull | null>(null);
  const keyRef = useRef(1);
  const searchBox = useRef<HTMLDivElement>(null);

  const { data: moneyAccounts } = useMoneyAccounts();
  const rateQ = useRate(saleDate, { live: true });
  const dayRate = rateQ.data?.cdfPerUsd ? d(rateQ.data.cdfPerUsd).toString() : "";
  const accById = useCallback((id: number | null) => moneyAccounts.find((a) => a.id === id), [moneyAccounts]);
  /**
   * The server values every franc of a sale at one rate: the day's for staff, for the owner the rate of the
   * first franc payment. The till uses that same rate for every payment and the change, so what it adds up
   * is what the receipt says.
   */
  const firstFcPay = pays.find((p) => accById(p.accountId)?.currency === "CDF");
  const saleFcRate = user?.role === "owner" && firstFcPay?.rate != null ? firstFcPay.rate : dayRate;

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
  /** Lines sold for less than they cost: allowed (owner, clearance) but worth a second look. */
  const belowCost = (l: CartLine) => d(l.unitPrice).gt(0) && d(l.variant.avgCost).gt(0) && lineAmount(l).lt(c2(d(l.qty).times(d(l.variant.avgCost))));
  // The server refuses a line below cost from staff without the right (priceLimits): said on the line before
  // "Valider", not as a 403 after it. A cashier is not shown the cost, only that the list price is below it.
  const mayBelowCost = user?.role === "owner" || (user?.role === "manager" && shop?.managerBelowCost === true);
  const costRefusal = (l: CartLine): "list" | "line" | null => {
    if (!user || mayBelowCost) return null;
    const listLow = (stockQ.data?.find((v) => v.id === l.variant.id)?.listBelowCost ?? l.variant.listBelowCost) === true;
    const atList = lineAmount(l).lte(c2(d(l.qty).times(d(l.variant.sellPrice))));
    if (listLow && atList) return "list";
    return user.role !== "cashier" && belowCost(l) ? "line" : null;
  };
  const saleDiscount = c2(d(discount));
  const total = subtotal.minus(saleDiscount);
  // Shown like the receipt: subtotal before any discount, then all discounts together.
  const grossSubtotal = lines.reduce((s, l) => s.plus(c2(d(l.qty).times(d(l.unitPrice)))), d(0));
  const totalDiscount = grossSubtotal.minus(total);
  /** Discounts above the prices, or a price or discount that cannot be read: no change, "Payé" or "Reste" is worked out from it. */
  const totalBad = total.lt(0) || !typedNumberOk(discount) || lines.some((l) => !typedNumberOk(l.unitPrice) || !typedNumberOk(l.qty) || !typedNumberOk(l.lineDiscount));

  const payUsd = (p: PayRow) => {
    const acc = accById(p.accountId);
    if (!acc) return d(0);
    const amount = c2(d(p.amount));
    if (acc.currency === "CDF") {
      const r = d(saleFcRate);
      return r.gt(0) ? c2(amount.dividedBy(r)) : d(0);
    }
    return amount;
  };
  const rateNum = d(saleFcRate);
  // Payments into one account are one amount, valued once, as the server books them: 20 000 FC and 10 000 FC
  // into the franc box are 10,68 $, not 7,12 $ + 3,56 $.
  const byAccount = new Map<number, Decimal>();
  for (const p of pays) {
    const acc = accById(p.accountId);
    if (acc) byAccount.set(acc.id, (byAccount.get(acc.id) ?? d(0)).plus(c2(d(p.amount))));
  }
  const fcToUsd = (amount: Decimal) => (rateNum.gt(0) ? c2(amount.dividedBy(rateNum)) : d(0));
  const received = Array.from(byAccount).reduce((s, [id, amount]) => s.plus(accById(id)!.currency === "CDF" ? fcToUsd(amount) : amount), d(0));
  /** What was handed over, in dollars, before rounding each payment to the cent. */
  const receivedExact = pays.reduce((s, p) => {
    const acc = accById(p.accountId);
    if (!acc || d(p.amount).lte(0)) return s;
    if (acc.currency !== "CDF") return s.plus(c2(d(p.amount)));
    const r = d(saleFcRate);
    return r.gt(0) ? s.plus(c2(d(p.amount)).dividedBy(r)) : s;
  }, d(0));
  const paidRows = pays.filter((p) => accById(p.accountId) && d(p.amount).gt(0));
  const payCurrencies = new Set(paidRows.map((p) => accById(p.accountId)!.currency));
  /** Change comes by default from a drawer in the currency the customer paid in (the last payment typed). */
  const payCurrency: "USD" | "CDF" = paidRows.length ? (accById(paidRows[paidRows.length - 1].accountId)!.currency as "USD" | "CDF") : "USD";
  // Francs cannot be counted to the cent of a dollar: up to 100 FC over or under is rounding (as on the server).
  const francTolerance = rateNum.gt(0) ? d(100).dividedBy(rateNum).toDecimalPlaces(2, Decimal.ROUND_UP) : d(0);
  const francs = pays.some((p) => accById(p.accountId)?.currency === "CDF" && d(p.amount).gt(0));
  const payTolerance = francs ? francTolerance : d(0);
  const excess = received.minus(total);
  /**
   * The francs over or under, counted in francs as the server does: 75 700 FC on a 75 816 FC sale is 116 FC
   * short, not rounding, though the tolerance in dollars (0,04 $ at 2 808) would let it through.
   */
  const francGap = (exact: Decimal) => (rateNum.gt(0) ? total.minus(exact).times(rateNum) : d(0));
  const withinFrancs = (exact: Decimal) => francGap(exact).abs().lte(FRANC_ROUNDING);
  // More than 100 FC handed over too much: change is due, even if under the tolerance in dollars.
  const francsOver = francs && francGap(receivedExact).lt(FRANC_ROUNDING.negated());
  const changeAcc = totalBad ? undefined : accById(changeAccId) ?? (excess.gt(payTolerance) || francsOver ? findCash(payCurrency) ?? findCash("USD") : undefined);
  // Francs go back in 100 FC steps (no smaller notes); the few francs over or under are the sale's rounding,
  // which the server accepts up to 100 FC. Dollars go back to the cent.
  const exactExcess = receivedExact.minus(total);
  const autoChange = changeAcc
    ? changeAcc.currency === "CDF"
      ? Decimal.max(exactExcess.times(rateNum).dividedBy(100).toDecimalPlaces(0, ROUND).times(100), 0)
      : Decimal.max(c2(exactExcess), 0)
    : d(0);
  const showChange = !totalBad && (excess.gt(payTolerance) || francsOver || !!changeAmt);
  const changeNative = showChange && changeAcc ? (changeAmt ? c2(d(changeAmt)) : autoChange) : d(0);
  // Change handed back in francs is rounded too, so it counts like a franc payment (the server does the same).
  const tolerance = francs || (changeAcc?.currency === "CDF" && changeNative.gt(0)) ? francTolerance : d(0);
  /** Change from a drawer in another currency than the customer paid in: asked again before saving. */
  const crossChange = !francsChosen && !!changeAcc && changeNative.gt(0) && payCurrencies.size > 0 && !payCurrencies.has(changeAcc.currency);
  const changeText = changeAcc ? money(changeNative.toFixed(2), changeAcc.currency) : "";
  /** Dollar change with cents: the francs drawer can give it all back in 100 FC steps instead. */
  const cdfCash = findCash("CDF");
  const changeInFrancs =
    changeAcc?.currency === "USD" && changeNative.gt(0) && !changeNative.isInteger() && cdfCash && rateNum.gt(0)
      ? changeNative.times(rateNum).dividedBy(100).toDecimalPlaces(0, ROUND).times(100)
      : null;
  // Francs given back from the box they were paid into leave at what the payment is worth less what the box
  // kept, as the server values them (30 000 FC less 10 300 FC: 10,68 $ − 7,02 $ = 3,66 $, not 3,67 $), so the
  // change, "Payé" and the rounding read here as on the receipt.
  const sameBoxFc = changeAcc?.currency === "CDF" ? byAccount.get(changeAcc.id) : undefined;
  const sameBoxChange = sameBoxFc && sameBoxFc.minus(changeNative).gt(0) ? fcToUsd(sameBoxFc).minus(fcToUsd(sameBoxFc.minus(changeNative))) : null;
  const changeUsd = changeAcc?.currency === "CDF" ? (sameBoxChange?.gt(0) ? sameBoxChange : fcToUsd(changeNative)) : changeNative;
  const paid = received.minus(changeUsd);
  const remaining = total.minus(paid);
  // Worked out before rounding to the cent, so it is the francs actually over or under (25 FC, not 0,01 $ = 28 FC).
  const changeExact = changeAcc?.currency === "CDF" ? (rateNum.gt(0) ? changeNative.dividedBy(rateNum) : d(0)) : changeNative;
  /** Within the rounding: under the tolerance in dollars and, when francs are involved, 100 FC at most. */
  const rounded = remaining.abs().lte(tolerance) && (!tolerance.gt(0) || withinFrancs(receivedExact.minus(changeExact)));
  const overpaid = !totalBad && remaining.lt(0) && !rounded;
  const credit = !totalBad && remaining.gt(0) && !rounded ? remaining : d(0);
  /**
   * A few francs over or under, taken as the sale's rounding: shown in francs, not as cents left to pay.
   * Counted in francs even when the dollars round to 0,00 $ (76 000 FC less 200 FC change on 75 816 FC is
   * 16 FC, like 80 000 FC less 4 200 FC), so the line shows the same way for both.
   */
  const francRounding = rounded && tolerance.gt(0) && rateNum.gt(0) ? francGap(receivedExact.minus(changeExact)).toDecimalPlaces(0, ROUND) : null;
  /** The same rounding signed as the receipt and the books keep it: + when the shop got a few francs more. */
  const tillRounding = francRounding ? fcRounding(t, remaining.negated(), francRounding.negated()) : null;
  /** What the customer's avoir (paid ahead) covers of the credit: nothing new is owed up to it. */
  const avoirAvailable = customer && d(customer.balance).lt(0) ? d(customer.balance).negated() : null;
  const avoirCovers = avoirAvailable && credit.gt(0) ? Decimal.min(credit, avoirAvailable) : null;
  /** Only what the avoir does not cover is new credit: the till, the bar and the button say "à crédit" for that part. */
  const onCredit = customerId ? credit.minus(avoirCovers ?? 0) : d(0);
  const allOnAvoir = !!customerId && !!avoirCovers && !onCredit.gt(0);

  /** A short franc payment: what is still to pay in francs too, in the 100 FC notes the customer can hand over. */
  const remainingFc = francs && !francRounding && credit.gt(0) && paid.gt(0) && rateNum.gt(0)
    // The nearest 100 FC to the francs actually short leaves the sale within its rounding: 116 FC short asks for 100 FC.
    ? Decimal.max(francGap(receivedExact.minus(changeExact)).dividedBy(100).toDecimalPlaces(0, ROUND).times(100), FRANC_ROUNDING)
    : null;

  const takenUnitIds = useMemo(() => new Set(lines.map((l) => l.unitId).filter((x): x is number => !!x)), [lines]);

  // ---- validation
  // `problems` are mistakes to fix (listed in red); `todo` is what is simply not done yet (said once, in grey).
  const problems: string[] = [];
  const todo: string[] = [];
  // A rate typed far from the day's comes first: every total below is worked out with it.
  const rateTolerance = d(shop?.rateTolerancePct ?? "3");
  const dayRateNum = d(dayRate);
  const rateOff = dayRateNum.gt(0) && !!firstFcPay && rateNum.gt(0) && rateNum.minus(dayRateNum).abs().dividedBy(dayRateNum).times(100).gt(rateTolerance);
  if (rateOff) {
    problems.push(t(`The rate is more than ${rateTolerance.toString()}% from the day's rate (${fmtQty(dayRate)}): correct it`, `Le taux s'écarte de plus de ${rateTolerance.toString()}\u00a0% du taux du jour (${fmtQty(dayRate)})\u00a0: corrigez-le`));
  }
  if (!locationId) todo.push(t("Choose the location", "Choisissez le lieu"));
  if (lines.length === 0) todo.push(t("Add at least one item", "Ajoutez au moins un article"));
  for (const l of lines) {
    // A price or discount typed so that it cannot be read ("1.400": 1 400 $ or 1,40 $?) is said by its field.
    if (!typedNumberOk(l.unitPrice)) problems.push(t(`Correct the price of ${l.variant.productName}`, `Corrigez le prix ${de(l.variant.productName)}`));
    else if (!l.unitPrice.trim() || d(l.unitPrice).lte(0)) problems.push(t(`Enter the price of ${l.variant.productName} (it is 0 $)`, `Saisissez le prix ${de(l.variant.productName)} (il est à 0\u00a0$)`));
    // "1.000" for a whole-unit item is asked about by its field (1 000 or 1?), never read as 1.
    if (!typedNumberOk(l.qty)) problems.push(unclearQty(t, l.qty) ? `${unclearQty(t, l.qty)} (${l.variant.productName})` : t(`Correct the quantity of ${l.variant.productName}`, `Corrigez la quantité ${de(l.variant.productName)}`));
    else if (d(l.qty).lte(0)) problems.push(t(`Quantity of ${l.variant.productName} must be more than zero`, `La quantité ${de(l.variant.productName)} doit être supérieure à zéro`));
    else if (!d(l.qty).isInteger() && wholeUnit(l.variant.unit)) {
      problems.push(t(`${l.variant.productName} is sold by the ${unitLabel(t, l.variant.unit, 1)}: enter a whole number`, `${l.variant.productName} se vend à l'unité (${unitLabel(t, l.variant.unit, 1)}) : saisissez un nombre entier`));
    }
    if (!typedNumberOk(l.lineDiscount)) problems.push(t(`Correct the discount on ${l.variant.productName}`, `Corrigez la remise sur ${l.variant.productName}`));
    if (lineAmount(l).lt(0)) problems.push(t(`The discount on ${l.variant.productName} is bigger than the line`, `La remise sur ${l.variant.productName} dépasse la ligne`));
    // More than this location holds: the server refuses the sale, so it is said here before paying.
    if (typedNumberOk(l.qty) && qtyInCart(l.variant.id).gt(available(l.variant.id, l.variant.locationQty))) {
      const inCart = fmtQty(qtyInCart(l.variant.id).toString());
      const here = fmtQty(available(l.variant.id, l.variant.locationQty).toString());
      problems.push(t(`${l.variant.productName}: ${inCart} in the cart, only ${here} in stock here`, `${l.variant.productName}\u00a0: ${inCart} au panier, seulement ${here} en stock ici`));
    }
    if (costRefusal(l) === "list") problems.push(t(`${l.variant.productName}: price below cost, for the owner to raise`, `${l.variant.productName}\u00a0: prix sous le coût, à relever par le propriétaire`));
    if (costRefusal(l) === "line") problems.push(t(`${l.variant.productName}: below cost; only the owner can sell below cost`, `${l.variant.productName}\u00a0: sous le coût\u00a0; seul le propriétaire peut vendre à perte`));
    if (l.variant.tracksSerials && !l.unitId) problems.push(t(`Choose the chassis number for ${l.variant.productName}`, `Choisissez le numéro de châssis pour ${l.variant.productName}`));
  }
  if (maxDiscountPct && subtotal.gt(0)) {
    // Said with the most that may be given: on the line, or on the sale discount when only its share takes a
    // line over ("au plus 2,20 $" on a 22 $ tyre at 10 %), the lowest that keeps every line within the limit.
    let saleDiscountMax: Decimal | null = null;
    for (const l of lines) {
      const list = c2(d(l.qty).times(d(l.variant.sellPrice)));
      if (list.lte(0)) continue;
      // The sale discount is shared over the lines by their amount, as the server does.
      const sold = lineAmount(l).minus(saleDiscount.times(lineAmount(l)).dividedBy(subtotal));
      const most = d(l.qty).times(d(l.variant.sellPrice)).times(maxDiscountPct).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
      const own = list.minus(lineAmount(l));
      if (list.minus(sold).times(100).gt(list.times(maxDiscountPct).plus("0.5"))) {
        // The line is within the limit on its own: it is the sale discount's share that takes it over.
        if (own.lte(most) && saleDiscount.gt(0) && lineAmount(l).gt(0)) {
          const allowed = most.minus(own).times(subtotal).dividedBy(lineAmount(l)).toDecimalPlaces(2, Decimal.ROUND_DOWN);
          saleDiscountMax = saleDiscountMax ? Decimal.min(saleDiscountMax, allowed) : allowed;
          continue;
        }
        problems.push(
          t(
            `${l.variant.productName}: the discount is more than the ${maxDiscountPct}% you may give (at most ${usd(most.toFixed(2))})`,
            `${l.variant.productName}\u00a0: la remise dépasse les ${maxDiscountPct}\u00a0% autorisés (au plus\u00a0${usd(most.toFixed(2))})`,
          ),
        );
      }
    }
    if (saleDiscountMax) {
      problems.push(
        t(
          `The sale discount is more than the ${maxDiscountPct}% you may give (at most ${usd(saleDiscountMax.toFixed(2))})`,
          `La remise sur la vente dépasse les ${maxDiscountPct}\u00a0% autorisés (au plus\u00a0${usd(saleDiscountMax.toFixed(2))})`,
        ),
      );
    }
  }
  if (total.lt(0)) problems.unshift(t(`The total is below zero (${usd(total.toFixed(2))}): the discounts are more than the prices`, `Le total est négatif (${usd(total.toFixed(2))})\u00a0: les remises dépassent les prix`));
  if (!typedNumberOk(discount)) problems.push(t("Correct the sale discount", "Corrigez la remise sur la vente"));
  if (saleDiscount.lt(0) || saleDiscount.gt(subtotal)) problems.push(t("The sale discount is bigger than the sale", "La remise dépasse le montant de la vente"));
  for (const p of pays) {
    const acc = accById(p.accountId);
    // "61800 FC" in a dollar line: the bar says what the field says, not only that it is wrong.
    if (!typedNumberOk(p.amount)) problems.push((refusedUnit(p.amount, acc?.currency === "CDF" ? "CDF" : "USD") && unclearAmount(t, p.amount, acc?.currency ?? "USD")) || t("Correct the payment amount", "Corrigez le montant du paiement"));
    if (!acc && d(p.amount).gt(0)) problems.push(t("Choose the account for each payment", "Choisissez le compte pour chaque paiement"));
    // An empty payment row is simply ignored when the sale is saved.
    if (acc && d(p.amount).lt(0)) problems.push(t("A payment cannot be negative", "Un paiement ne peut pas être négatif"));
    if (acc?.currency === "CDF" && d(p.amount).gt(0) && rateNum.lte(0)) problems.push(t("Enter the exchange rate for CDF payments", "Saisissez le taux pour les paiements en francs"));
    if (acc?.currency === "CDF" && !d(p.amount).isInteger()) problems.push(t("Franc amounts are whole numbers", "Les montants en FC sont des nombres entiers"));
  }
  if (!typedNumberOk(changeAmt)) problems.push(t("Correct the change given back", "Corrigez la monnaie rendue"));
  if (overpaid) problems.push(t("Payments are more than the total, even after the change given back.", "Les paiements dépassent le total, même après la monnaie rendue."));
  if (changeAcc?.currency === "CDF" && !changeNative.isInteger()) problems.push(t("Franc amounts are whole numbers", "Les montants en FC sont des nombres entiers"));
  if (changeUsd.gt(0) && changeUsd.gte(received)) problems.push(t("The change is more than the money received", "La monnaie rendue dépasse l'argent reçu"));
  if (credit.gt(0) && !customerId && lines.length > 0) {
    todo.push(
      paid.gt(0)
        ? t("Choose a customer to sell the rest on credit", "Choisissez un client pour vendre le reste à crédit")
        : t("Enter the payment, or choose a customer to sell on credit", "Saisissez le paiement, ou choisissez un client pour vendre à crédit"),
    );
  }
  const valid = problems.length === 0 && todo.length === 0;
  const blockedReason = problems.length ? t("Fix the points above", "Corrigez les points ci-dessus") : todo[0] ?? null;
  /** A price raised past twice the list price, often a slipped zero (50 $ for 5 $): "+900 %", to confirm before the sale. */
  const priceRise = (l: CartLine) => {
    const list = d(l.variant.sellPrice);
    if (!typedNumberOk(l.unitPrice) || !list.gt(0) || !d(l.unitPrice).gt(list.times(2))) return null;
    return `+${fmtPct(d(l.unitPrice).minus(list).dividedBy(list).times(100).toDecimalPlaces(0).toString(), 0)}`;
  };
  const raisedLines = lines.filter((l) => priceRise(l));

  /**
   * Cash far above the sale (76 800 000 FC on a 32 $ sale: zeros typed twice) or change the drawer does not
   * hold: asked before saving, as vouchers ask about an unusual amount, never refused. Only staff who see the
   * balances (not cashiers) get the drawer check.
   */
  const balancesQ = useAccounts("/api/accounts/balances", { enabled: can("manager") });
  const unusualCash: string[] = [];
  if (!totalBad && total.gt(0) && received.gt(total.times(UNUSUAL_RECEIVED))) {
    const typed = Array.from(byAccount).map(([id, amount]) => money(amount.toFixed(2), accById(id)!.currency)).join(" + ");
    const times = received.dividedBy(total).toDecimalPlaces(0, Decimal.ROUND_DOWN).toString();
    unusualCash.push(t(
      `${typed} received for a ${usd(total.toFixed(2))} sale: ${fmtQty(times)} times the total. Check the zeros.`,
      `${typed} reçus pour une vente de ${usd(total.toFixed(2))}\u00a0: ${fmtQty(times)} fois le total. Vérifiez les zéros.`,
    ));
  }
  const changeDrawer = changeAcc && changeNative.gt(0) ? balancesQ.data?.find((a) => a.id === changeAcc.id) : undefined;
  if (changeAcc && changeDrawer) {
    // What the drawer holds once this sale's own payment into it is in.
    const holds = d(changeAcc.currency === "CDF" ? changeDrawer.nativeBalance ?? changeDrawer.balance : changeDrawer.balance).plus(byAccount.get(changeAcc.id) ?? 0);
    if (changeNative.gt(holds)) {
      const withPay = byAccount.has(changeAcc.id);
      unusualCash.push(t(
        `The change (${changeText}) is more than ${changeAcc.name} holds (${money(holds.toFixed(2), changeAcc.currency)}${withPay ? " with this payment" : ""}).`,
        `La monnaie (${changeText}) dépasse ce que contient ${changeAcc.name} (${money(holds.toFixed(2), changeAcc.currency)}${withPay ? " avec ce paiement" : ""}).`,
      ));
    }
  }

  // ---- payments helpers
  function findCash(currency: "USD" | "CDF") {
    return moneyAccounts.find((a) => a.systemKey === (currency === "USD" ? "cash_usd" : "cash_cdf")) ?? moneyAccounts.find((a) => a.currency === currency);
  }
  function payAllIn(currency: "USD" | "CDF") {
    const acc = findCash(currency);
    if (!acc) return;
    const kept = pays.filter((p) => p.accountId && d(p.amount).gt(0));
    // A line already in that drawer is filled again rather than doubled: after a till refused a stale franc
    // rate, pressing again sets Caisse FC to the francs at the new rate, not a second 2 000 FC line.
    const same = kept.find((p) => p.accountId === acc.id);
    const rest = total.minus(kept.filter((p) => p !== same).reduce((s, p) => s.plus(payUsd(p)), d(0)));
    if (rest.lte(0)) return setPays(kept);
    // Francs are asked in 100 FC notes (7 $ at 2 808: 19 700 FC, not 19 656 FC; 22 $: 61 800 FC, not 61 776 FC),
    // like the total, the change and "Reste à payer"; the few francs over or under are the sale's "Arrondi FC",
    // at most 50 FC, which the server takes as rounding (up to 100 FC).
    const amount = currency === "CDF" ? francsFor(rest, true).toFixed(2) : rest.toFixed(2);
    if (same) return setPays(kept.map((p) => (p === same ? { ...p, amount, rate: null } : p)));
    setPays([...kept, { key: keyRef.current++, accountId: acc.id, amount, rate: null }]);
  }
  /** Dollars in francs at the day's rate; in 100 FC steps for what is asked or prefilled, exact for the secondary figure. */
  function francsFor(value: Decimal, mixed: boolean) {
    const exact = value.times(rateNum);
    return mixed ? Decimal.max(exact.dividedBy(FRANC_ROUNDING).toDecimalPlaces(0, ROUND).times(FRANC_ROUNDING), FRANC_ROUNDING) : exact.toDecimalPlaces(0, ROUND);
  }
  const updatePay = (key: number, patch: Partial<PayRow>) => setPays((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  /** Changing a line to an account in another currency converts what was typed at the day's rate. */
  function changePayAccount(p: PayRow, acc: Account) {
    const prev = accById(p.accountId);
    let amount = p.amount;
    if (prev && prev.currency !== acc.currency && d(p.amount).gt(0)) {
      const value = payUsd(p);
      if (acc.currency === "CDF") amount = rateNum.gt(0) ? francsFor(value, true).toFixed(0) : "";
      else amount = value.gt(0) ? c2(value).toFixed(2) : "";
    }
    updatePay(p.key, { accountId: acc.id, amount, rate: null });
  }

  // ---- change calculator (helper only)
  // What is paid now (part of a credit sale), never above the total: francs rounded to 100 FC make "paid"
  // 27,01 $ on a 27,00 $ sale, which must still read 75 870 FC like the total.
  // With nothing paid, the customer's avoir takes its part first: a 5 $ sale fully on the avoir leaves nothing to pay.
  const dueAfterAvoir = customerId && avoirCovers ? Decimal.max(total.minus(avoirCovers), 0) : total;
  // A walk-in can't leave anything on credit: what is due is the whole sale, however little is typed above.
  const toPay = customerId && paid.gt(0) && paid.lt(total) && !withinFrancs(receivedExact.minus(changeUsd)) ? paid : dueAfterAvoir;
  const nothingToPay = !toPay.gt(0) && allOnAvoir;
  // A part payment typed in francs only is that many francs, not its dollars at the rate (70 000 FC, not 70 003 FC).
  const typedFc = toPay === paid && !changeUsd.gt(0) && paidRows.length > 0 && paidRows.every((p) => accById(p.accountId)!.currency === "CDF")
    ? paidRows.reduce((s, p) => s.plus(d(p.amount).toDecimalPlaces(0, ROUND)), d(0))
    : null;
  // The francs asked are always in 100 FC notes, like the change (27,00 $: 75 800 FC, not 75 816 FC); the few
  // francs between are the sale's "Arrondi FC". Francs typed as a part payment are those notes already.
  const toPayFc = typedFc ?? (rateNum.gt(0) && toPay.gt(0) ? francsFor(toPay, true) : null);
  /**
   * A credit sale says what is due now (the part paid now, or nothing) and the credit apart, never the credit
   * as "À payer": with nothing paid, "Rien à payer maintenant", whether an avoir covers part of it or not.
   */
  const creditSale = !!customerId && onCredit.gt(0);
  const allOnCredit = creditSale && !paid.gt(0);
  // Francs handed over are counted in francs against the francs asked, so 75 800 FC for 75 800 FC leaves
  // nothing and 80 000 FC gives back 4 200 FC, in notes.
  const changeFcExact = toPayFc && handedCur === "CDF" ? d(handed).toDecimalPlaces(0, ROUND).minus(toPayFc) : null;
  const handedUsd = handedCur === "CDF" ? (rateNum.gt(0) ? d(handed).dividedBy(rateNum) : d(0)) : d(handed);
  const change = changeFcExact ? (changeFcExact.isZero() || !rateNum.gt(0) ? d(0) : changeFcExact.dividedBy(rateNum)) : handedUsd.minus(toPay);
  // Dollar change is exact to the cent; its franc figure goes in 100 FC steps, as the till gives francs back.
  const changeFc = changeFcExact ? changeFcExact.abs() : rateNum.gt(0) ? change.abs().times(rateNum).dividedBy(FRANC_ROUNDING).toDecimalPlaces(0, ROUND).times(FRANC_ROUNDING) : null;

  // ---- submit
  function reset() {
    setLines([]);
    setDiscount("");
    setCustomer(null);
    setCustomerId(null);
    setNote("");
    setPays([]);
    setHanded("");
    setChangeAccId(null);
    setChangeAmt("");
    setFrancsChosen(false);
  }
  const mutation = useApiMutation<SaleBody, SaleFull>("POST", "/api/sales", {
    success: t("Sale recorded", "Vente enregistrée"),
    onSuccess: (sale) => {
      setReceipt(sale);
      reset();
    },
    // A refused sale may be one the day's rate moved under: the till shows the new rate at once.
    onError: () => {
      void rateQ.refetch();
    },
  });
  const [confirmCross, setConfirmCross] = useState(false);
  const [confirmPrice, setConfirmPrice] = useState(false);
  const [confirmCash, setConfirmCash] = useState(false);
  // Each check asks once, the raised prices first; confirmed, the sale goes through as typed.
  function submit(confirmed: { price?: boolean; cash?: boolean; cross?: boolean } = {}) {
    if (!valid || mutation.isPending || !locationId) return;
    if (raisedLines.length && !confirmed.price) return setConfirmPrice(true);
    setConfirmPrice(false);
    if (unusualCash.length && !confirmed.cash) return setConfirmCash(true);
    setConfirmCash(false);
    if (crossChange && !confirmed.cross) return setConfirmCross(true);
    setConfirmCross(false);
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
          return { accountId: acc.id, amount: c2(d(p.amount)).toFixed(2), ...(acc.currency === "CDF" ? { rate: rateNum.toString() } : {}) };
        }),
      change: changeAcc && changeNative.gt(0)
        ? { accountId: changeAcc.id, amount: changeNative.toFixed(2), ...(changeAcc.currency === "CDF" ? { rate: rateNum.toString() } : {}) }
        : null,
      // Staff francs go at the day's rate: the server checks it is still the one the till worked with.
      ...(user?.role !== "owner" && rateNum.gt(0) ? { tillRate: rateNum.toString() } : {}),
    });
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const receiptOpen = !!receipt;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (receiptOpen || document.querySelector("[role=alertdialog]")) return;
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

  const payCard = useRef<HTMLDivElement>(null);
  const [tried, setTried] = useState(false);
  function mobilePay() {
    if (valid) return submit();
    setTried(true);
    payCard.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="pb-24 lg:pb-0">
      <PageHeader
        title={t("Point of sale", "Caisse")}
        description={
          <>
            {t("Scan or search items, take payment, print the receipt.", "Scanner ou chercher les articles, encaisser, imprimer le reçu.")}
            <span className="hidden lg:inline [@media(pointer:coarse)]:hidden"> {t("F9 or Ctrl+Enter to finish.", "F9 ou Ctrl+Entrée pour valider.")}</span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can("manager") && (
              <Input
                type="date"
                className={cn("w-40", backDated && "border-amber-500 text-amber-800 dark:text-amber-400")}
                value={saleDate}
                max={today}
                onChange={(e) => setSaleDate(e.target.value || today)}
                aria-label={t("Sale date", "Date de la vente")}
                title={t("Sale date", "Date de la vente")}
              />
            )}
            <div className="w-48">
              <LocationSelect value={locationId} onChange={setLocationId} aria-label={t("Location of the sale", "Lieu de la vente")} />
            </div>
          </div>
        }
      />

      {/* minmax(0,1fr) and min-w-0 below lg too: an implicit column would grow to a long item name and widen the page. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------------- Cart */}
        <div className="min-w-0 space-y-4">
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
                            <p className="break-words font-medium">{l.variant.productName}{l.variant.label !== "Standard" ? ` · ${l.variant.label}` : ""}</p>
                            <p className="text-xs text-muted-foreground">
                              {l.variant.sku} · {t("in stock here", "en stock ici")}{t(":", "\u00a0:")} <span className={cn(short && "font-semibold text-destructive")}>{fmtQty(avail.toString())}</span>
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
                              <Input value="1" disabled className="h-9" aria-label={t(`Quantity of ${l.variant.productName}`, `Quantité ${de(l.variant.productName)}`)} />
                            ) : (
                              <div className="flex items-start gap-1">
                                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" aria-label={t(`Lower the quantity of ${l.variant.productName}`, `Diminuer la quantité ${de(l.variant.productName)}`)} onClick={() => updateLine(l.key, { qty: Decimal.max(d(l.qty).minus(1), 1).toString() })}><Minus className="h-3 w-3" /></Button>
                                <Input className="h-9 min-w-0 text-center" inputMode={wholeUnit(l.variant.unit) ? "numeric" : "decimal"} whole={wholeUnit(l.variant.unit)} measured={!wholeUnit(l.variant.unit)} inlineAlert alertClassName="relative -left-10 w-[calc(100%+5rem)]" aria-label={t(`Quantity of ${l.variant.productName}`, `Quantité ${de(l.variant.productName)}`)} aria-invalid={(!d(l.qty).isInteger() && wholeUnit(l.variant.unit)) || undefined} value={l.qty} onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" aria-label={t(`Raise the quantity of ${l.variant.productName}`, `Augmenter la quantité ${de(l.variant.productName)}`)} onClick={() => updateLine(l.key, { qty: d(l.qty).plus(1).toString() })}><Plus className="h-3 w-3" /></Button>
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-muted-foreground">{t("Unit price $", "Prix unitaire $")}</p>
                            <Input className="h-9" inputMode="decimal" usd aria-label={t(`Unit price of ${l.variant.productName} ($)`, `Prix unitaire ${de(l.variant.productName)} ($)`)} value={l.unitPrice} onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })} />
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-muted-foreground">{t("Discount $", "Remise $")}</p>
                            <Input className="h-9" inputMode="decimal" usd percentOf={c2(d(l.qty).times(d(l.unitPrice))).toFixed(2)} placeholder="0" aria-label={t(`Discount on ${l.variant.productName} ($)`, `Remise sur ${l.variant.productName} ($)`)} value={l.lineDiscount} onChange={(e) => updateLine(l.key, { lineDiscount: e.target.value })} />
                          </div>
                          <div className="text-right">
                            <p className="mb-1 text-xs text-muted-foreground">{t("Line total", "Total ligne")}</p>
                            <p className={cn("pt-1.5 font-semibold", lineAmount(l).lt(0) && "text-destructive")}><Num>{usd(lineAmount(l).toFixed(2))}</Num></p>
                          </div>
                        </div>
                        {typedNumberOk(l.unitPrice) && d(l.unitPrice).lte(0) && (
                          <p className="flex items-center gap-1 text-xs font-medium text-destructive">
                            <AlertTriangle className="h-3 w-3 shrink-0" /> {t("Price is 0 $: enter the selling price", "Prix à 0\u00a0$\u00a0: saisissez le prix de vente")}
                          </p>
                        )}
                        {priceRise(l) && (
                          <p className="flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-400" data-testid="pos-price-rise">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {t(`${priceRise(l)} on the list price (${usd(d(l.variant.sellPrice).toFixed(2))}): check the zeros`, `${priceRise(l)} sur le prix de liste (${usd(d(l.variant.sellPrice).toFixed(2))}) — vérifiez les zéros`)}
                          </p>
                        )}
                        {costRefusal(l) ? (
                          <p className="flex items-center gap-1 text-xs font-medium text-destructive" data-testid="pos-below-cost">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {costRefusal(l) === "list"
                              ? t("List price below cost: the owner must raise the price.", "Prix de catalogue sous le coût\u00a0: le propriétaire doit relever le prix.")
                              : t(`Below cost (cost ${usd(d(l.variant.avgCost).toFixed(2))} each): only the owner can sell below cost.`, `Sous le coût (coût ${usd(d(l.variant.avgCost).toFixed(2))} l'unité)\u00a0: seul le propriétaire peut vendre à perte.`)}
                          </p>
                        ) : belowCost(l) && (
                          <p className="flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-400">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {t(`Sold below cost (cost ${usd(d(l.variant.avgCost).toFixed(2))} each)`, `Vente à perte (coût ${usd(d(l.variant.avgCost).toFixed(2))} l'unité)`)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            {/* One column beside the payment card at 1024 px, so the customer's name and the discount label fit. */}
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label={t("Customer (optional, required for credit)", "Client (facultatif, obligatoire pour le crédit)")}>
                <PartySelect types={["customer"]} value={customerId} onChange={(id, p) => { setCustomerId(id); setCustomer(p ?? null); }} placeholder={t("Walk-in customer", "Client de passage")} />
                {customer && d(customer.balance).gt(0) && (
                  <p className="text-xs text-amber-800 dark:text-amber-400">{t("Already owes", "Doit déjà")} {usd(customer.balance)}</p>
                )}
                {/* Paid ahead: a sale on credit comes off this first, so nothing new is owed up to it. */}
                {customer && d(customer.balance).lt(0) && (
                  <p className="text-xs text-emerald-800 dark:text-emerald-400" data-testid="customer-avoir">{t("Credit available", "Avoir disponible")} {usd(d(customer.balance).negated().toFixed(2))}</p>
                )}
              </Field>
              <Field label={t("Sale discount ($)", "Remise sur la vente ($)")}>
                <Input inputMode="decimal" usd percentOf={subtotal.toFixed(2)} placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </Field>
              <Field label={t("Note", "Note")} className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </CardContent>
          </Card>
        </div>

        {/* ---------------- Payment */}
        <div className="min-w-0 space-y-4">
          <Card className="scroll-mt-4 lg:sticky lg:top-4" ref={payCard}>
            <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Payment", "Paiement")}</CardTitle></CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div className="rounded-lg bg-muted p-3">
                <div className="flex justify-between text-sm text-muted-foreground"><span>{t("Subtotal", "Sous-total")}</span><Num>{usd(grossSubtotal.toFixed(2))}</Num></div>
                {!totalDiscount.isZero() && <div className="flex justify-between text-sm text-muted-foreground"><span>{t("Discount", "Remise")}</span><Num>−{usd(totalDiscount.toFixed(2))}</Num></div>}
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{t("Total", "Total")}</span>
                  <span className={cn("text-3xl font-bold tabular", total.lt(0) && "text-destructive")}>{usd(total.toFixed(2))}</span>
                </div>
                {/* The francs asked, in 100 FC notes as the change calculator and "Tout en espèces FC" say; the exact figure under it. */}
                {rateNum.gt(0) && total.gt(0) && (
                  <p className="text-right text-xs text-muted-foreground" data-testid="total-fc">
                    {cdf(francsFor(total, true).toString())} · 1 $ = {fmtQty(rateNum.toString())} FC
                    {!francsFor(total, true).equals(francsFor(total, false)) && <span className="block">{t("exactly", "exactement")} {cdf(francsFor(total, false).toString())}</span>}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" size="sm" className="h-auto min-h-8 whitespace-normal py-1.5" onClick={() => payAllIn("USD")} disabled={total.lte(0) || !findCash("USD")}>
                  <Banknote className="mr-1 hidden h-4 w-4 min-[400px]:inline" /> {t("All in $ cash", "Tout en espèces $")}
                </Button>
                <Button variant="secondary" size="sm" className="h-auto min-h-8 whitespace-normal py-1.5" onClick={() => payAllIn("CDF")} disabled={total.lte(0) || !findCash("CDF") || rateNum.lte(0)}>
                  <Banknote className="mr-1 hidden h-4 w-4 min-[400px]:inline" /> {t("All in CDF cash", "Tout en espèces FC")}
                </Button>
              </div>

              {pays.map((p) => {
                const acc = accById(p.accountId);
                return (
                  <div key={p.key} className="space-y-2 rounded-md border p-2">
                    <div className="flex gap-2">
                      <div className="min-w-0 flex-1">
                        <MoneyAccountSelect showBalance={false} value={p.accountId} onChange={(_id, account) => changePayAccount(p, account)} aria-label={t("Payment account", "Compte du paiement")} />
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => setPays((ps) => ps.filter((x) => x.key !== p.key))} aria-label={t("Remove", "Retirer")}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                    <div className={cn("grid items-start gap-2", acc?.currency === "CDF" ? "grid-cols-2" : "grid-cols-1")}>
                      <div className="relative">
                        <Input
                          inputMode="decimal" currency={acc?.currency ?? "USD"}
                          switchTo={acc?.currency === "CDF" ? findCash("USD")?.name : findCash("CDF")?.name}
                          className="pr-10"
                          aria-label={acc?.currency === "CDF" ? t("Amount in FC", "Montant en FC") : t("Amount in $", "Montant en $")}
                          placeholder={t("Amount", "Montant")}
                          value={p.amount}
                          onChange={(e) => updatePay(p.key, { amount: e.target.value })}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">{acc?.currency === "CDF" ? "FC" : "$"}</span>
                      </div>
                      {acc?.currency === "CDF" && p === firstFcPay && (
                        <RateInput day={saleDate} value={p.rate ?? dayRate} onChange={(v) => updatePay(p.key, { rate: v })} ownerOnly />
                      )}
                      {/* One rate per sale: a second franc payment takes the first one's, said rather than asked again. */}
                      {acc?.currency === "CDF" && p !== firstFcPay && (
                        <p className="flex h-9 items-center rounded-md bg-muted/60 px-3 text-sm tabular-nums" aria-label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")}>
                          {fmtQty(saleFcRate)}{"\u00a0"}FC/$
                        </p>
                      )}
                    </div>
                    {acc?.currency === "CDF" && (
                      <p className="text-xs text-muted-foreground">
                        = {usd(payUsd(p).toFixed(2))} ({t("rate", "taux")} {fmtQty(saleFcRate)} FC/$)
                        {p !== firstFcPay && <span className="block">{t("Same rate as the first franc payment: a sale has one rate.", "Même taux que le premier paiement en francs\u00a0: une vente a un seul taux.")}</span>}
                      </p>
                    )}
                  </div>
                );
              })}
              <Button variant="outline" size="sm" className="w-full" disabled={pays.length >= MAX_PAYMENTS} onClick={() => setPays((ps) => [...ps, { key: keyRef.current++, accountId: findCash("USD")?.id ?? null, amount: remaining.gt(0) ? remaining.toFixed(2) : "", rate: null }])}>
                <Plus className="mr-1 h-4 w-4" /> {t("Add payment", "Ajouter un paiement")}
              </Button>
              {pays.length >= MAX_PAYMENTS && (
                <p className="text-xs text-muted-foreground" data-testid="pay-limit">
                  {t(`At most ${MAX_PAYMENTS} payments per sale: add to an existing line instead.`, `Au plus ${MAX_PAYMENTS} paiements par vente\u00a0: ajoutez plutôt le montant à une ligne existante.`)}
                </p>
              )}

              {showChange && (
                <div className="space-y-2 rounded-md border border-dashed p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{t("Change given back", "Monnaie rendue")}</p>
                    {changeAcc && changeNative.gt(0) && (
                      <p className="text-right text-lg font-bold tabular" data-testid="change-due">
                        {t("Give back", "Rendre")}{t(":", "\u00a0:")} {changeText}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <MoneyAccountSelect showBalance={false} value={changeAcc?.id ?? null} onChange={(id) => { setChangeAccId(id); setChangeAmt(""); setFrancsChosen(false); }} aria-label={t("Drawer the change comes from", "Caisse d'où sort la monnaie")} />
                    <div className="relative">
                      <Input
                        inputMode={changeAcc?.currency === "CDF" ? "numeric" : "decimal"} usd={changeAcc?.currency === "USD"}
                        thousands={changeAcc?.currency === "CDF"}
                        className="pr-10"
                        aria-label={changeAcc?.currency === "CDF" ? t("Change given back in FC", "Monnaie rendue en FC") : t("Change given back in $", "Monnaie rendue en $")}
                        placeholder={t("Other", "Autre")}
                        value={changeAmt}
                        onChange={(e) => setChangeAmt(e.target.value)}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">{changeAcc?.currency === "CDF" ? "FC" : "$"}</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {changeAmt
                      ? t("Amount typed by hand.", "Montant saisi à la main.")
                      : changeAcc?.currency === "CDF"
                        ? t("Worked out and rounded to 100 FC.", "Calculée et arrondie à 100 FC.")
                        : t("Worked out to the cent.", "Calculée au cent près.")}{" "}
                    {changeAcc?.currency === "CDF" && changeNative.gt(0) ? `= ${usd(changeUsd.toFixed(2))}` : ""}
                    {changeAmt && (
                      <button type="button" className="ml-1 font-medium text-primary underline-offset-2 hover:underline" onClick={() => setChangeAmt("")}>
                        {t("Use the worked-out amount", "Reprendre le montant calculé")}
                      </button>
                    )}
                  </p>
                  {changeInFrancs && cdfCash && changeInFrancs.gt(0) && (
                    <Button variant="outline" size="sm" className="h-auto min-h-8 w-full whitespace-normal py-1" onClick={() => { setChangeAccId(cdfCash.id); setChangeAmt(""); setFrancsChosen(true); }}>
                      {t(`No cents? Give it all back in francs: ${cdf(changeInFrancs.toString())}`, `Pas de cents\u00a0? Tout rendre en francs\u00a0: ${cdf(changeInFrancs.toString())}`)}
                    </Button>
                  )}
                  {crossChange && changeAcc && (
                    <p className="flex items-start gap-1 text-xs font-medium text-amber-800 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {t(
                        `The customer paid in ${[...payCurrencies].map(curLabel).join(" and ")} but the change comes out of ${changeAcc.name}: you will be asked to confirm.`,
                        `Le client a payé en ${[...payCurrencies].map(curLabel).join(" et ")} mais la monnaie sort ${de(changeAcc.name)}\u00a0: une confirmation sera demandée.`,
                      )}
                    </p>
                  )}
                </div>
              )}

              <Separator />
              {/* A total below zero or unreadable has nothing to pay or give back: only the mistakes below show. */}
              {!totalBad && <div className="space-y-1 text-sm">
                {changeUsd.gt(0) && <div className="flex justify-between"><span>{t("Received ($)", "Reçu ($)")}</span><Num>{usd(received.toFixed(2))}</Num></div>}
                {changeUsd.gt(0) && <div className="flex justify-between"><span>{t("Change given back", "Monnaie rendue")}</span><Num>−{usd(changeUsd.toFixed(2))}</Num></div>}
                {/* The money really kept, as the receipt, the sale page and the Sales list say it: within the franc
                    rounding the rounding line below explains the cents between it and the total. */}
                <div className="flex justify-between"><span>{t("Paid ($)", "Payé ($)")}</span><Num className="font-medium">{usd(paid.toFixed(2))}</Num></div>
                {tillRounding ? (
                  <div className="flex justify-between gap-2 text-muted-foreground" data-testid="franc-rounding">
                    <span>{t("FC rounding", "Arrondi FC")} <span className="whitespace-nowrap">({tillRounding.words})</span></span>
                    <Num className="shrink-0">{tillRounding.figure}</Num>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <span>
                      {allOnAvoir
                        ? t("Remaining → settled from the customer's credit", "Reste → réglé sur l'avoir")
                        : credit.gt(0) && customerId
                          ? t("Remaining → on credit", "Reste → à crédit")
                          : t("Left to pay", "Reste à payer")}
                    </span>
                    <span data-testid="left-to-pay">
                      {/* Part of it on the avoir: only the rest is new credit, the line below says the other part. */}
                      <Num className={cn("font-semibold", allOnAvoir ? "text-emerald-800 dark:text-emerald-400" : credit.gt(0) && customerId && "text-amber-800 dark:text-amber-400", overpaid && "text-destructive")}>{usd((francRounding ? d(0) : avoirCovers && !allOnAvoir ? onCredit : remaining).toFixed(2))}</Num>
                      {remainingFc && <Num className="text-muted-foreground"> ≈ {cdf(remainingFc.toString())}</Num>}
                    </span>
                  </div>
                )}
                {avoirCovers && customerId && (
                  <p className="text-right text-xs text-emerald-800 dark:text-emerald-400" data-testid="avoir-covers">
                    {!allOnAvoir && <>+ {t("settled from the customer's credit", "réglé sur l'avoir")} {usd(avoirCovers.toFixed(2))} · </>}
                    {allOnAvoir ? t("Credit left", "Avoir restant") : t("credit left", "avoir restant")} {usd(avoirAvailable!.minus(avoirCovers).toFixed(2))}
                  </p>
                )}
              </div>}

              {!totalBad && <details className="rounded-md border p-2 text-sm">
                <summary className="cursor-pointer select-none font-medium">{t("Change calculator", "Calcul de la monnaie")}</summary>
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-muted-foreground">{t("Only a helper: record the money kept above, not what the customer handed over.", "Seulement une aide\u00a0: enregistrer ci-dessus l'argent gardé, pas ce que le client a donné.")}</p>
                  <div className="flex gap-2">
                    <Input inputMode="decimal" usd={handedCur === "USD"} thousands={handedCur === "CDF"} switchTo={handedCur === "USD" ? t("FC beside it", "FC à côté") : t("$ beside it", "$ à côté")} aria-label={t("Cash handed over", "Montant reçu")} placeholder={t("Cash handed over", "Montant reçu")} value={handed} onChange={(e) => setHanded(e.target.value)} />
                    <Select value={handedCur} onValueChange={(v) => setHandedCur(v as "USD" | "CDF")}>
                      <SelectTrigger className="w-24" aria-label={t("Currency handed over", "Devise reçue")}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">$</SelectItem>
                        <SelectItem value="CDF">FC</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {nothingToPay ? (
                    <p className="text-emerald-800 dark:text-emerald-400" data-testid="calc-on-avoir">{t("Nothing to pay: settled from the customer's credit", "Rien à payer\u00a0: réglé sur l'avoir")}</p>
                  ) : allOnCredit ? (
                    <p className="text-amber-800 dark:text-amber-400" data-testid="calc-on-credit">
                      {t(`Nothing to pay now: ${usd(onCredit.toFixed(2))} on credit. Enter a payment above for a part paid now.`, `Rien à payer maintenant\u00a0: ${usd(onCredit.toFixed(2))} à crédit. Saisissez un paiement ci-dessus pour une partie payée tout de suite.`)}
                    </p>
                  ) : (
                    <>
                      <div className="flex justify-between"><span>{creditSale ? t("To pay now", "À payer maintenant") : t("To pay", "À payer")}</span><Num>{usd(toPay.toFixed(2))}{toPayFc ? ` · ${cdf(toPayFc.toString())}` : ""}</Num></div>
                      {creditSale && <div className="flex justify-between text-amber-800 dark:text-amber-400" data-testid="calc-credit-part"><span>{t("On credit", "À crédit")}</span><Num>{usd(onCredit.toFixed(2))}</Num></div>}
                    </>
                  )}
                  {handed && !allOnCredit && (
                    <div className={cn("flex justify-between font-semibold", change.lt(0) && "text-destructive")}>
                      <span>{change.lt(0) ? t("Still missing", "Il manque") : t("Change to give", "Monnaie à rendre")}</span>
                      <Num>{usd(c2(change.abs()).toFixed(2))}{changeFc ? ` · ${cdf(changeFc.toString())}` : ""}</Num>
                    </div>
                  )}
                </div>
              </details>}

              {problems.length > 0 && (
                <ul className="space-y-0.5 text-xs text-destructive">
                  {Array.from(new Set(problems)).map((p) => <li key={p}>• {p}</li>)}
                </ul>
              )}
              {/* Mistakes are listed just above; otherwise the button says what is still to do. On a phone the
                  bar at the bottom is the button, so only the reason shows here. */}
              <SubmitButton
                className="hidden lg:flex lg:flex-col lg:items-stretch [&>button]:h-12 [&>button]:w-full [&>button]:text-base [&>p]:text-center"
                blocked={blockedReason}
                pending={mutation.isPending}
                onClick={() => submit()}
              >
                {allOnAvoir
                  ? t("Finish · from the customer's credit", "Valider · sur l'avoir")
                  : credit.gt(0) && customerId
                    ? t(`Finish · ${usd(onCredit.toFixed(2))} on credit`, `Valider · ${usd(onCredit.toFixed(2))} à crédit`)
                    : totalBad
                      ? t("Finish sale", "Valider la vente")
                      : t(`Finish sale ${usd(total.toFixed(2))}`, `Valider la vente ${usd(total.toFixed(2))}`)}
              </SubmitButton>
              {blockedReason && (lines.length > 0 || tried) && <p className="text-center text-xs text-muted-foreground lg:hidden" role="status">{blockedReason}</p>}
              <p className="hidden text-center text-xs text-muted-foreground lg:block [@media(pointer:coarse)]:hidden">{t("F9 / Ctrl+Enter", "F9 / Ctrl+Entrée")}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Phone: the total and the pay button stay on screen while scrolling the cart. */}
      {!receipt && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t bg-background/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur lg:hidden print:hidden">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t("Total", "Total")} · {cartCount(t, lines.map((l) => ({ qty: l.qty, unit: l.variant.unit })))}</p>
            <p className="truncate text-xl font-bold tabular">{usd(total.toFixed(2))}</p>
            {problems.length > 0 && lines.length > 0 ? (
              // Without this the bar only says "Pay" and the reason is out of sight, at the foot of the payment card.
              // On two lines, so a long one ("Choisissez le numéro de châssis pour …") is read whole at 360 px.
              <p className="line-clamp-2 text-xs font-medium leading-snug text-destructive" role="status" data-testid="problem-bar">{problems[0]}</p>
            ) : changeAcc && changeNative.gt(0) ? (
              <p className="truncate text-sm font-bold" data-testid="change-due-bar">{t("Give back", "Rendre")}{t(":", "\u00a0:")} {changeText}</p>
            ) : remainingFc && !(credit.gt(0) && customerId) ? (
              <p className="truncate text-xs font-semibold" data-testid="left-to-pay-bar">{t("Left to pay", "Reste à payer")}{t(":", "\u00a0:")} {usd(remaining.toFixed(2))} ≈ {cdf(remainingFc.toString())}</p>
            ) : allOnAvoir ? (
              <p className="truncate text-xs font-semibold text-emerald-800 dark:text-emerald-400">{t(`${usd(credit.toFixed(2))} from the customer's credit`, `${usd(credit.toFixed(2))} réglé sur l'avoir`)}</p>
            ) : credit.gt(0) && customerId ? (
              <p className="truncate text-xs font-semibold text-amber-800 dark:text-amber-400">{t(`${usd(onCredit.toFixed(2))} on credit`, `dont ${usd(onCredit.toFixed(2))} à crédit`)}</p>
            ) : (
              rateNum.gt(0) && total.gt(0) && <p className="truncate text-xs text-muted-foreground">{cdf(francsFor(total, true).toString())}</p>
            )}
          </div>
          <SubmitButton
            className="shrink-0 items-end [&>button]:h-12 [&>button]:px-6 [&>button]:text-base"
            blocked={lines.length === 0 && t("Add an item", "Ajoutez un article")}
            pending={mutation.isPending}
            onClick={mobilePay}
          >
            {valid ? (allOnAvoir ? t("Finish · from credit", "Valider · sur l'avoir") : credit.gt(0) && customerId ? t("Finish on credit", "Valider à crédit") : t("Finish", "Valider")) : t("Pay", "Payer")}
          </SubmitButton>
        </div>
      )}

      <AlertDialog open={confirmCross} onOpenChange={setConfirmCross}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Change from another currency?", "Monnaie dans une autre devise\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {changeAcc &&
                t(
                  `The customer paid in ${[...payCurrencies].map(curLabel).join(" and ")}. You are giving back ${changeText} from ${changeAcc.name}.`,
                  `Le client a payé en ${[...payCurrencies].map(curLabel).join(" et ")}. Vous rendez ${changeText} depuis ${changeAcc.name}.`,
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Go back", "Revenir")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit({ price: true, cash: true, cross: true })}>{t(`Give back ${changeText}`, `Rendre ${changeText}`)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPrice} onOpenChange={setConfirmPrice}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Sell at these prices?", "Vendre à ces prix ?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left" data-testid="pos-price-confirm">
                {raisedLines.map((l) => (
                  <p key={l.key} className="font-medium text-amber-800 dark:text-amber-400">
                    {t(
                      `${l.variant.productName}: ${usd(c2(d(l.unitPrice)).toFixed(2))} instead of ${usd(d(l.variant.sellPrice).toFixed(2))} (${priceRise(l)}).`,
                      `${l.variant.productName} : ${usd(c2(d(l.unitPrice)).toFixed(2))} au lieu de ${usd(d(l.variant.sellPrice).toFixed(2))} (${priceRise(l)}).`,
                    )}
                  </p>
                ))}
                <p>{t("Check for an extra zero before recording the sale.", "Vérifiez les zéros : n'y en a-t-il pas un de trop ?")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit({ price: true })}>{t("Sell anyway", "Vendre quand même")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmCash} onOpenChange={setConfirmCash}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("An unusual amount?", "Un montant inhabituel\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left" data-testid="pos-cash-confirm">
                {unusualCash.map((m) => <p key={m}>{m}</p>)}
                {changeAcc && changeNative.gt(0) && <p className="font-medium text-foreground">{t("Give back", "Rendre")}{t(":", "\u00a0:")} {changeText}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit({ price: true, cash: true })}>{t("Save anyway", "Enregistrer quand même")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
