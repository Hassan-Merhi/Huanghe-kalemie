import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, HandCoins, Pencil, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton, unclearAmount } from "@/components/common";
import { MoneyAccountSelect, PARTY_LABELS, RateInput, useRate, useRateField } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { cdf, curLabel, d, date as fmtDate, money, number as fmtNumber, qty as fmtQty, todayLocal, usd } from "@/lib/format";
import type { Account, Party } from "@/lib/types";
import { cn } from "@/lib/utils";
import { paymentSplit, type PaymentPart } from "@/lib/allocation";
import Decimal from "decimal.js";
import { BalanceWords, foreignText, PartyDialog, type ForeignBalance } from "@/pages/Contacts";
import { useSystemText } from "@/lib/systemText";

interface StatementRow {
  journalId: number;
  number: string;
  date: string;
  type: string;
  memo: string | null;
  debit: string;
  credit: string;
  currency: string;
  nativeAmount: string | null;
  sourceType: string | null;
  sourceId: number | null;
  balance: string;
  /** Money actually paid, when the contact's line is at the average cost of the francs or yuan settled. */
  paid?: string;
  /** What the booked amount adds to `paid`: the exchange difference. */
  fxDiff?: string;
}
interface Statement {
  party: Omit<Party, "balance">;
  rows: StatementRow[];
  balance: string;
  foreign: ForeignBalance[];
}

export function journalTypeLabel(type: string, t: (en: string, fr: string) => string): string {
  const map: Record<string, [string, string]> = {
    opening: ["Opening balance", "Solde d'ouverture"],
    manual: ["Manual entry", "Écriture manuelle"],
    sale: ["Sale", "Vente"],
    sale_void: ["Sale cancelled", "Vente annulée"],
    sale_return: ["Return", "Retour"],
    customer_receipt: ["Customer payment", "Paiement client"],
    supplier_payment: ["Payment made", "Paiement effectué"],
    container_expense: ["Container cost", "Frais de conteneur"],
    container_finalize: ["Container offloaded", "Conteneur déchargé"],
    container_reversal: ["Container reversed", "Conteneur annulé"],
    expense: ["Expense", "Dépense"],
    transfer: ["Transfer", "Transfert"],
    partner_contribution: ["Capital put in", "Apport en capital"],
    partner_withdrawal: ["Withdrawal", "Retrait"],
    stock_adjustment: ["Stock adjustment", "Ajustement de stock"],
    payment: ["Payment voucher", "Pièce de paiement"],
    receipt: ["Receipt voucher", "Pièce de recette"],
    payroll: ["Salaries", "Salaires"],
    revaluation: ["Month-end revaluation", "Réévaluation de fin de mois"],
    period_close: ["Month close", "Clôture du mois"],
    reversal: ["Reversal", "Annulation"],
  };
  const m = map[type];
  return m ? t(m[0], m[1]) : type;
}

/** Wide print layout on top of the receipt print rules. */
export const WIDE_PRINT_CSS = `@media print {
  .print-area.print-wide { width: 100% !important; font-size: 12px !important; }
  .print-area .no-print { display: none !important; }
  .print-area table { width: 100%; border-collapse: collapse; }
  .print-area th, .print-area td { border-bottom: 1px solid #ccc; padding: 3px 4px; }
}`;

