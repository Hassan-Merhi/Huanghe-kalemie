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
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader } from "@/components/common";
import { MoneyAccountSelect, PARTY_LABELS, useRateField } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { d, date as fmtDate, todayLocal, usd } from "@/lib/format";
import type { Account, Party } from "@/lib/types";
import { BalanceWords, PartyDialog } from "@/pages/Contacts";

interface StatementRow {
  journalId: number;
  number: string;
  date: string;
  type: string;
  memo: string | null;
  debit: string;
  credit: string;
  sourceType: string | null;
  sourceId: number | null;
  balance: string;
}
interface Statement {
  party: Omit<Party, "balance">;
  rows: StatementRow[];
  balance: string;
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
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const q = useQuery<Statement>({ queryKey: [`/api/parties/${id}/statement`] });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorText error={q.error ?? t("Not found", "Introuvable")} />;
  const { party, rows, balance } = q.data;
  const isCustomer = party.type === "customer";
  const typeLabel = t(PARTY_LABELS[party.type][0], PARTY_LABELS[party.type][1]);
  const canPay = isCustomer ? can("manager", "cashier") : can("manager");

  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <Link href="/contacts" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t("Customers and suppliers", "Clients et fournisseurs")}
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
          </CardContent>
        </Card>
        <Card className="sm:col-span-2">
          <CardContent className="space-y-1 p-4 text-sm">
            <p>
              <span className="text-muted-foreground">{t("Phone", "Téléphone")}: </span>
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
            {t("Printed", "Imprimé le")} {fmtDate(todayLocal())} · {t("Balance", "Solde")}: <BalanceWords balance={balance} />
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
                      <TableCell className="min-w-[160px]">{r.memo}</TableCell>
                      <TableCell className="text-right"><Num>{d(r.debit).isZero() ? "" : usd(r.debit)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{d(r.credit).isZero() ? "" : usd(r.credit)}</Num></TableCell>
                      <TableCell className="text-right whitespace-nowrap"><BalanceWords balance={r.balance} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {paying && <PaymentDialog party={party} balance={balance} onClose={() => setPaying(false)} />}
      {editing && <PartyDialog type={party.type} party={{ ...party, balance }} onClose={() => setEditing(false)} />}
    </div>
  );
}

function PaymentDialog({ party, balance, onClose }: { party: Statement["party"]; balance: string; onClose: () => void }) {
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
  const outstanding = isCustomer ? (b.isPositive() ? b : null) : b.isNegative() ? b.abs() : null;
  const valid = !!account && d(amount).gt(0) && (!isCdf || d(rate).gt(0));

  function save() {
    if (!account) return;
    mutation.mutate({
      date: day,
      partyId: party.id,
      accountId: account.id,
      amount: d(amount).toFixed(2),
      ...(isCdf ? { rate: d(rate).toString() } : {}),
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
          <Field label={isCustomer ? t("Received into", "Reçu dans") : t("Paid from", "Payé depuis")}>
            <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
          </Field>
          <Field
            label={t(`Amount (${account?.currency ?? "USD"})`, `Montant (${account?.currency ?? "USD"})`)}
          >
            <div className="flex gap-2">
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              {outstanding && !isCdf && (
                <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setAmount(outstanding.toFixed(2))}>
                  {t("All", "Tout")}
                </Button>
              )}
            </div>
          </Field>
          {isCdf && (
            <Field label={t("Rate (CDF per 1 USD)", "Taux (FC pour 1 USD)")} hint={usdEquivalent ? `= ${usd(usdEquivalent)}` : undefined}>
              <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
          )}
          <Field label={t("Note", "Note")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={save} disabled={!valid || mutation.isPending}>{t("Save", "Enregistrer")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
