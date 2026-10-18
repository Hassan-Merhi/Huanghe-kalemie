import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, HandCoins, Pencil, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton, unclearAmount } from "@/components/common";
import { MoneyAccountSelect, PARTY_LABELS, RateInput, useAccounts, useRate, useRateField } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { cdf, curLabel, d, date as fmtDate, money, number as fmtNumber, qty as fmtQty, todayLocal, typedNumberOk, usd } from "@/lib/format";
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
  /** Francs handed over for a dollar line paid out of (or into) a franc box. */
  tendered?: string;
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
                      <TableCell className="min-w-[7rem]">{journalTypeLabel(r.type, t)}</TableCell>
                      <TableCell className="min-w-[160px]">
                        {sys.memo(r.memo)}
                        {r.nativeAmount && r.currency !== "USD" && !d(r.nativeAmount).isZero() && (
                          <span className="block text-xs text-muted-foreground tabular">
                            {money(d(r.nativeAmount).abs().toString(), r.currency)}
                          </span>
                        )}
                        {r.tendered && (
                          <span className="block text-xs text-muted-foreground tabular" data-testid="tendered">
                            {t(`paid ${cdf(r.tendered)}`, `payé ${cdf(r.tendered)}`)}
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
                      {/* "nous devons" over the amount when it is long, so the column stays in view at 1280 px. */}
                      <TableCell className="min-w-[8.5rem] text-right"><BalanceWords balance={r.balance} /></TableCell>
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
  // The drawer's balance before and after, as on the vouchers form; a payment it cannot cover is stopped here.
  const { can } = useAuth();
  const balances = useAccounts("/api/accounts/balances", { enabled: can("manager", "partner") }).data;
  const drawer = account ? balances?.find((a) => a.id === account.id) : undefined;
  const drawerNow = drawer ? d(isCdf ? drawer.nativeBalance : drawer.balance) : null;
  const typedOk = d(amount).gt(0) && !unclearAmount(t, amount, account?.currency ?? "USD");
  const drawerAfter = drawerNow ? (isCustomer ? drawerNow.plus(typedOk ? d(amount) : 0) : drawerNow.minus(typedOk ? d(amount) : 0)) : null;
  const drawerShort = !isCustomer && drawerAfter?.lt(0)
    ? t(`Not enough money: the balance would be ${money(drawerAfter.toFixed(2), account!.currency)}`, `Fonds insuffisants\u00a0: le solde serait de ${money(drawerAfter.toFixed(2), account!.currency)}`)
    : null;
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
  // With no yuan rate on file, the debt's own rate as booked (the invoices'), and the hints say so.
  const cnyOnFile = !!cnyRate && d(cnyRate).gt(0);
  const cnyRef = cnyOnFile ? d(cnyRate!) : cnyForeign && !d(cnyForeign.usd).isZero() ? d(cnyForeign.native).abs().dividedBy(d(cnyForeign.usd).abs()) : null;
  const cnyOwedUsd = cnyOwed && cnyRef ? cnyOwed.dividedBy(cnyRef) : null;
  const impliedCny = cnyOwed && d(settleCny).gt(0) && d(amount).gt(0) ? d(settleCny).dividedBy(d(amount)) : null;
  const impliedGap = impliedCny && cnyRef ? impliedCny.minus(cnyRef).abs().dividedBy(cnyRef).times(100) : null;
  // With yuan typed, the server puts the whole payment on those yuan, and refuses a rate further than its
  // tolerance (at least 5 %) from the one on file: 22 000 $ for 80 050 ¥ is stopped here, with what to do.
  const settings = useQuery<{ rateTolerancePct?: string }>({ queryKey: ["/api/settings"], enabled: !!cnyOwed }).data;
  const cnyTolerance = Decimal.max(d(settings?.rateTolerancePct ?? "3"), 5);
  const yuanMismatch = impliedCny && cnyRef && impliedGap && impliedGap.gt(cnyTolerance)
    ? t(
        `With yuan typed, all ${usd(d(amount).toFixed(2))} go to the ${money(d(settleCny).toFixed(2), "CNY")}: ${fmtNumber(impliedCny.toString(), 2)} ¥ for $1 instead of ${fmtNumber(cnyRef.toString(), 2)}. Pay the yuan alone (≈ ${usd(d(settleCny).dividedBy(cnyRef).toFixed(2))}), then the dollar debt in a second payment.`,
        `Avec des yuans saisis, les ${usd(d(amount).toFixed(2))} vont tous aux ${money(d(settleCny).toFixed(2), "CNY")} : ${fmtNumber(impliedCny.toString(), 2)} ¥ pour 1 $ au lieu de ${fmtNumber(cnyRef.toString(), 2)}. Réglez les yuans seuls (≈ ${usd(d(settleCny).dividedBy(cnyRef).toFixed(2))}), puis la dette en dollars par un second paiement.`,
      )
    : null;
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
      : party.type === "employee"
        ? t(`${usd(advance.usd)} is an advance on salary`, `${usd(advance.usd)} constituent une avance sur salaire`)
        : t(`${usd(advance.usd)} is an advance`, `${usd(advance.usd)} constituent une avance`)
    : "";
  const splitText = cnyOwed && d(settleCny).gt(0) && split[0]?.kind === "cny"
    ? t(`These ${usd(split[0].usd)} settle ${money(split[0].native, "CNY")} of the yuan debt.`, `Ces ${usd(split[0].usd)} règlent ${money(split[0].native, "CNY")} de la dette en yuans.`)
    : settled.length
      ? t(`This payment settles ${settled.map(partText).join(", then ")}${advance ? `; ${advanceText}` : ""}.`, `Ce paiement règle ${settled.map(partText).join(", puis ")}${advance ? `\u00a0; ${advanceText}` : ""}.`)
      : advance
        ? t(`Nothing is owed: ${advanceText}.`, `Rien n'est dû\u00a0: ${advanceText}.`)
        : "";
  // More than is owed becomes customer credit (or an advance to the supplier): "47 770 000" typed for a
  // 1 772 $ debt is said in words and confirmed before saving. Under 100 FC left over is the notes' rounding.
  const owedSettled = settled.reduce((s, p) => s.plus(p.usd), d(0));
  const over = advance && (isCdf ? d(advance.usd).times(d(rate)).gte(100) : d(advance.usd).gt(0)) ? advance : null;
  const paidText = isCdf ? `${cdf(d(amount).toFixed(0))} (${usd(d(usdEquivalent ?? 0).toFixed(2))})` : usd(d(amount).toFixed(2));
  // Francs or yuan owed count here at the payment's rate, the header at the rate they were booked at
  // (84 000 FC: 4 430,10 $ booked, 4 429,91 $ today): the figure says which, so the two do not read as one debt.
  const owedAtRate = !!outstanding && settled.some((p) => p.kind === "cdf" || p.kind === "cny") && !owedSettled.toDecimalPlaces(2).eq(outstanding.toDecimalPlaces(2));
  const owedText = `${usd(owedSettled.toFixed(2))}${owedAtRate ? t(" at today's rate", " au taux du jour") : ""}`;
  const overText = !over
    ? null
    : isCustomer
      ? owedSettled.gt(0)
        ? t(
            `The customer pays ${paidText}; they owe ${owedText}: ${usd(over.usd)} will become credit for them`,
            `Le client paie ${paidText}\u00a0; il doit ${owedText}\u00a0: ${usd(over.usd)} deviendront un avoir`,
          )
        : t(`The customer pays ${paidText}; they owe nothing: all of it will become credit for them`, `Le client paie ${paidText}\u00a0; il ne doit rien\u00a0: tout deviendra un avoir`)
      : owedSettled.gt(0)
        ? t(
            `We pay ${paidText}; we owe ${owedText}: ${usd(over.usd)} will become an advance`,
            `Nous payons ${paidText}\u00a0; nous devons ${owedText}\u00a0: ${usd(over.usd)} deviendront une avance`,
          )
        : t(`We pay ${paidText}; we owe nothing: all of it will become an advance`, `Nous payons ${paidText}\u00a0; nous ne devons rien\u00a0: tout deviendra une avance`);
  const [confirmOver, setConfirmOver] = useState(false);
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
          : yuanMismatch
            ? t("The dollars do not match the yuan settled", "Les dollars ne correspondent pas aux yuans réglés")
            : drawerShort);

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
            <Input type="date" aria-label={t("Payment date", "Date du paiement")} value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field
            label={isCustomer ? t("Received into", "Reçu dans") : t("Paid from", "Payé depuis")}
            hint={drawerNow && drawerAfter ? `${t("Balance", "Solde")} ${money(drawerNow.toFixed(2), account!.currency)} → ${t("after", "après")} ${money(drawerAfter.toFixed(2), account!.currency)}` : undefined}
            error={drawerShort}
            required
          >
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
              {/* Inside a row with the "All" button, so the field's label is not tied to it: named here. */}
              <Input inputMode="decimal" usd={!isCdf} thousands={isCdf} aria-label={t(`Amount (${curLabel(account?.currency ?? "USD")})`, `Montant (${curLabel(account?.currency ?? "USD")})`)} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              {outstanding && !isCdf && !cnyOwed && (
                // Francs owed count at the day's rate, the figure that settles them all (as the voucher line's "Tout"),
                // not as booked: 3 290,10 $ would leave 0,19 $ as an advance.
                <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setAmount((fcOwed && d(rate).gt(0) ? Decimal.max(isCustomer ? dollarBalance : dollarBalance.negated(), 0).plus(fcOwed.dividedBy(d(rate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)) : outstanding).toFixed(2))}>
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
          {cnyOwed && !typedNumberOk(settleCny) ? (
            // "6.500" yuan not yet clarified: what the payment settles depends on it, so it is not guessed.
            <p className="text-xs text-muted-foreground sm:col-span-2" data-testid="payment-split">{t("Say how many yuan are settled to see what this payment covers.", "Précisez les yuans réglés pour voir ce que couvre ce paiement.")}</p>
          ) : split.length > 0 && !yuanMismatch ? (
            // While the dollars do not match the yuan, what they would settle is not said: the error under the yuan says why.
            <div className="space-y-1 sm:col-span-2">
              <p className="text-xs text-muted-foreground" data-testid="payment-split">{splitText}</p>
              {overText && <p role="alert" className="text-xs font-medium text-amber-800 dark:text-amber-400">{overText}</p>}
            </div>
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
                    `Owed: ${money(cnyOwed.toString(), "CNY")}${cnyOwedUsd ? ` ≈ ${usd(cnyOwedUsd.toFixed(2))} ${cnyOnFile ? "at the rate on file" : "at the invoices' rate"}` : ""}. The difference with the invoice value is an exchange gain or loss.`,
                    `Dû\u00a0: ${money(cnyOwed.toString(), "CNY")}${cnyOwedUsd ? ` ≈ ${usd(cnyOwedUsd.toFixed(2))} ${cnyOnFile ? "au taux enregistré" : "au taux de la facture"}` : ""}. L'écart avec la valeur de la facture est un gain ou une perte de change.`,
                  )}
                  {impliedCny && !yuanMismatch && (
                    <span className={cn("block", impliedGap && impliedGap.gt(5) && "font-medium text-amber-800 dark:text-amber-400")}>
                      {t(`This payment: ${fmtNumber(impliedCny.toString(), 2)} ¥ for $1`, `Ce paiement\u00a0: ${fmtNumber(impliedCny.toString(), 2)}\u00a0¥ pour 1\u00a0$`)}
                      {cnyRef && (cnyOnFile ? t(` (on file ${fmtNumber(cnyRef.toString(), 2)})`, ` (enregistré\u00a0: ${fmtNumber(cnyRef.toString(), 2)})`) : t(` (invoices' rate ${fmtNumber(cnyRef.toString(), 2)})`, ` (taux de la facture\u00a0: ${fmtNumber(cnyRef.toString(), 2)})`))}
                      {impliedGap && impliedGap.gt(5) && t(": check the amounts", "\u00a0: vérifiez les montants")}
                    </span>
                  )}
                </>
              }
              error={d(settleCny).gt(cnyOwed) ? t("More than what is owed", "Plus que ce qui est dû") : yuanMismatch}
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
              <RateInput day={day} value={rate} onChange={setRate} ownerOnly={isCustomer} />
            </Field>
          )}
          <Field label={t("Note", "Note")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={() => (overText ? setConfirmOver(true) : save())} blocked={blocked} pending={mutation.isPending}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmOver} onOpenChange={setConfirmOver}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isCustomer ? t("Receive more than is owed?", "Recevoir plus que ce qui est dû\u00a0?") : t("Pay more than is owed?", "Payer plus que ce qui est dû\u00a0?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{overText}.</p>
                <p>
                  {isCustomer
                    ? t("The credit is deducted from their next purchases. Check for an extra zero before saving.", "L'avoir sera déduit de ses prochains achats. Vérifiez qu'il n'y a pas un zéro de trop avant d'enregistrer.")
                    : party.type === "employee"
                      ? t("The advance is deducted from the next salary. Check for an extra zero before saving.", "L'avance sera déduite du prochain salaire. Vérifiez qu'il n'y a pas un zéro de trop avant d'enregistrer.")
                      : t("The advance is deducted from the next invoices. Check for an extra zero before saving.", "L'avance sera déduite des prochaines factures. Vérifiez qu'il n'y a pas un zéro de trop avant d'enregistrer.")}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOver(false);
                save();
              }}
            >
              {t(`Save ${paidText}`, `Enregistrer ${paidText}`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
