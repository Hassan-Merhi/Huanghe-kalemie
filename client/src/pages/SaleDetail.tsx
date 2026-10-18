import { useState } from "react";
import { de } from "@shared/french";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { Link, useParams } from "wouter";
import { ArrowLeft, Ban, Printer, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { MoneyAccountSelect, RateInput, useMoneyAccounts, useRate } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { cdf, d, date as fmtDate, fcRounding, qty as fmtQty, todayLocal, usd, variantText, unclearQty } from "@/lib/format";
import type { Account, Party, Settings } from "@/lib/types";
import { wholeUnit } from "@/lib/units";
import { cn } from "@/lib/utils";
import { avoirSplit, ReceiptDialog, paymentText, type SaleFull } from "./POS";
import { SaleFlags } from "./Sales";

function ReturnDialog({ sale, owes, onClose, onDone }: { sale: SaleFull; owes: Decimal | null; onClose: () => void; onDone: (sale: SaleFull) => void }) {
  const t = useT();
  const today = todayLocal();
  const [date, setDate] = useState(today);
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"account" | "credit">(d(sale.creditUsd).gt(0) && sale.customerId ? "credit" : "account");
  // Pay back from the account the customer paid into, unless someone picks another.
  const { data: moneyAccounts } = useMoneyAccounts();
  const paidInto = [...sale.payments].sort((a, b) => d(b.amountUsd).comparedTo(d(a.amountUsd)))[0]?.accountId ?? null;
  const [accountId, setAccountId] = useState<number | null>(paidInto);
  // A sale paid in two drawers says so next to the refund account: "Payée 20,00 $ en Caisse USD + 19 700 FC en Caisse FC".
  const paidIn = Array.from(netByAccount(sale)).filter(([, x]) => x.native.gt(0));
  const paidInText = paidIn.length > 1
    ? t(`Paid ${paidIn.map(([id, x]) => `${drawerAmount(x)} into ${moneyAccounts.find((a) => a.id === id)?.name ?? `#${id}`}`).join(" + ")}`, `Payée ${paidIn.map(([id, x]) => `${drawerAmount(x)} en ${moneyAccounts.find((a) => a.id === id)?.name ?? `#${id}`}`).join(" + ")}`)
    : null;
  const account: Account | null = moneyAccounts.find((a) => a.id === accountId) ?? null;
  const [rate, setRate] = useState<string | null>(null);
  const rateQ = useRate(date);
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  // Staff refunds go at the day's rate (the server refuses another), so only the owner's typed one counts.
  const effRate = (isOwner ? rate : null) ?? rateQ.data?.cdfPerUsd ?? "";
  // The owner's rate more than the tolerance from the day's is refused by the server: said before saving.
  const rateTolerance = d(useQuery<Settings>({ queryKey: ["/api/settings"] }).data?.rateTolerancePct ?? "3");
  const dayRate = d(rateQ.data?.cdfPerUsd);
  const rateOff = dayRate.gt(0) && d(effRate).gt(0) && d(effRate).minus(dayRate).abs().dividedBy(dayRate).times(100).gt(rateTolerance);
  const m = useApiMutation<unknown, SaleFull>("POST", `/api/sales/${sale.id}/returns`, { success: t("Return recorded", "Retour enregistré"), onSuccess: (s) => onDone(s) });

  const chosen = sale.lines
    .map((l) => ({ line: l, q: d(qtys[l.id]), max: d(l.qty).minus(l.returnedQty) }))
    .filter((x) => x.q.gt(0));
  const tooMany = chosen.some((x) => x.q.gt(x.max));
  // Half a tyre cannot come back: said at the field, before the server refuses it.
  const fractional = chosen.find((x) => wholeUnit(x.line.unit) && !x.q.isInteger());
  const refund = chosen.reduce((s, x) => s.plus(d(x.line.lineTotal).times(x.q).dividedBy(x.line.qty).toDecimalPlaces(2)), d(0));
  const isCdf = mode === "account" && account?.currency === "CDF";
  // The server's split (returnSale): goods sold on credit and not yet paid come off the customer's debt
  // before any cash goes back, at most what they owe; with no refund account, all of it goes on their
  // balance, so what is beyond their debt becomes an avoir (5 $ owed, 22 $ back: 5 $ off the debt, 17 $ avoir).
  const owed = owes ? Decimal.max(owes, 0) : null;
  const creditedBefore = sale.returns.reduce((s, r) => s.plus(d(r.refundToBalanceUsd ?? (r.refundAccountId ? 0 : r.total))), d(0));
  const unpaidOnSale = Decimal.max(d(sale.creditUsd).minus(creditedBefore), 0);
  const toDebt = mode === "credit"
    ? (owed ? Decimal.min(refund, owed) : refund)
    : sale.customerId && owed ? Decimal.min(refund, unpaidOnSale, owed) : d(0);
  const toAvoir = mode === "credit" && owed ? refund.minus(toDebt) : d(0);
  const toCash = mode === "account" ? refund.minus(toDebt) : d(0);
  // Francs go back rounded down to 100 FC: the customer gets these, worth a few cents less than the goods.
  const payOutFc = isCdf && d(effRate).gt(0) ? toCash.times(d(effRate)).dividedBy(100).toDecimalPlaces(0, Decimal.ROUND_FLOOR).times(100) : null;
  // "1.000" pieces is asked about by its field (1 000 or 1?), never read as 1.
  const unclear = sale.lines.map((l) => unclearQty(t, qtys[l.id])).find(Boolean);
  const blocked = unclear
    ? unclear
    : chosen.length === 0
      ? t("Enter the quantity coming back", "Saisissez la quantité retournée")
      : fractional
        ? t(`${fractional.line.productName} is counted in whole units: use a whole number`, `${fractional.line.productName} se compte à l'unité\u00a0: saisissez un nombre entier`)
      : tooMany
        ? t("You cannot return more than was sold", "Impossible de retourner plus que la quantité vendue")
        : !reason.trim()
          ? t("Enter the reason", "Saisissez le motif")
          : mode === "credit"
            ? !sale.customerId && t("This sale has no customer", "Cette vente n'a pas de client")
            : !accountId
              ? t("Choose the account to pay back from", "Choisissez le compte de remboursement")
              : isCdf && !d(effRate).gt(0)
                ? t("Enter the exchange rate", "Saisissez le taux de change")
                : isCdf && rateOff && t(
                  `The rate is more than ${rateTolerance.toString()}% from the day's rate (${fmtQty(dayRate.toString())}): correct it`,
                  `Le taux s'écarte de plus de ${rateTolerance.toString()}\u00a0% du taux du jour (${fmtQty(dayRate.toString())})\u00a0: corrigez-le`,
                );

  function save() {
    m.mutate({
      date,
      reason: reason.trim(),
      refundAccountId: mode === "account" ? accountId : null,
      ...(isCdf ? { rate: d(effRate).toString() } : {}),
      lines: chosen.map((x) => ({ saleLineId: x.line.id, qty: x.q.toString() })),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Return items", "Retour d'articles")} · {sale.number}</DialogTitle>
          <DialogDescription>{t("Items come back into stock at the cost they left with; the refund is the price they were sold for.", "Les articles reviennent en stock au coût de leur sortie\u00a0; le remboursement est le prix de vente.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Item", "Article")}</TableHead>
                  <TableHead className="text-right">{t("Can return", "Retournable")}</TableHead>
                  <TableHead className="w-28 text-right">{t("Qty back", "Qté retour")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sale.lines.map((l) => {
                  const max = d(l.qty).minus(l.returnedQty);
                  const over = d(qtys[l.id]).gt(max);
                  const split = wholeUnit(l.unit) && !d(qtys[l.id]).isInteger();
                  return (
                    <TableRow key={l.id}>
                      <TableCell>
                        <p className="font-medium">{l.productName} {variantText(l.attributes)}</p>
                        {/* "2 × 22,00 $" as on the receipt; a line with a discount shares it in, so its total. */}
                        <p className="text-xs text-muted-foreground">
                          {l.sku}{l.chassisNo ? ` · ${l.chassisNo}` : ""} · {d(l.qty).times(l.unitPrice).toDecimalPlaces(2).equals(d(l.lineTotal)) ? `${fmtQty(l.qty)}\u00a0×\u00a0${usd(l.unitPrice)}` : `${fmtQty(l.qty)} · ${usd(l.lineTotal)}`}
                        </p>
                      </TableCell>
                      <TableCell className="text-right"><Num>{fmtQty(max.toString())}</Num></TableCell>
                      <TableCell className="text-right">
                        <Input
                          className={cn("h-8 text-right", (over || split) && "border-destructive")}
                          aria-invalid={split || undefined}
                          inputMode={wholeUnit(l.unit) ? "numeric" : "decimal"}
                          whole={wholeUnit(l.unit)} measured={!wholeUnit(l.unit)}
                          inlineAlert
                          disabled={max.lte(0)}
                          aria-label={t(`Quantity of ${l.productName} to return`, `Quantité ${de(l.productName)} à retourner`)}
                          placeholder="0"
                          value={qtys[l.id] ?? ""}
                          onChange={(e) => setQtys((q) => ({ ...q, [l.id]: e.target.value }))}
                        />
                        {split && <p className="mt-1 text-xs text-destructive">{t("Whole units only", "Unités entières seulement")}</p>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {tooMany && <p className="text-sm text-destructive">{t("You cannot return more than was sold.", "Impossible de retourner plus que la quantité vendue.")}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Date", "Date")}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={t("Reason", "Motif")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("Refund", "Remboursement")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={mode === "account" ? "default" : "outline"} onClick={() => setMode("account")}>{t("Pay back from a money account", "Rendre l'argent depuis un compte")}</Button>
              {sale.customerId && (
                <Button type="button" size="sm" variant={mode === "credit" ? "default" : "outline"} onClick={() => setMode("credit")}>
                  {owed && owed.isZero() ? t("Keep it as customer credit", "Mettre en avoir du client") : t("Reduce what the customer owes", "Réduire la dette du client")}
                </Button>
              )}
            </div>
            {mode === "account" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("Refund from", "Rembourser depuis")} required hint={paidInText ?? (accountId && accountId === paidInto ? t("The account the customer paid into", "Le compte où le client a payé") : undefined)}>
                  <MoneyAccountSelect value={accountId} onChange={(id) => setAccountId(id)} />
                </Field>
                {isCdf && (
                  // Staff see the day's rate as text, as in the voucher and customer-payment dialogs: it is the one the books use.
                  <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} hint={`${t("Pay out:", "À rendre\u00a0:")} ${cdf((payOutFc ?? d(0)).toString())} ${t("(rounded down to 100 FC)", "(arrondi à 100\u00a0FC inférieurs)")}`} required={isOwner}>
                    <RateInput day={date} value={effRate} onChange={setRate} ownerOnly />
                  </Field>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t(`The refund comes off ${sale.customer?.name ?? "the customer"}'s balance.`, `Le remboursement est déduit du solde ${sale.customer ? de(sale.customer.name) : "du client"}.`)}</p>
            )}
          </div>
          {payOutFc ? (
            <div className="space-y-1 rounded-md bg-muted p-3">
              <div className="flex justify-between gap-2 text-sm"><span>{t("Value of the items", "Valeur des articles")}</span><Num>{usd(refund.toFixed(2))}</Num></div>
              {toDebt.gt(0) && <div className="flex justify-between gap-2 text-sm"><span>{t("Taken off the debt", "Déduit de la dette")}</span><Num>−{usd(toDebt.toFixed(2))}</Num></div>}
              <div className="flex justify-between gap-2 font-medium">
                <span>{t("Handed back", "Rendu")}</span>
                <Num>{cdf(payOutFc.toString())} ({usd(payOutFc.dividedBy(d(effRate)).toFixed(2))})</Num>
              </div>
            </div>
          ) : mode === "credit" && toAvoir.gt(0) ? (
            <div className="space-y-1 rounded-md bg-muted p-3" data-testid="return-split">
              {/* Beyond what the customer owes, the return is held for them as an avoir, said with its figure. */}
              {toDebt.gt(0) && <div className="flex justify-between gap-2 text-sm"><span>{t("Taken off the debt", "Déduit de la dette")}</span><Num>{usd(toDebt.toFixed(2))}</Num></div>}
              <div className="flex justify-between gap-2 text-sm"><span>{t("Kept as customer credit", "Mis en avoir du client")}</span><Num>{usd(toAvoir.toFixed(2))}</Num></div>
              <div className="flex justify-between gap-2 font-medium"><span>{t("Value of the items", "Valeur des articles")}</span><Num>{usd(refund.toFixed(2))}</Num></div>
            </div>
          ) : mode === "account" && toDebt.gt(0) ? (
            <div className="space-y-1 rounded-md bg-muted p-3" data-testid="return-split">
              {/* What was sold on credit and not paid comes off the debt; only the rest is handed back. */}
              <div className="flex justify-between gap-2 text-sm"><span>{t("Taken off the debt", "Déduit de la dette")}</span><Num>{usd(toDebt.toFixed(2))}</Num></div>
              <div className="flex justify-between gap-2 font-medium"><span>{t("Refund total", "Total remboursé")}</span><Num>{usd(toCash.toFixed(2))}</Num></div>
            </div>
          ) : (
            <div className="flex justify-between rounded-md bg-muted p-3 font-medium">
              {/* No cash goes out when the return comes off the customer's debt. */}
              <span>{mode === "credit" ? t("Taken off the debt", "Déduit de la dette") : t("Refund total", "Total remboursé")}</span>
              <Num>{usd(refund.toFixed(2))}</Num>
            </div>
          )}
          <ErrorText error={m.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={save} blocked={blocked} pending={m.isPending}>{t("Record return", "Enregistrer le retour")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A return slip for the customer (and the cash box): what came back and how it was refunded. 80 mm paper. */
function ReturnSlip({ sale, ret, accName }: { sale: SaleFull; ret: SaleFull["returns"][number]; accName: (id: number | null) => string }) {
  const t = useT();
  const shopName = useQuery<Settings>({ queryKey: ["/api/settings"] }).data?.shopName;
  const dash = <div className="my-1.5 border-t border-dashed border-black" />;
  return (
    <div className="mx-auto w-full max-w-[80mm] bg-white p-2 font-mono text-[11px] leading-snug text-black">
      <div className="text-center">
        <p className="text-sm font-bold uppercase">{shopName || "Huanghe Kalemie"}</p>
        <p>{t("Return slip", "Bon de retour")}</p>
      </div>
      {dash}
      <div className="flex justify-between gap-2"><span>{t("No.", "N°")}</span><span>{ret.number}</span></div>
      <div className="flex justify-between gap-2"><span>{t("Date", "Date")}</span><span>{fmtDate(ret.date)}</span></div>
      <div className="flex justify-between gap-2"><span>{t("Sale", "Vente")}</span><span>{sale.number} · {fmtDate(sale.date)}</span></div>
      {sale.customer && <div className="flex justify-between gap-2"><span>{t("Customer", "Client")}</span><span>{sale.customer.name}</span></div>}
      {dash}
      {(ret.lines ?? []).map((rl) => {
        const l = sale.lines.find((x) => x.id === rl.saleLineId);
        // "2 × 22,00 $" as on the sale receipt, when the line's price gives the amount (no discount shared in).
        const each = l && d(rl.qty).times(l.unitPrice).toDecimalPlaces(2).equals(d(rl.amount)) ? usd(l.unitPrice) : null;
        return (
          <div key={rl.saleLineId} className="mb-1">
            <p className="font-semibold">{l ? `${l.productName} ${variantText(l.attributes)}` : `#${rl.saleLineId}`}</p>
            <div className="flex justify-between gap-2"><span>{each ? `${fmtQty(rl.qty)}\u00a0×\u00a0${each}` : fmtQty(rl.qty)}</span><span className="tabular">{usd(rl.amount)}</span></div>
          </div>
        );
      })}
      {dash}
      {/* A franc refund: the goods' value, then the francs handed back (rounded down to 100 FC) and their worth. */}
      {/* Nothing handed back (a credit sale): the value comes off the debt, so the slip does not say "refunded". */}
      {ret.refundCurrency === "CDF" || !ret.refundAccountId ? (
        <div className={cn("flex justify-between gap-2", !ret.refundAccountId && "font-bold")}><span>{t("Value of the items", "Valeur des articles")}</span><span className="tabular">{usd(ret.total)}</span></div>
      ) : (
        <div className="flex justify-between gap-2 font-bold"><span>{t("REFUND", "REMBOURSÉ")}</span><span className="tabular">{usd(ret.total)}</span></div>
      )}
      {ret.refundAccountId && ret.refundNative ? (
        <>
          <div className="flex justify-between gap-2 font-bold">
            <span>{t("Handed back", "Rendu au client")}</span>
            <span className="tabular">{ret.refundCurrency === "CDF" ? `${cdf(ret.refundNative)} (${usd(ret.refundUsd ?? "0")})` : usd(ret.refundNative)}</span>
          </div>
          <p>{t("From", "Depuis")} {accName(ret.refundAccountId)}</p>
          {d(ret.refundToBalanceUsd).gt(0) && (
            <div className="flex justify-between gap-2"><span>{t("Taken off the customer's balance", "Déduit du solde du client")}</span><span className="tabular">{usd(ret.refundToBalanceUsd)}</span></div>
          )}
        </>
      ) : !ret.refundAccountId && ret.offDebtUsd != null ? (
        // The same split as the return dialog: what cleared the debt, then what is held as an avoir.
        <ReturnBalanceSplit ret={ret} />
      ) : (
        <p>{ret.refundAccountId ? `${t("Paid back from", "Rendu depuis")} ${accName(ret.refundAccountId)}` : t("Taken off the customer's balance", "Déduit du solde du client")}</p>
      )}
      {ret.reason && <p>{t("Reason", "Motif")}{"\u00a0"}: {ret.reason}</p>}
      {dash}
      <p className="mt-6">{t("Customer signature", "Signature du client")}{"\u00a0"}: ____________</p>
    </div>
  );
}

/** "Déduit de la dette 5,00 $ · Mis en avoir du client 17,00 $": where a return with no refund went on the customer's balance. */
function returnBalanceParts(ret: SaleFull["returns"][number]) {
  const offDebt = d(ret.offDebtUsd ?? ret.total);
  return { offDebt, toAvoir: d(ret.total).minus(offDebt) };
}

function ReturnBalanceSplit({ ret }: { ret: SaleFull["returns"][number] }) {
  const t = useT();
  const { offDebt, toAvoir } = returnBalanceParts(ret);
  return (
    <>
      {offDebt.gt(0) && <div className="flex justify-between gap-2"><span>{t("Taken off the debt", "Déduit de la dette")}</span><span className="tabular">{usd(offDebt.toFixed(2))}</span></div>}
      {toAvoir.gt(0) && <div className="flex justify-between gap-2"><span>{t("Kept as customer credit", "Mis en avoir du client")}</span><span className="tabular">{usd(toAvoir.toFixed(2))}</span></div>}
    </>
  );
}

function ReturnSlipDialog({ sale, ret, accName, onClose }: { sale: SaleFull; ret: SaleFull["returns"][number]; accName: (id: number | null) => string; onClose: () => void }) {
  const t = useT();
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] max-w-sm overflow-y-auto">
          <DialogHeader><DialogTitle>{t("Return slip", "Bon de retour")} {ret.number}</DialogTitle></DialogHeader>
          <div className="rounded-md border bg-muted p-3">
            <div className="mx-auto max-w-[80mm] shadow-sm ring-1 ring-black/5"><ReturnSlip sale={sale} ret={ret} accName={accName} /></div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={onClose}>{t("Close", "Fermer")}</Button>
            <Button onClick={() => window.print()}><Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {createPortal(<div className="print-area hidden print:block"><ReturnSlip sale={sale} ret={ret} accName={accName} /></div>, document.body)}
    </>
  );
}

/** What each drawer kept of the sale, change taken off: + money in, − money given back from it. */
function netByAccount(sale: SaleFull) {
  const byAccount = new Map<number, { currency: "USD" | "CDF"; native: Decimal }>();
  for (const p of sale.payments) {
    const cur = byAccount.get(p.accountId) ?? { currency: p.currency, native: d(0) };
    byAccount.set(p.accountId, { ...cur, native: cur.native.plus(d(p.amountNative)) });
  }
  return byAccount;
}
const drawerAmount = (x: { currency: "USD" | "CDF"; native: Decimal }) => (x.currency === "CDF" ? cdf(x.native.abs().toFixed(0)) : usd(x.native.abs().toFixed(2)));

/**
 * The cash to swap back when a sale is cancelled, from its payments and change, per drawer: "Rendez 50,00 $
 * (Caisse USD) et reprenez 65 300 FC (Caisse FC)". Null when nothing was paid.
 */
function voidCashText(t: ReturnType<typeof useT>, sale: SaleFull, accName: (id: number | null) => string) {
  const text = (id: number, x: { currency: "USD" | "CDF"; native: Decimal }) => `${drawerAmount(x)} (${accName(id)})`;
  const entries = Array.from(netByAccount(sale));
  const give = entries.filter(([, x]) => x.native.gt(0)).map(([id, x]) => text(id, x));
  const take = entries.filter(([, x]) => x.native.lt(0)).map(([id, x]) => text(id, x));
  if (!give.length) return null;
  return take.length
    ? t(`Give back ${give.join(" + ")} and take back ${take.join(" + ")}.`, `Rendez ${give.join(" + ")} et reprenez ${take.join(" + ")}.`)
    : t(`Give back ${give.join(" + ")} to the customer.`, `Rendez ${give.join(" + ")} au client.`);
}

function VoidDialog({ sale, accName, onClose }: { sale: SaleFull; accName: (id: number | null) => string; onClose: () => void }) {
  const t = useT();
  const cash = voidCashText(t, sale, accName);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(todayLocal());
  const m = useApiMutation<unknown, SaleFull>("POST", `/api/sales/${sale.id}/void`, { success: t("Sale cancelled", "Vente annulée"), onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Cancel sale", "Annuler la vente")} {sale.number}</DialogTitle>
          <DialogDescription>
            {t(
              "The whole sale is undone: items go back into stock at the cost they left with, motorcycles become available again, and the money and any credit are reversed in the books.",
              "Toute la vente est annulée\u00a0: les articles reviennent en stock au coût de leur sortie, les motos redeviennent disponibles, et l'argent reçu comme le crédit sont annulés dans les comptes.",
            )}
          </DialogDescription>
        </DialogHeader>
        {/* The books are reversed by the cancellation; the notes in the drawers are swapped back by hand. */}
        {cash && sale.returns.length === 0 && <p className="rounded-md border p-3 text-sm font-medium" data-testid="void-cash">{cash}</p>}
        {sale.returns.length > 0 && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {t("This sale already has returns, so it cannot be cancelled. Return the remaining items instead.", "Cette vente a déjà des retours, elle ne peut pas être annulée. Retournez plutôt les articles restants.")}
          </p>
        )}
        <div className="space-y-3">
          <Field label={t("Reason", "Motif")} required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Field label={t("Date", "Date")}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <ErrorText error={m.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Keep the sale", "Garder la vente")}</Button>
          <SubmitButton variant="destructive" blocked={!reason.trim() && t("Enter the reason", "Saisissez le motif")} pending={m.isPending} onClick={() => m.mutate({ reason: reason.trim(), date })}>{t("Cancel sale", "Annuler la vente")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Réglé sur l'avoir 11,00 $ · avoir restant 15 739,00 $": credit the customer's avoir covered when the sale was made. */
function AvoirRow({ avoir }: { avoir: ReturnType<typeof avoirSplit> }) {
  const t = useT();
  if (!avoir.used.gt(0)) return null;
  return (
    <div className="flex justify-between gap-2 py-2" data-testid="avoir-used">
      <span>
        {t("Settled from the customer's credit", "Réglé sur l'avoir")}
        <span className="block text-xs text-muted-foreground">{t("Credit left after this sale", "Avoir restant après la vente")} {usd(avoir.left.toFixed(2))}</span>
      </span>
      <Num className="font-medium">{usd(avoir.used.toFixed(2))}</Num>
    </div>
  );
}

/**
 * What the customer's avoir covered at the sale, the credit given beyond it, what returns took off that, and
 * what is still owed: "Accordé à crédit − retours = reste à crédit", the avoir's part kept out of the credit.
 */
function CreditRows({ creditedReturns, stillOwed, owes, avoir }: { creditedReturns: Decimal; stillOwed: Decimal; owes: Decimal | null; avoir: ReturnType<typeof avoirSplit> }) {
  const t = useT();
  const onCredit = avoir.toPay;
  if (!stillOwed.lt(onCredit) && creditedReturns.isZero()) {
    return (
      <>
        <AvoirRow avoir={avoir} />
        {/* Only what the avoir did not cover is still to pay. */}
        {avoir.toPay.gt(0) && (
          <div className="flex justify-between gap-2 py-2 text-amber-800 dark:text-amber-400">
            <span>{avoir.used.gt(0) ? t("On credit (to pay)", "À crédit (reste à payer)") : t("On credit", "À crédit")}</span>
            <Num className="font-medium">{usd(avoir.toPay.toFixed(2))}</Num>
          </div>
        )}
      </>
    );
  }
  // Beyond the credit, a return goes back on the customer's balance (their avoir, or their other debts).
  const extra = creditedReturns.minus(onCredit);
  return (
    <>
      <AvoirRow avoir={avoir} />
      {onCredit.gt(0) && (
        <div className="flex justify-between gap-2 py-2 text-muted-foreground">
          <span>{t("Given on credit", "Accordé à crédit")}</span>
          <Num>{usd(onCredit.toFixed(2))}</Num>
        </div>
      )}
      {onCredit.gt(stillOwed) && (
        <div className="flex justify-between gap-2 py-2 text-muted-foreground">
          <span>{t("Returns taken off the credit", "Retours déduits du crédit")}</span>
          <Num>−{usd(onCredit.minus(stillOwed).toFixed(2))}</Num>
        </div>
      )}
      <div className={cn("flex justify-between gap-2 py-2", stillOwed.gt(0) && "text-amber-800 dark:text-amber-400")}>
        <span>
          {t("Still on credit", "Reste à crédit")}
          <span className="block text-xs text-muted-foreground">{t("Later payments show on the customer's statement.", "Les paiements ultérieurs figurent sur le relevé du client.")}</span>
        </span>
        <Num className="font-medium">{usd(stillOwed.toFixed(2))}</Num>
      </div>
      {extra.gt(0) && <ExtraReturned extra={extra} owes={owes} />}
    </>
  );
}

/**
 * Where a return beyond this sale's credit went: it comes off the customer's other debts first, and only
 * what is left over is held for them as an avoir. `owes` is their balance now, after the return, so before it
 * they owed `owes + extra`: 5 $ extra on a balance now at 0 paid off 5 $ of another sale, none of it is avoir.
 */
function ExtraReturned({ extra, owes }: { extra: Decimal; owes: Decimal | null }) {
  const t = useT();
  const x = usd(extra.toFixed(2));
  let text: string;
  if (!owes) {
    text = t(`The extra ${x} went back on the customer's account.`, `Les ${x} en plus sont revenus sur le compte du client.`);
  } else {
    const toDebt = Decimal.min(Decimal.max(owes.plus(extra), 0), extra);
    const kept = extra.minus(toDebt);
    if (kept.isZero()) {
      text = owes.gt(0)
        ? t(`The extra ${x} reduces what the customer still owes (${usd(owes.toFixed(2))}).`, `Les ${x} en plus réduisent sa dette restante (${usd(owes.toFixed(2))}).`)
        : t(`The extra ${x} paid off what the customer still owed.`, `Les ${x} en plus ont réduit sa dette restante : il ne doit plus rien.`);
    } else if (toDebt.isZero()) {
      text = t(`The extra ${x} is kept as credit for the customer.`, `Les ${x} en plus restent en avoir pour le client.`);
    } else {
      const debt = usd(toDebt.toFixed(2));
      const avoir = usd(kept.toFixed(2));
      text = t(
        `Of the extra ${x}, ${debt} paid off what the customer still owed and ${avoir} is kept as credit for them.`,
        `Des ${x} en plus, ${debt} ont réduit sa dette restante et ${avoir} restent en avoir pour le client.`,
      );
    }
  }
  return <p className="py-2 text-xs text-muted-foreground" data-testid="return-extra">{text}</p>;
}

/** A line's margin on what the customer kept, green or red; a returned line says so under it. */
function LineProfit({ l, returned }: { l: SaleFull["lines"][number]; returned: { amount: Decimal; cogs: Decimal } }) {
  const t = useT();
  if (l.cogs === undefined) return null;
  const profit = d(l.lineTotal).minus(returned.amount).minus(d(l.cogs).minus(returned.cogs));
  const allBack = d(l.returnedQty).gte(d(l.qty));
  return (
    <>
      <Num className={cn("font-medium", !allBack && profit.gt(0) && "text-green-800 dark:text-green-400", !allBack && profit.lt(0) && "text-destructive")}>{usd(profit.toFixed(2))}</Num>
      {d(l.returnedQty).gt(0) && <span className="block whitespace-nowrap text-xs text-muted-foreground">{allBack ? t("all returned", "tout retourné") : t("after return", "après retour")}</span>}
    </>
  );
}

export default function SaleDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const showCost = user?.role !== "cashier";
  const q = useQuery<SaleFull>({ queryKey: [`/api/sales/${id}`] });
  const { data: moneyAccounts } = useMoneyAccounts();
  const accName = (accId: number | null) => moneyAccounts.find((a) => a.id === accId)?.name ?? (accId ? `#${accId}` : "");
  const [dialog, setDialog] = useState<null | "receipt" | "return" | "void">(null);
  const [slipId, setSlipId] = useState<number | null>(null);
  // What the customer owes overall, to say where returns beyond this sale's credit went.
  // Also how the return dialog splits a refund between the debt and the avoir.
  const customers = useQuery<Party[]>({ queryKey: ["/api/parties"], enabled: !!q.data?.customerId });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorText error={q.error ?? t("Sale not found", "Vente introuvable")} />;
  const sale = q.data;
  const voided = sale.status === "voided";
  const canReturn = !voided && sale.lines.some((l) => d(l.qty).gt(l.returnedQty));
  const returnedTotal = sale.returns.reduce((s, r) => s.plus(r.total), d(0));
  const returnedCost = sale.returns.reduce((s, r) => s.plus(d(r.cogs)), d(0));
  // Margin on what the customer kept: returned items come off both the price and the cost.
  const profit = d(sale.total).minus(returnedTotal).minus(d(sale.cogs ?? 0).minus(returnedCost));
  // What returns took off what the customer owes (all of a return with no refund account, and the unpaid
  // part first of one paid back from a drawer), read from their journals: it reduces this sale's credit.
  const creditedReturns = sale.returns.reduce((s, r) => s.plus(d(r.refundToBalanceUsd ?? (r.refundAccountId ? 0 : r.total))), d(0));
  const credit = d(sale.creditUsd);
  // The credit returns took off, however they were refunded: one given back in cash once the credit was
  // settled (by an avoir, or a payment since) takes it off too (the server's creditLeftUsd, as on the list).
  const creditLeft = sale.creditLeftUsd !== undefined ? d(sale.creditLeftUsd) : Decimal.max(credit.minus(creditedReturns), 0);
  const creditReduced = credit.gt(0) && creditLeft.lt(credit);
  const customerBalance = customers.data?.find((p) => p.id === sale.customerId)?.balance;
  const customerOwes = customerBalance === undefined ? null : d(customerBalance);
  // Cash handed back on returns: "Payé" reads net of it, as on the Sales list, and is the cash really kept
  // (the till's francs and the refunds' at their rates), so Payé − Total is the "Arrondi FC" below it.
  const refunded = sale.returns.reduce((s, r) => s.plus(d(r.refundUsd)), d(0));
  // A cancelled sale reads what its receipt said was kept (the till's franc rounding in), all of it given back.
  const paidNet = sale.paidKeptUsd !== undefined ? d(sale.paidKeptUsd) : voided ? d(sale.paidUsd) : d(sale.paidUsd).minus(refunded);
  const netTotal = voided ? d(sale.total) : d(sale.total).minus(returnedTotal);
  // Francs change and refunds go in 100 FC steps, so "Payé" can differ from the total by a few cents: the
  // "Arrondi FC" of the books, the same figure and sign as on the Sales list, the till's and the refunds' together.
  const francRounding = voided ? null : fcRounding(t, sale.fcRoundingUsd ?? 0);
  // The avoir's part as it was at the sale (198 $ of 250 $: 52 $ on credit), so the credit given is the
  // customer's real debt; the avoir used after returns comes capped at the credit left (see avoirUsedSql),
  // so what is still owed is the credit left less it, the one figure of the list, balance and daily report.
  const avoir = avoirSplit({ ...sale, avoirUsedUsd: sale.avoirAtSaleUsd ?? sale.avoirUsedUsd });
  const stillOwed = Decimal.max(creditLeft.minus(d(sale.avoirUsedUsd ?? 0)), 0);
  const owedReduced = credit.gt(0) && stillOwed.lt(avoir.toPay);
  // Columns only when a line uses them, so the margin stays in view at 1024 px.
  const hasChassis = sale.lines.some((l) => l.chassisNo || l.engineNo);
  const hasDiscount = sale.lines.some((l) => d(l.lineDiscount).gt(0));
  /** What came back of one line: its amount from the return slips, its cost the share the server took. */
  const returnedOf = (l: SaleFull["lines"][number]) => {
    const rq = d(l.returnedQty);
    const amount = sale.returns.reduce((s, r) => s.plus((r.lines ?? []).filter((x) => x.saleLineId === l.id).reduce((a, x) => a.plus(d(x.amount)), d(0))), d(0));
    const cogs = l.cogs === undefined || rq.isZero() ? d(0) : rq.gte(d(l.qty)) ? d(l.cogs) : d(l.cogs).times(rq).dividedBy(d(l.qty)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return { amount, cogs };
  };

  return (
    <div>
      <Link href="/sales" className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> {t("Sales", "Ventes")}
      </Link>
      <PageHeader
        title={`${t("Sale", "Vente")} ${sale.number}`}
        description={`${fmtDate(sale.date)}${sale.customer ? ` · ${sale.customer.name}` : ` · ${t("Walk-in customer", "Client de passage")}`}`}
        actions={
          <>
            <Button variant="outline" onClick={() => setDialog("receipt")}><Printer className="mr-1 h-4 w-4" /> {t("Print receipt", "Imprimer le reçu")}</Button>
            {can("manager") && canReturn && (
              <Button variant="outline" onClick={() => setDialog("return")}><Undo2 className="mr-1 h-4 w-4" /> {t("Return items", "Retour d'articles")}</Button>
            )}
            {can("manager") && !voided && sale.returns.length === 0 && (
              <Button variant="destructive" onClick={() => setDialog("void")}><Ban className="mr-1 h-4 w-4" /> {t("Cancel sale", "Annuler la vente")}</Button>
            )}
            {can("manager") && !voided && sale.returns.length > 0 && (
              <SubmitButton
                variant="outline"
                blocked={t("Has returns: it cannot be cancelled; use Return items for the rest", "A des retours\u00a0: annulation impossible, utilisez Retour d'articles pour le reste")}
              >
                <Ban className="mr-1 h-4 w-4" /> {t("Cancel sale", "Annuler la vente")}
              </SubmitButton>
            )}
          </>
        }
      />

      {!can("manager") && !voided && (
        <p className="mb-3 text-sm text-muted-foreground">{t("To return items or cancel this sale, ask a manager or the owner.", "Pour un retour ou une annulation, demandez à un gérant ou au propriétaire.")}</p>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {voided ? <Badge variant="destructive">{t("Cancelled", "Annulée")}</Badge> : <Badge variant="secondary">{t("Completed", "Terminée")}</Badge>}
        {sale.returns.length > 0 && <Badge variant="outline">{t("Has returns", "Avec retours")}</Badge>}
        {!voided && <SaleFlags zeroPrice={sale.lines.some((l) => d(l.unitPrice).lte(0))} total={sale.total} cogs={sale.cogs} />}
        {/* A cancelled sale owes nothing: its credit went back with it. */}
        {voided && credit.gt(0) && <Badge variant="outline" className="text-muted-foreground">{t("Credit cancelled", "Crédit annulé")} {usd(sale.creditUsd)}</Badge>}
        {credit.gt(0) && !voided &&
          (avoir.used.gt(0) && !owedReduced ? (
            <>
              <Badge variant="outline">{t("Settled from the customer's credit", "Réglé sur l'avoir")} {usd(avoir.used.toFixed(2))}</Badge>
              {avoir.toPay.gt(0) && <Badge variant="outline">{t("On credit (to pay)", "À crédit (reste à payer)")} {usd(avoir.toPay.toFixed(2))}</Badge>}
            </>
          ) : !owedReduced ? (
            <Badge variant="outline">{t("On credit", "À crédit")} {usd(sale.creditUsd)}</Badge>
          ) : stillOwed.gt(0) ? (
            <Badge variant="outline">{t("Still on credit", "Reste à crédit")} {usd(stillOwed.toFixed(2))}</Badge>
          ) : (
            <Badge variant="outline">{t("Credit cleared by returns", "Crédit soldé par les retours")}</Badge>
          ))}
      </div>
      {voided && (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {t("Cancelled", "Annulée")}{sale.voidedAt ? ` ${fmtDate(String(sale.voidedAt))}` : ""}{t(": ", "\u00a0: ")}{sale.voidReason}
        </p>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase text-muted-foreground">{t("Total", "Total")}</p>
            {/* What the customer kept, as on the Sales list; the till's total below it. */}
            <p className="text-xl font-semibold tabular">{usd(netTotal.toFixed(2))}</p>
            {returnedTotal.gt(0) && <p className="text-xs text-muted-foreground">{t("of", "sur")} {usd(sale.total)} · {t("returned", "retourné")} −{usd(returnedTotal.toFixed(2))}</p>}
            {d(sale.discount).gt(0) && <p className="text-xs text-muted-foreground">{t("Sale discount", "Remise")} {usd(sale.discount)}</p>}
          </CardContent>
        </Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-muted-foreground">{t("Paid", "Payé")}</p><p className={`text-xl font-semibold tabular${voided ? " text-muted-foreground line-through" : ""}`}>{usd(paidNet.toFixed(2))}</p>{voided && <p className="text-xs text-muted-foreground" data-testid="sale-voided-paid">{[t("cancelled", "annulé"), paidNet.gt(0) ? t("refunded", "remboursé") : null, credit.gt(0) ? `${t("credit cancelled", "crédit annulé")} ${usd(sale.creditUsd)}` : null].filter(Boolean).join(" · ")}</p>}{!voided && refunded.gt(0) && <p className="text-xs text-muted-foreground">{t("refunded", "remboursé")} −{usd(refunded.toFixed(2))} · {t("of", "sur")} {usd(d(sale.paidUsd).plus(d(sale.saleFcRoundingUsd ?? 0)).toFixed(2))}</p>}{francRounding && <p className="text-xs text-muted-foreground" data-testid="sale-fc-rounding">{sale.returns.length ? t("FC rounding (sale + returns)", "Arrondi FC (vente + retours)") : t("FC rounding", "Arrondi FC")} {francRounding.figure} · {francRounding.words}</p>}{/* No credit line on a cancelled sale (said above) nor on one paid in full. */}{!voided && (credit.gt(0) || avoir.used.gt(0)) && <p className="text-xs text-muted-foreground">{/* The avoir's part is not credit: 250 $ with 198 $ on the avoir is 52 $ on credit. */}{avoir.used.gt(0)
                ? avoir.toPay.gt(0)
                  ? `${t("On credit", "À crédit")} ${usd(avoir.toPay.toFixed(2))} · ${t("from the customer's credit", "sur l'avoir")} ${usd(avoir.used.toFixed(2))}`
                  : `${t("From the customer's credit", "Sur l'avoir")} ${usd(avoir.used.toFixed(2))}`
                : `${t("Credit", "Crédit")} ${usd(sale.creditUsd)}`}{owedReduced ? ` · ${t("after returns", "après retours")} ${usd(stillOwed.toFixed(2))}` : ""}</p>}</CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-muted-foreground">{t("Customer", "Client")}</p>{sale.customer ? <p className="font-medium">{sale.customer.name}</p> : <p className="text-muted-foreground">{t("Walk-in", "De passage")}</p>}{sale.customer?.phone && <p className="text-xs text-muted-foreground">{sale.customer.phone}</p>}</CardContent></Card>
        {showCost && sale.cogs !== undefined && !voided && (
          <Card><CardContent className="p-4"><p className="text-xs uppercase text-muted-foreground">{t("Cost / profit", "Coût / marge")}</p><p className="text-xl font-semibold tabular">{usd(profit.toFixed(2))}</p><p className="text-xs text-muted-foreground">{t("Cost of goods", "Coût des articles")} {usd(d(sale.cogs).minus(returnedCost).toFixed(2))}{returnedTotal.gt(0) ? ` · ${t("after returns", "après retours")}` : ""}</p></CardContent></Card>
        )}
      </div>

      <Card className="mb-4">
        <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Items", "Articles")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Item", "Article")}</TableHead>
                  <TableHead>{t("SKU", "Code")}</TableHead>
                  {hasChassis && <TableHead>{t("Chassis / engine", "Châssis / moteur")}</TableHead>}
                  <TableHead className="text-right">{t("Qty", "Qté")}</TableHead>
                  <TableHead className="text-right">{t("Returned", "Retourné")}</TableHead>
                  <TableHead className="text-right">{t("Price", "Prix")}</TableHead>
                  {hasDiscount && <TableHead className="text-right">{t("Discount", "Remise")}</TableHead>}
                  <TableHead className="text-right">{t("Total", "Total")}</TableHead>
                  {/* A cancelled sale earned nothing: no cost or profit per line, as none on the cards above. */}
                  {showCost && !voided && <TableHead className="text-right">{t("Cost", "Coût")}</TableHead>}
                  {showCost && !voided && <TableHead className="text-right">{t("Profit", "Marge")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sale.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell><span className="font-medium">{l.productName}</span> <span className="text-muted-foreground">{variantText(l.attributes)}</span></TableCell>
                    <TableCell className="font-mono text-xs">{l.sku}</TableCell>
                    {hasChassis && <TableCell className="text-xs">{l.chassisNo ?? ""}{l.engineNo ? <span className="block text-muted-foreground">{l.engineNo}</span> : null}</TableCell>}
                    <TableCell className="text-right"><Num>{fmtQty(l.qty)}</Num></TableCell>
                    <TableCell className="text-right"><Num className={cn(d(l.returnedQty).gt(0) ? "text-amber-800 dark:text-amber-400" : "text-muted-foreground")}>{fmtQty(l.returnedQty)}</Num></TableCell>
                    <TableCell className="text-right"><Num>{usd(l.unitPrice)}</Num></TableCell>
                    {hasDiscount && <TableCell className="text-right"><Num>{d(l.lineDiscount).gt(0) ? usd(l.lineDiscount) : ""}</Num></TableCell>}
                    <TableCell className="text-right"><Num className="font-medium">{usd(l.lineTotal)}</Num></TableCell>
                    {showCost && !voided && <TableCell className="text-right"><Num>{l.cogs !== undefined ? usd(l.cogs) : ""}</Num></TableCell>}
                    {showCost && !voided && <TableCell className="text-right"><LineProfit l={l} returned={returnedOf(l)} /></TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {d(sale.discount).gt(0) && (
            <p className="px-4 py-2 text-xs text-muted-foreground">{t("Line discounts include each line's share of the sale discount.", "Les remises par ligne incluent la part de la remise sur la vente.")}</p>
          )}
          {sale.note && <p className="px-4 pb-3 text-sm"><span className="text-muted-foreground">{t("Note", "Note")}{t(":", "\u00a0:")}</span> {sale.note}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Payments", "Paiements")}</CardTitle></CardHeader>
          <CardContent className="p-4 pt-0">
            {sale.payments.length === 0 ? (
              <EmptyState
                title={
                  avoir.used.gt(0) && avoir.toPay.gt(0)
                    ? t(`No payment: ${usd(avoir.used.toFixed(2))} from the customer's credit, ${usd(avoir.toPay.toFixed(2))} on credit`, `Aucun paiement\u00a0: ${usd(avoir.used.toFixed(2))} sur l'avoir, ${usd(avoir.toPay.toFixed(2))} à crédit`)
                    : avoir.used.gt(0)
                      ? t("No payment: settled from the customer's credit", "Aucun paiement\u00a0: réglé sur l'avoir")
                      : voided
                        ? t("No payment: the credit was cancelled with the sale", "Aucun paiement\u00a0: le crédit est annulé avec la vente")
                        : t("No payment: fully on credit", "Aucun paiement\u00a0: tout à crédit")
                }
              />
            ) : (
              <div className="divide-y text-sm">
                {sale.payments.map((p) => (
                  <div key={p.id} className="flex justify-between gap-2 py-2">
                    <span>{d(p.amountUsd).isNegative() ? `${t("Change given", "Monnaie rendue")} · ` : ""}{accName(p.accountId)}{p.rate ? <span className="text-xs text-muted-foreground"> · {t("rate", "taux")} {fmtQty(p.rate)}</span> : null}</span>
                    <Num className="font-medium">{paymentText(p)}</Num>
                  </div>
                ))}
                {credit.gt(0) && !voided && <CreditRows creditedReturns={creditedReturns} stillOwed={stillOwed} owes={customerOwes} avoir={avoir} />}
                {credit.gt(0) && voided && (
                  <div className="flex justify-between gap-2 py-2 text-muted-foreground" data-testid="credit-cancelled">
                    <span>{t("Credit cancelled with the sale", "Crédit annulé avec la vente")}</span>
                    <Num className="line-through">{usd(sale.creditUsd)}</Num>
                  </div>
                )}
              </div>
            )}
            {sale.payments.length === 0 && !voided && (creditReduced || creditedReturns.gt(0) || avoir.used.gt(0)) && (
              <div className="mt-2 divide-y text-sm">
                <CreditRows creditedReturns={creditedReturns} stillOwed={stillOwed} owes={customerOwes} avoir={avoir} />
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2"><CardTitle className="text-base">{t("Returns", "Retours")}</CardTitle></CardHeader>
          <CardContent className="p-4 pt-0">
            {sale.returns.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("No returns.", "Aucun retour.")}</p>
            ) : (
              <div className="divide-y text-sm">
                {sale.returns.map((r) => (
                  <div key={r.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{r.number} · {fmtDate(r.date)}</span>
                      <span className="flex items-center gap-1">
                        <Num className="font-medium">{usd(r.total)}</Num>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSlipId(r.id)} aria-label={t("Print return slip", "Imprimer le bon de retour")} title={t("Print return slip", "Imprimer le bon de retour")}>
                          <Printer className="h-4 w-4" />
                        </Button>
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {r.refundAccountId
                        ? `${t("Refunded from", "Remboursé depuis")} ${accName(r.refundAccountId)}${r.refundCurrency === "CDF" && r.refundNative ? ` · ${cdf(r.refundNative)} (${usd(r.refundUsd ?? "0")})` : ""}`
                        : r.offDebtUsd != null
                          ? [
                              returnBalanceParts(r).offDebt.gt(0) && `${t("Taken off the debt", "Déduit de la dette")} ${usd(returnBalanceParts(r).offDebt.toFixed(2))}`,
                              returnBalanceParts(r).toAvoir.gt(0) && `${t("Kept as customer credit", "Mis en avoir")} ${usd(returnBalanceParts(r).toAvoir.toFixed(2))}`,
                            ].filter(Boolean).join(" · ")
                          : t("Taken off the customer's balance", "Déduit du solde du client")}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {dialog === "receipt" && <ReceiptDialog sale={sale} onClose={() => setDialog(null)} />}
      {dialog === "return" && (
        <ReturnDialog
          sale={sale}
          owes={customerOwes}
          onClose={() => setDialog(null)}
          onDone={(s) => {
            setDialog(null);
            // Offer the slip of the return just recorded.
            const last = [...(s.returns ?? [])].sort((a, b) => b.id - a.id)[0];
            if (last) setSlipId(last.id);
          }}
        />
      )}
      {slipId && sale.returns.find((r) => r.id === slipId) && (
        <ReturnSlipDialog sale={sale} ret={sale.returns.find((r) => r.id === slipId)!} accName={accName} onClose={() => setSlipId(null)} />
      )}
      {dialog === "void" && <VoidDialog sale={sale} accName={accName} onClose={() => setDialog(null)} />}
    </div>
  );
}