export default function ContactDetail() {
  const t = useT();
  const sys = useSystemText();
  const { can, user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  // A cashier sees customers only: a supplier's link says so without asking the server for a statement it refuses.
  const cashier = user?.role === "cashier";
  const customers = useQuery<Party[]>({ queryKey: ["/api/parties", { type: "customer" }], enabled: cashier });
  const notCustomer = cashier && !!customers.data && !customers.data.some((p) => String(p.id) === id);
  const q = useQuery<Statement>({ queryKey: [`/api/parties/${id}/statement`], enabled: !cashier || (!!customers.data && !notCustomer) });

  if (notCustomer) {
    return (
      <div>
        <Link href="/contacts" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {t("Customers", "Clients")}
        </Link>
        <EmptyState title={t("Not a customer", "Ce contact n'est pas un client")}>
          {t("The till works with customers only.", "La caisse ne voit que les clients.")}
        </EmptyState>
      </div>
    );
  }
  if (q.isLoading || (cashier && customers.isLoading)) return <Loading />;
  if (q.error || !q.data) return <ErrorText error={q.error ?? t("Not found", "Introuvable")} />;
  const { party, rows, balance, foreign } = q.data;
  const isCustomer = party.type === "customer";
  const typeLabel = t(PARTY_LABELS[party.type][0], PARTY_LABELS[party.type][1]);
  const canPay = isCustomer ? can("manager", "cashier") : can("manager");

  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <Link href="/contacts" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {cashier ? t("Customers", "Clients") : t("Customers and suppliers", "Clients et fournisseurs")}
      </Link>
      <PageHeader
        title={party.name}
        description={[typeLabel, party.phone].filter(Boolean).join(" · ")}
        actions={
          <>
            {canPay && (
              <Button onClick={() => setPaying(true)}>
                <HandCoins className="mr-1 h-4 w-4" /> {isCustomer ? t("Record payment", "Enregistrer un paiement") : t("Pay", "Payer")}
              </Button>
            )}
            {can("manager") && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="mr-1 h-4 w-4" /> {t("Edit", "Modifier")}
              </Button>
            )}
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="mr-1 h-4 w-4" /> {t("Print statement", "Imprimer le relevé")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Balance", "Solde")}</p>
            <p className="mt-1 text-2xl font-semibold"><BalanceWords balance={balance} /></p>
            {foreign.map((f) => (
              <p key={f.currency} className="mt-1 text-sm text-muted-foreground">
                {t("Of which", "Dont")} {foreignText(f, t)} <span className="tabular">({usd(d(f.usd).abs().toFixed(2))})</span>
              </p>
            ))}
          </CardContent>
        </Card>
        <Card className="sm:col-span-2">
          <CardContent className="space-y-1 p-4 text-sm">
            <p>
              <span className="text-muted-foreground">{t("Phone:", "Téléphone\u00a0:")} </span>
              {party.phone || "—"}
              {!party.active && <Badge variant="secondary" className="ml-2">{t("Inactive", "Inactif")}</Badge>}
            </p>
            {party.notes && <p className="whitespace-pre-wrap text-muted-foreground">{party.notes}</p>}
          </CardContent>
        </Card>
      </div>

      <Card className="print-area print-wide">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {t("Statement", "Relevé de compte")} · {party.name}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("Printed", "Imprimé le")} {fmtDate(todayLocal())} · {t("Balance:", "Solde\u00a0:")} <BalanceWords balance={balance} />
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="p-4"><EmptyState title={t("No movements yet", "Aucun mouvement")} /></div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date", "Date")}</TableHead>
                    <TableHead>{t("No.", "N°")}</TableHead>
                    <TableHead>{t("Type", "Type")}</TableHead>
                    <TableHead>{t("Details", "Détails")}</TableHead>
                    <TableHead className="text-right">{t("Debit", "Débit")}</TableHead>
                    <TableHead className="text-right">{t("Credit", "Crédit")}</TableHead>
                    <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={`${r.journalId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {r.sourceType === "sale" && r.sourceId ? (
                          <Link href={`/sales/${r.sourceId}`} className="text-primary underline-offset-2 hover:underline">{r.number}</Link>
                        ) : (
                          r.number
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{journalTypeLabel(r.type, t)}</TableCell>
                      <TableCell className="min-w-[160px]">
                        {sys.memo(r.memo)}
                        {r.nativeAmount && r.currency !== "USD" && !d(r.nativeAmount).isZero() && (
                          <span className="block text-xs text-muted-foreground tabular">
                            {money(d(r.nativeAmount).abs().toString(), r.currency)}
                          </span>
                        )}
                      </TableCell>
                      {(["debit", "credit"] as const).map((side) => (
                        <TableCell key={side} className="text-right">
                          {d(r[side]).isZero() ? null : r.paid && r.fxDiff ? (
                            <>
                              <Num>{usd(r.paid)}</Num>
                              <span className="block whitespace-nowrap text-xs text-muted-foreground">
                                {d(r.fxDiff).isNegative() ? "\u2212" : "+"}{usd(d(r.fxDiff).abs().toFixed(2))} {t("exchange difference", "écart de change")}
                              </span>
                            </>
                          ) : (
                            <Num>{usd(r[side])}</Num>
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right whitespace-nowrap"><BalanceWords balance={r.balance} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {paying && <PaymentDialog party={party} balance={balance} foreign={foreign} onClose={() => setPaying(false)} />}
      {editing && <PartyDialog type={party.type} party={{ ...party, balance }} onClose={() => setEditing(false)} />}
    </div>
  );
}

function PaymentDialog({ party, balance, foreign, onClose }: { party: Statement["party"]; balance: string; foreign: ForeignBalance[]; onClose: () => void }) {
  const t = useT();
  const isCustomer = party.type === "customer";
  const [day, setDay] = useState(todayLocal());
  const [account, setAccount] = useState<Account | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const { rate, setRate } = useRateField(day);
  const isCdf = account?.currency === "CDF";
  const usdEquivalent = isCdf && d(rate).gt(0) ? d(amount).dividedBy(d(rate)).toFixed(2) : null;
  const mutation = useApiMutation("POST", isCustomer ? "/api/money/customer-receipt" : "/api/money/party-payment", {
    success: t("Payment saved", "Paiement enregistré"),
    onSuccess: onClose,
  });
  const b = d(balance);
  const outstanding = isCustomer ? (b.gt(0) ? b : null) : b.isNegative() ? b.abs() : null;
  // What is owed in francs (or yuan) in the direction of this payment.
  const owedIn = (cur: "CDF" | "CNY") => {
    const f = foreign.find((x) => x.currency === cur);
    if (!f) return null;
    const n = d(f.native);
    return isCustomer ? (n.gt(0) ? n : null) : n.isNegative() ? n.abs() : null;
  };
  const fcOwed = owedIn("CDF");
  const cnyOwed = !isCustomer && account?.currency === "USD" ? owedIn("CNY") : null;
  const [settleCny, setSettleCny] = useState("");
  // Dollars paid for yuan: what the yuan owed are worth at the rate on file, and the rate this payment implies.
  const cnyRate = useRate(day).data?.cnyPerUsd ?? null;
  const cnyForeign = foreign.find((x) => x.currency === "CNY");
  const cnyRef = cnyRate && d(cnyRate).gt(0) ? d(cnyRate) : cnyForeign && !d(cnyForeign.usd).isZero() ? d(cnyForeign.native).abs().dividedBy(d(cnyForeign.usd).abs()) : null;
  const cnyOwedUsd = cnyOwed && cnyRef ? cnyOwed.dividedBy(cnyRef) : null;
  const impliedCny = cnyOwed && d(settleCny).gt(0) && d(amount).gt(0) ? d(settleCny).dividedBy(d(amount)) : null;
  const impliedGap = impliedCny && cnyRef ? impliedCny.minus(cnyRef).abs().dividedBy(cnyRef).times(100) : null;
  // Which debts this payment reduces, in the server's order (payablesLines, contactLines, payParty).
  const dollarBalance = d(balance).minus(foreign.reduce((x, f) => x.plus(d(f.usd)), d(0)));
  const split = account && d(amount).gt(0) && (isCdf ? d(rate).gt(0) : account.currency === "USD")
    ? paymentSplit({
        usd: isCdf ? d(amount).dividedBy(d(rate)) : d(amount),
        francs: isCdf ? d(amount) : null,
        rate: d(rate).gt(0) ? d(rate) : null,
        owedUsd: Decimal.max(isCustomer ? dollarBalance : dollarBalance.negated(), 0),
        owedFc: fcOwed ?? d(0),
        owedCny: isCustomer ? undefined : owedIn("CNY") ?? undefined,
        cnyRate: cnyRef,
        settleCny: cnyOwed && d(settleCny).gt(0) ? d(settleCny) : null,
      })
    : [];
  const partText = (p: PaymentPart) =>
    p.kind === "usd"
      ? t(`${usd(p.usd)} of the dollar debt`, `${usd(p.usd)} de la dette en dollars`)
      : p.kind === "cdf"
        ? t(`${cdf(p.native)} of the franc debt (${usd(p.usd)})`, `${cdf(p.native)} de la dette en francs (${usd(p.usd)})`)
        : p.kind === "cny"
          ? t(`${money(p.native, "CNY")} of the yuan debt (${usd(p.usd)})`, `${money(p.native, "CNY")} de la dette en yuans (${usd(p.usd)})`)
          : "";
  const settled = split.filter((p) => p.kind !== "advance");
  const advance = split.find((p) => p.kind === "advance");
  const advanceText = advance
    ? isCustomer
      ? t(`${usd(advance.usd)} stays to the customer's credit`, `${usd(advance.usd)} restent au crédit du client`)
      : t(`${usd(advance.usd)} is an advance`, `${usd(advance.usd)} constituent une avance`)
    : "";
  const splitText = cnyOwed && d(settleCny).gt(0) && split[0]?.kind === "cny"
    ? t(`These ${usd(split[0].usd)} settle ${money(split[0].native, "CNY")} of the yuan debt.`, `Ces ${usd(split[0].usd)} règlent ${money(split[0].native, "CNY")} de la dette en yuans.`)
    : settled.length
      ? t(`This payment settles ${settled.map(partText).join(", then ")}${advance ? `; ${advanceText}` : ""}.`, `Ce paiement règle ${settled.map(partText).join(", puis ")}${advance ? `\u00a0; ${advanceText}` : ""}.`)
      : advance
        ? t(`Nothing is owed: ${advanceText}.`, `Rien n'est dû\u00a0: ${advanceText}.`)
        : "";
  /** The dollar amount looks like the yuan figure (50 550 typed for 50 550 ¥): far more dollars than the yuan are worth. */
  const looksLikeYuan = !!cnyOwedUsd && d(amount).gt(cnyOwedUsd.times(2)) && (!impliedGap || impliedGap.gt(20));
  const blocked = !account
    ? t("Choose an account", "Choisissez un compte")
    : unclearAmount(t, amount, account.currency) ?? (cnyOwed ? unclearAmount(t, settleCny, "CNY") : null) ?? (!d(amount).gt(0)
      ? t("Enter an amount above zero", "Saisissez un montant supérieur à zéro")
      : isCdf && !d(rate).gt(0)
        ? t("Enter the exchange rate", "Saisissez le taux de change")
        : cnyOwed && settleCny && !d(settleCny).lte(cnyOwed)
          ? t("The yuan settled are more than what is owed", "Les yuans réglés dépassent ce qui est dû")
          : null);

  function save() {
    if (!account) return;
    mutation.mutate({
      date: day,
      partyId: party.id,
      accountId: account.id,
      amount: d(amount).toFixed(2),
      ...(isCdf ? { rate: d(rate).toString() } : {}),
      ...(cnyOwed && d(settleCny).gt(0) ? { settleNative: d(settleCny).toFixed(2) } : {}),
      memo: memo.trim() || null,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCustomer ? t("Payment from customer", "Paiement du client") : t(`Pay ${PARTY_LABELS[party.type][0].toLowerCase()}`, `Payer ${party.type === "agent" || party.type === "employee" ? "l'" : "le "}${PARTY_LABELS[party.type][1].toLowerCase()}`)}</DialogTitle>
          <DialogDescription>
            {party.name}
            {outstanding && (
              <> · {isCustomer ? t(`owes us ${usd(outstanding.toFixed(2))}`, `nous doit ${usd(outstanding.toFixed(2))}`) : t(`we owe ${usd(outstanding.toFixed(2))}`, `nous devons ${usd(outstanding.toFixed(2))}`)}</>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={isCustomer ? t("Received into", "Reçu dans") : t("Paid from", "Payé depuis")} required>
            <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
          </Field>
          <Field
            label={t(`Amount (${curLabel(account?.currency ?? "USD")})`, `Montant (${curLabel(account?.currency ?? "USD")})`)}
            error={
              looksLikeYuan
                ? t(
                    `That is far more dollars than the ${money(cnyOwed!.toString(), "CNY")} owed are worth (≈ ${usd(cnyOwedUsd!.toFixed(2))}): type the dollars paid, not the yuan`,
                    `C'est bien plus de dollars que ne valent les ${money(cnyOwed!.toString(), "CNY")} dus (≈ ${usd(cnyOwedUsd!.toFixed(2))})\u00a0: saisissez les dollars payés, pas les yuans`,
                  )
                : null
            }
            required
          >
            <div className="flex gap-2">
              <Input inputMode="decimal" usd={!isCdf} thousands={isCdf} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              {outstanding && !isCdf && !cnyOwed && (
                <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setAmount(outstanding.toFixed(2))}>
                  {t("All", "Tout")}
                </Button>
              )}
              {isCdf && fcOwed && (
                <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setAmount(fcOwed.toFixed(0))}>
                  {t("All", "Tout")}
                </Button>
              )}
            </div>
          </Field>
          {split.length > 0 ? (
            <p className="text-xs text-muted-foreground sm:col-span-2" data-testid="payment-split">{splitText}</p>
          ) : fcOwed && !(cnyOwed && d(settleCny).gt(0)) ? (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {isCdf
                ? t(
                    `${cdf(fcOwed.toString())} are owed in francs: francs paid settle them first, and any difference in value is an exchange gain or loss.`,
                    `${cdf(fcOwed.toString())} sont dus en francs\u00a0: des francs payés les règlent d'abord, et l'écart de valeur est un gain ou une perte de change.`,
                  )
                : t(
                    `${cdf(fcOwed.toString())} are owed in francs: dollars paid settle the dollars owed first, then the francs at the day's rate.`,
                    `${cdf(fcOwed.toString())} sont dus en francs\u00a0: des dollars payés règlent d'abord les dollars dus, puis les francs au taux du jour.`,
                  )}
            </p>
          ) : null}
          {cnyOwed && (
            <Field
              label={t("Yuan settled by this payment (¥)", "Yuans réglés par ce paiement (¥)")}
              hint={
                <>
                  {t(
                    `Owed: ${money(cnyOwed.toString(), "CNY")}${cnyOwedUsd ? ` ≈ ${usd(cnyOwedUsd.toFixed(2))} at the rate on file` : ""}. The difference with the invoice value is an exchange gain or loss.`,
                    `Dû\u00a0: ${money(cnyOwed.toString(), "CNY")}${cnyOwedUsd ? ` ≈ ${usd(cnyOwedUsd.toFixed(2))} au taux enregistré` : ""}. L'écart avec la valeur de la facture est un gain ou une perte de change.`,
                  )}
                  {impliedCny && (
                    <span className={cn("block", impliedGap && impliedGap.gt(5) && "font-medium text-amber-800 dark:text-amber-400")}>
                      {t(`This payment: ${fmtNumber(impliedCny.toString(), 2)} ¥ for $1`, `Ce paiement\u00a0: ${fmtNumber(impliedCny.toString(), 2)}\u00a0¥ pour 1\u00a0$`)}
                      {cnyRef && t(` (on file ${fmtNumber(cnyRef.toString(), 2)})`, ` (enregistré\u00a0: ${fmtNumber(cnyRef.toString(), 2)})`)}
                      {impliedGap && impliedGap.gt(5) && t(": check the amounts", "\u00a0: vérifiez les montants")}
                    </span>
                  )}
                </>
              }
              error={d(settleCny).gt(cnyOwed) ? t("More than what is owed", "Plus que ce qui est dû") : null}
              className="sm:col-span-2"
            >
              <div className="flex gap-2">
                <Input inputMode="decimal" currency="CNY" aria-label={t("Yuan settled (¥)", "Yuans réglés (¥)")} value={settleCny} onChange={(e) => setSettleCny(e.target.value)} placeholder="0" />
                <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setSettleCny(cnyOwed.toFixed(2))}>{t("All", "Tout")}</Button>
              </div>
            </Field>
          )}
          {isCdf && (
            <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} hint={usdEquivalent ? `= ${usd(usdEquivalent)}` : undefined} required>
              <RateInput day={day} value={rate} onChange={setRate} />
            </Field>
          )}
          <Field label={t("Note", "Note")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={save} blocked={blocked} pending={mutation.isPending}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
