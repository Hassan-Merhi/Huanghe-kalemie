import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, HandCoins, Landmark, MoreHorizontal, Send, Wallet } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, ErrorText, Field, francDecimalsError, Loading, Num, PageHeader, StatCard, SubmitButton } from "@/components/common";
import { MoneyAccountSelect, PartySelect, RateInput, useMoneyAccounts, useRate, useRateField } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { curLabel, cdf, d, pct, date, money, monthStart, qty as fmtQty, todayLocal, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Account, Partner, Party } from "@/lib/types";
import { cn } from "@/lib/utils";

type Action = "transfer" | "customer" | "party" | "contribution" | "withdrawal";

export default function Money() {
  const t = useT();
  const { can } = useAuth();
  const accountsQ = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const moneyAccounts = useMoneyAccounts().data;
  const [action, setAction] = useState<Action | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (!selected && moneyAccounts.length) setSelected(moneyAccounts[0].id);
  }, [moneyAccounts, selected]);

  const all = accountsQ.data ?? [];
  const receivables = all.find((a) => a.systemKey === "receivables");
  const payables = all.find((a) => a.systemKey === "payables");
  const rateQ = useRate(todayLocal());
  const todayRate = d(rateQ.data?.cdfPerUsd);
  const totalUsd = moneyAccounts.reduce((s, a) => s.plus(d(a.balance)), d(0));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("Treasury", "Trésorerie")}
        description={t("Cash boxes, bank and mobile money, what customers owe and what we owe.", "Caisses, banque et mobile money, ce que les clients doivent et ce que nous devons.")}
        actions={
          <>
            {can("manager") && (
              <Button onClick={() => setAction("transfer")}>
                <ArrowLeftRight className="mr-1 h-4 w-4" /> {t("Transfer / exchange", "Transfert / change")}
              </Button>
            )}
            {can("manager", "cashier") && (
              <Button variant="outline" onClick={() => setAction("customer")}>
                <ArrowDownToLine className="mr-1 h-4 w-4" /> {t("Customer payment", "Paiement client")}
              </Button>
            )}
            {/* The less frequent movements stay one tap away, so the header keeps to one row. */}
            {can("manager") && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <MoreHorizontal className="mr-1 h-4 w-4" /> {t("More", "Plus")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setAction("party")}>
                    <Send className="mr-2 h-4 w-4" /> {t("Pay supplier / agent / employee", "Payer fournisseur / agent / employé")}
                  </DropdownMenuItem>
                  {can() && (
                    <>
                      <DropdownMenuItem onSelect={() => setAction("contribution")}>
                        <HandCoins className="mr-2 h-4 w-4" /> {t("Partner puts money in", "Apport d'un associé")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setAction("withdrawal")}>
                        <ArrowUpFromLine className="mr-2 h-4 w-4" /> {t("Partner withdrawal", "Retrait d'un associé")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {accountsQ.isLoading ? (
        <Loading />
      ) : accountsQ.error ? (
        <ErrorText error={accountsQ.error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            {moneyAccounts.map((a) => (
              // Empty accounts take room on a phone for nothing: shown from tablet width up.
              <button key={a.id} type="button" className={cn("text-left", d(a.balance).isZero() && d(a.nativeBalance).isZero() && selected !== a.id && "hidden sm:block")} onClick={() => setSelected(a.id)}>
                <Card className={cn("h-full transition-colors hover:border-primary/60", selected === a.id && "border-primary ring-1 ring-primary")}>
                  <CardContent className="p-3 sm:p-4">
                    <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:text-xs">
                      <Wallet className="h-3.5 w-3.5" /> {a.name}
                    </p>
                    {a.currency === "CDF" ? (
                      <>
                        <p className="mt-1 break-words text-lg font-semibold tabular sm:text-2xl">{cdf(a.nativeBalance)}</p>
                        <p className="text-xs text-muted-foreground">
                          {todayRate.gt(0)
                            ? <>≈ {usd(d(a.nativeBalance).dividedBy(todayRate).toFixed(2))} {t("at today's rate", "au taux du jour")} <span className="block">{t("In the books:", "Dans les comptes\u00a0:")} {usd(a.balance)}</span></>
                            : <>{t("In the books:", "Dans les comptes\u00a0:")} {usd(a.balance)}</>}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 break-words text-lg font-semibold tabular sm:text-2xl">{usd(a.balance)}</p>
                    )}
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
            <StatCard label={t("All money (in $, as in the books)", "Toute la trésorerie (en $, selon les comptes)")} value={usd(totalUsd.toFixed(2))} />
            <StatCard label={t("Customers owe us", "Les clients nous doivent")} value={usd(receivables?.balance ?? 0)} />
            <StatCard label={t("We owe suppliers / agents / staff", "Nous devons aux fournisseurs / agents / employés")} value={usd(d(payables?.balance ?? 0).negated().toFixed(2))} tone={d(payables?.balance ?? 0).lt(0) ? "bad" : undefined} />
          </div>
        </>
      )}

      {/* min-w-0: grid items default to min-width:auto, so a wide table would push the page sideways on a phone. */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <LedgerCard accountId={selected} onAccount={setSelected} />
        </div>
        <div className="min-w-0">
          <RatesCard />
        </div>
      </div>

      {action === "transfer" && <TransferDialog onClose={() => setAction(null)} />}
      {(action === "customer" || action === "party") && <PartyPaymentDialog kind={action} onClose={() => setAction(null)} />}
      {(action === "contribution" || action === "withdrawal") && <PartnerMoneyDialog kind={action} onClose={() => setAction(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- Shared bits

function AmountFields({
  day,
  account,
  amount,
  setAmount,
  rate,
  setRate,
}: {
  day: string;
  account: Account | null;
  amount: string;
  setAmount: (v: string) => void;
  rate: string;
  setRate: (v: string) => void;
}) {
  const t = useT();
  const isCdf = account?.currency === "CDF";
  const usdValue = isCdf && d(rate).gt(0) ? d(amount).dividedBy(d(rate)) : null;
  return (
    <>
      <Field label={t(`Amount (${account?.currency ?? "USD"})`, `Montant (${account?.currency ?? "USD"})`)} required>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
      </Field>
      {isCdf && (
        <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} hint={usdValue ? `= ${usd(usdValue.toFixed(2))}` : undefined} required>
          <RateInput day={day} value={rate} onChange={setRate} />
        </Field>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Transfer / exchange

function TransferDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const [from, setFrom] = useState<Account | null>(null);
  const [to, setTo] = useState<Account | null>(null);
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [toTouched, setToTouched] = useState(false);
  const [memo, setMemo] = useState("");
  const dayRate = useRateField(day);
  const sameCurrency = from && to && from.currency === to.currency;

  // Same currency: the "to" amount follows the "from" amount until edited.
  useEffect(() => {
    if (sameCurrency && !toTouched) setToAmount(fromAmount);
  }, [sameCurrency, fromAmount, toTouched]);

  const fa = d(fromAmount);
  const ta = d(toAmount);
  // Rate of this exchange, from the two amounts (USD↔CDF only).
  const implied =
    from && to && from.currency !== to.currency && fa.gt(0) && ta.gt(0)
      ? from.currency === "CDF"
        ? fa.dividedBy(ta)
        : ta.dividedBy(fa)
      : null;
  // Francs leave at what they cost on average; dollars at face value. Francs bought with dollars
  // cost the dollars paid, so only selling or moving francs can show a difference.
  const costOf = (acc: Account | null, x: ReturnType<typeof d>) => {
    if (!acc || acc.currency !== "CDF") return x;
    const n = d(acc.nativeBalance);
    const b = d(acc.balance);
    if (n.gt(0) && b.gt(0) && x.lte(n)) return x.times(b).dividedBy(n);
    return dayRate.rate && d(dayRate.rate).gt(0) ? x.dividedBy(d(dayRate.rate)) : null;
  };
  const value = from ? costOf(from, fa) : null;
  const received = to?.currency === "USD" ? ta : value;
  const diff = value && received ? value.toDecimalPlaces(2).minus(received.toDecimalPlaces(2)) : null;

  const m = useApiMutation<Record<string, unknown>>("POST", "/api/money/transfer", { success: t("Transfer recorded", "Transfert enregistré"), onSuccess: onClose });
  const blocked = !from
    ? t("Choose the account the money leaves", "Choisissez le compte de départ")
    : !fa.gt(0)
      ? t("Enter the amount out", "Saisissez le montant sorti")
      : !to
        ? t("Choose the account the money goes to", "Choisissez le compte d'arrivée")
        : from.id === to.id
          ? t("Pick two different accounts", "Choisissez deux comptes différents")
          : !ta.gt(0)
            ? t("Enter the amount in", "Saisissez le montant reçu")
            : null;

  function save() {
    m.mutate({
      date: day,
      fromAccountId: from!.id,
      fromAmount: fa.toFixed(2),
      toAccountId: to!.id,
      toAmount: ta.toFixed(2),
      memo: memo.trim() || null,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Transfer / exchange", "Transfert / change")}</DialogTitle>
          <DialogDescription>
            {t(
              "Move money between cash boxes, bank and mobile money, or change dollars into francs. Each amount is in its own account's currency.",
              "Déplacer de l'argent entre caisses, banque et mobile money, ou changer des dollars en francs. Chaque montant est dans la devise de son compte.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")} className="sm:col-span-2">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={t("From account", "Du compte")} required>
            <MoneyAccountSelect value={from?.id ?? null} onChange={(_, a) => setFrom(a)} />
          </Field>
          <Field label={t(`Amount out${from ? ` (${curLabel(from.currency)})` : ""}`, `Montant sorti${from ? ` (${curLabel(from.currency)})` : ""}`)} error={francDecimalsError(t, from?.currency, fromAmount)} required>
            <Input inputMode="decimal" value={fromAmount} onChange={(e) => setFromAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label={t("To account", "Vers le compte")} error={from && to && from.id === to.id ? t("Pick two different accounts", "Choisissez deux comptes différents") : null} required>
            <MoneyAccountSelect value={to?.id ?? null} onChange={(_, a) => setTo(a)} />
          </Field>
          <Field label={t(`Amount in${to ? ` (${curLabel(to.currency)})` : ""}`, `Montant reçu${to ? ` (${curLabel(to.currency)})` : ""}`)} error={francDecimalsError(t, to?.currency, toAmount)} required>
            <Input inputMode="decimal" value={toAmount} onChange={(e) => { setToAmount(e.target.value); setToTouched(true); }} placeholder="0" />
          </Field>
          <Field label={t("Note (optional)", "Note (facultatif)")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        {(implied || (diff && !diff.isZero())) && (
          <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
            {implied && (
              <div className="flex flex-wrap justify-between gap-2">
                <span>{t("Rate of this exchange", "Taux de ce change")}</span>
                <Num className="font-medium">{fmtQty(implied.toDecimalPlaces(2).toString())} FC / $</Num>
              </div>
            )}
            {diff && !diff.isZero() && (
              <div className="flex flex-wrap justify-between gap-2">
                <span>{t("Exchange difference against what the francs cost", "Différence de change par rapport au coût des francs")}</span>
                <Num className={diff.isPositive() ? "text-destructive" : "text-green-800 dark:text-green-400"}>
                  {diff.isPositive() ? t("loss", "perte") : t("gain", "gain")} {usd(diff.abs().toFixed(2))}
                </Num>
              </div>
            )}
            {from?.currency === "USD" && to?.currency === "CDF" && (
              <p className="text-xs text-muted-foreground">{t("The francs are booked at the dollars paid for them.", "Les francs sont comptés au prix payé en dollars.")}</p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={save} blocked={blocked} pending={m.isPending}>{t("Record transfer", "Enregistrer le transfert")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Customer / supplier payments

function PartyPaymentDialog({ kind, onClose }: { kind: "customer" | "party"; onClose: () => void }) {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const [partyId, setPartyId] = useState<number | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const { rate, setRate } = useRateField(day);
  const partiesQ = useQuery<Party[]>({ queryKey: ["/api/parties"] });
  const party = partiesQ.data?.find((p) => p.id === partyId);
  const isCdf = account?.currency === "CDF";
  const url = kind === "customer" ? "/api/money/customer-receipt" : "/api/money/party-payment";
  const m = useApiMutation<Record<string, unknown>>("POST", url, {
    success: kind === "customer" ? t("Payment received", "Paiement reçu") : t("Payment recorded", "Paiement enregistré"),
    onSuccess: onClose,
  });
  const blocked = !partyId
    ? kind === "customer" ? t("Choose a customer", "Choisissez un client") : t("Choose who is paid", "Choisissez qui est payé")
    : !account
      ? t("Choose an account", "Choisissez un compte")
      : !d(amount).gt(0)
        ? t("Enter an amount above zero", "Saisissez un montant supérieur à zéro")
        : isCdf && !d(rate).gt(0)
          ? t("Enter the exchange rate", "Saisissez le taux de change")
          : null;
  const bal = d(party?.balance);
  const owed = kind === "customer" ? bal : bal.negated();

  function save() {
    m.mutate({
      date: day,
      partyId,
      accountId: account!.id,
      amount: d(amount).toFixed(2),
      ...(isCdf ? { rate: d(rate).toString() } : {}),
      memo: memo.trim() || null,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{kind === "customer" ? t("Customer payment", "Paiement d'un client") : t("Pay a supplier, agent or employee", "Payer un fournisseur, agent ou employé")}</DialogTitle>
          <DialogDescription>
            {kind === "customer"
              ? t("A customer pays back what they owe from credit sales.", "Un client rembourse ce qu'il doit sur ses ventes à crédit.")
              : t("Pay a supplier invoice, a clearing agent, a transporter, an employee or an unpaid bill.", "Payer une facture fournisseur, un agent en douane, un transporteur, un employé ou une facture impayée.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={kind === "customer" ? t("Customer", "Client") : t("Supplier, agent or employee", "Fournisseur, agent ou employé")} required>
            <PartySelect types={kind === "customer" ? ["customer"] : ["supplier", "agent", "employee"]} value={partyId} onChange={(id) => setPartyId(id)} />
          </Field>
          {party && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2">
              {kind === "customer" ? (
                owed.gt(0) ? (
                  <>{t("Owes us", "Nous doit")} <Num className="font-semibold">{usd(owed.toFixed(2))}</Num></>
                ) : (
                  <>{t("Owes nothing", "Ne doit rien")}{owed.lt(0) && <> ({t("we hold", "avance de")} {usd(owed.abs().toFixed(2))})</>}</>
                )
              ) : owed.gt(0) ? (
                <>{t("We owe", "Nous devons")} <Num className="font-semibold">{usd(owed.toFixed(2))}</Num></>
              ) : (
                <>{t("We owe nothing", "Nous ne devons rien")}{owed.lt(0) && <> ({t("advance paid", "avance payée")} {usd(owed.abs().toFixed(2))})</>}</>
              )}
              {owed.gt(0) && account?.currency === "USD" && (
                <Button type="button" variant="ghost" size="sm" className="ml-2 h-auto px-2 py-0 text-primary underline" onClick={() => setAmount(owed.toFixed(2))}>
                  {t("Full amount", "Montant total")}
                </Button>
              )}
            </div>
          )}
          <Field label={kind === "customer" ? t("Received into", "Reçu dans") : t("Paid from", "Payé depuis")} className="sm:col-span-2" required>
            <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
          </Field>
          <AmountFields day={day} account={account} amount={amount} setAmount={setAmount} rate={rate} setRate={setRate} />
          <Field label={t("Note (optional)", "Note (facultatif)")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={save} blocked={blocked} pending={m.isPending}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Partner money

function PartnerMoneyDialog({ kind, onClose }: { kind: "contribution" | "withdrawal"; onClose: () => void }) {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const { rate, setRate } = useRateField(day);
  const partnersQ = useQuery<Partner[]>({ queryKey: ["/api/partners"] });
  const partner = partnersQ.data?.find((p) => p.id === partnerId);
  const isCdf = account?.currency === "CDF";
  const m = useApiMutation<Record<string, unknown>>("POST", kind === "contribution" ? "/api/money/partner-contribution" : "/api/money/partner-withdrawal", {
    success: t("Recorded", "Enregistré"),
    onSuccess: onClose,
  });
  const blocked = !partnerId
    ? t("Choose a partner", "Choisissez un associé")
    : !account
      ? t("Choose an account", "Choisissez un compte")
      : !d(amount).gt(0)
        ? t("Enter an amount above zero", "Saisissez un montant supérieur à zéro")
        : isCdf && !d(rate).gt(0)
          ? t("Enter the exchange rate", "Saisissez le taux de change")
          : null;
  function save() {
    m.mutate({
      date: day,
      partnerId,
      accountId: account!.id,
      amount: d(amount).toFixed(2),
      ...(isCdf ? { rate: d(rate).toString() } : {}),
      memo: memo.trim() || null,
    });
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{kind === "contribution" ? t("Partner puts money in", "Apport d'un associé") : t("Partner withdrawal", "Retrait d'un associé")}</DialogTitle>
          <DialogDescription>
            {kind === "contribution"
              ? t("Money a partner brings into the business (capital).", "Argent qu'un associé apporte à l'entreprise (capital).")
              : t("Money a partner takes out of the business, against their share of profit.", "Argent qu'un associé retire de l'entreprise, sur sa part de bénéfice.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={t("Partner", "Associé")} required>
            <Select value={partnerId ? String(partnerId) : ""} onValueChange={(v) => setPartnerId(Number(v))}>
              <SelectTrigger><SelectValue placeholder={t("Choose partner", "Choisir l'associé")} /></SelectTrigger>
              <SelectContent>
                {(partnersQ.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name} ({pct(p.sharePct)})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {partner && (
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2">
              <div>
                <p className="text-xs text-muted-foreground">{t("Profit share owed to them", "Part de bénéfice qui lui revient")}</p>
                <Num className={cn("font-semibold", d(partner.currentBalance).lt(0) && "text-destructive")}>{usd(partner.currentBalance)}</Num>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("Capital", "Capital")}</p>
                <Num className="font-semibold">{usd(partner.capitalBalance)}</Num>
              </div>
            </div>
          )}
          <Field label={kind === "contribution" ? t("Into account", "Dans le compte") : t("From account", "Depuis le compte")} className="sm:col-span-2" required>
            <MoneyAccountSelect value={account?.id ?? null} onChange={(_, a) => setAccount(a)} />
          </Field>
          <AmountFields day={day} account={account} amount={amount} setAmount={setAmount} rate={rate} setRate={setRate} />
          <Field label={t("Note (optional)", "Note (facultatif)")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={save} blocked={blocked} pending={m.isPending}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Ledger

interface LedgerRow {
  journalId: number;
  number: string;
  date: string;
  type: string;
  memo: string | null;
  lineMemo: string | null;
  debit: string;
  credit: string;
  nativeAmount: string | null;
  rate: string | null;
  partyName: string | null;
  balance: string;
  nativeBalance: string | null;
}

interface Ledger {
  account: Account;
  openingBalance: string;
  openingNative: string | null;
  closingBalance: string;
  closingNative: string | null;
  rows: LedgerRow[];
}

function LedgerCard({ accountId, onAccount }: { accountId: number | null; onAccount: (id: number) => void }) {
  const t = useT();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const q = useQuery<Ledger>({ queryKey: [`/api/accounts/${accountId}/ledger`, { from, to }], enabled: !!accountId });
  const L = q.data;
  const isCdf = L?.account.currency === "CDF";
  const rows = useMemo(() => [...(L?.rows ?? [])].reverse(), [L?.rows]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("Recent movements", "Mouvements récents")}</CardTitle>
        <CardDescription>{t("Newest first, with the running balance.", "Les plus récents d'abord, avec le solde courant.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("Account", "Compte")}>
            <MoneyAccountSelect value={accountId} onChange={(id) => onAccount(id)} />
          </Field>
          <Field label={t("From", "Du")}>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("To", "Au")}>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {!accountId ? null : q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorText error={q.error} />
        ) : L ? (
          <>
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span>
                {t("Opening", "Solde initial")} : <Num className="font-medium">{isCdf ? `${cdf(L.openingNative)} (${usd(L.openingBalance)})` : usd(L.openingBalance)}</Num>
              </span>
              <span>
                {t("Closing", "Solde final")} : <Num className="font-semibold">{isCdf ? `${cdf(L.closingNative)} (${usd(L.closingBalance)})` : usd(L.closingBalance)}</Num>
              </span>
            </div>
            {rows.length === 0 ? (
              <EmptyState title={t("No movements in this period", "Aucun mouvement sur cette période")} />
            ) : (
              <>
              {/* Phones: one compact two-line row per movement, no sideways scroll. */}
              <div className="divide-y rounded-md border sm:hidden">
                {rows.map((r, i) => {
                  const inflow = d(r.debit).gt(0);
                  const outflow = !inflow && d(r.credit).gt(0);
                  const native = r.nativeAmount ? d(r.nativeAmount).abs() : null;
                  const amount = inflow ? (isCdf && native ? cdf(native.toFixed(2)) : usd(r.debit)) : outflow ? (isCdf && native ? cdf(native.toFixed(2)) : usd(r.credit)) : null;
                  const sub = [r.partyName, r.lineMemo].filter(Boolean).join(" · ");
                  return (
                    <div key={`${r.journalId}-${i}`} className="px-3 py-2 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate" title={sub || undefined}>{r.memo || r.type}</span>
                        {amount && (
                          <Num className={cn("shrink-0 font-medium", inflow ? "text-green-800 dark:text-green-400" : "text-destructive")}>
                            {inflow ? "+" : "−"}{amount}
                          </Num>
                        )}
                      </div>
                      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate">{date(r.date)}{sub ? ` · ${sub}` : ""}</span>
                        <span className="shrink-0">{t("Bal.", "Solde")} <Num>{isCdf ? cdf(r.nativeBalance) : usd(r.balance)}</Num></span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden overflow-x-auto rounded-md border sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Date", "Date")}</TableHead>
                      <TableHead>{t("Description", "Libellé")}</TableHead>
                      <TableHead className="text-right">{t("In", "Entrée")}</TableHead>
                      <TableHead className="text-right">{t("Out", "Sortie")}</TableHead>
                      <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r, i) => {
                      const inflow = d(r.debit).gt(0);
                      const native = r.nativeAmount ? d(r.nativeAmount).abs() : null;
                      return (
                        <TableRow key={`${r.journalId}-${i}`}>
                          <TableCell className="whitespace-nowrap">
                            {date(r.date)}
                            <div className="text-xs text-muted-foreground">{r.number}</div>
                          </TableCell>
                          <TableCell className="min-w-[180px]">
                            <div>{r.memo || r.type}</div>
                            {(r.partyName || r.lineMemo) && <div className="text-xs text-muted-foreground">{[r.partyName, r.lineMemo].filter(Boolean).join(" · ")}</div>}
                          </TableCell>
                          <TableCell className="text-right">
                            {inflow && (
                              <>
                                <Num className="text-green-800 dark:text-green-400">{isCdf && native ? cdf(native.toFixed(2)) : usd(r.debit)}</Num>
                                {isCdf && <div className="text-xs text-muted-foreground"><Num>{usd(r.debit)}</Num></div>}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {!inflow && d(r.credit).gt(0) && (
                              <>
                                <Num>{isCdf && native ? cdf(native.toFixed(2)) : usd(r.credit)}</Num>
                                {isCdf && <div className="text-xs text-muted-foreground"><Num>{usd(r.credit)}</Num></div>}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Num className="font-medium">{isCdf ? cdf(r.nativeBalance) : usd(r.balance)}</Num>
                            {isCdf && <div className="text-xs text-muted-foreground"><Num>{usd(r.balance)}</Num></div>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              </>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Exchange rates

function RatesCard() {
  const t = useT();
  const { can } = useAuth();
  const today = todayLocal();
  const todayQ = useRate(today);
  const listQ = useQuery<{ date: string; cdfPerUsd: string; cnyPerUsd: string | null }[]>({ queryKey: ["/api/exchange-rates"] });
  const lastCny = (listQ.data ?? []).find((r) => r.cnyPerUsd)?.cnyPerUsd ?? null;
  const [cnyTyped, setCny] = useState<string | null>(null);
  const cny = cnyTyped ?? (lastCny ? d(lastCny).toString() : "");
  const [day, setDay] = useState(today);
  // The field starts at the current rate (a real value, not a grey hint) until someone types.
  const [typed, setValue] = useState<string | null>(null);
  const m = useApiMutation<{ date: string; cdfPerUsd: string; cnyPerUsd?: string | null }>("POST", "/api/exchange-rates", {
    success: t("Rate saved", "Taux enregistré"),
    onSuccess: () => {
      setValue(null);
      setCny(null);
    },
  });
  const current = todayQ.data;
  const value = typed ?? (current ? d(current.cdfPerUsd).toString() : "");
  const isToday = current?.source === today;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Landmark className="h-4 w-4" /> {t("Exchange rate", "Taux de change")}
        </CardTitle>
        <CardDescription>{t("Francs (FC) for 1 US dollar. The yuan rate, when given, restates what suppliers are owed in yuan at month end.", "Francs (FC) pour 1 dollar US. Le taux du yuan, s'il est donné, sert à réévaluer en fin de mois ce qui est dû en yuans aux fournisseurs.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">{t("Today", "Aujourd'hui")}</p>
          <p className="text-2xl font-semibold tabular">{current ? `${money(current.cdfPerUsd, "CDF")}` : "…"}</p>
          {current && !isToday && (
            <p className="text-xs text-amber-800 dark:text-amber-400">
              {current.source === "default"
                ? t("No rate set yet: using the default rate.", "Aucun taux saisi\u00a0: taux par défaut utilisé.")
                : t(`Not set today: using the rate of ${date(current.source)}.`, `Pas saisi aujourd'hui\u00a0: taux du ${date(current.source)} utilisé.`)}
            </p>
          )}
        </div>
        {can("manager") && (
          <div className="flex flex-wrap gap-2">
            <Field label={t("Date", "Date")} required className="w-44 shrink-0">
              <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label={t("FC per $1", "FC pour 1 $")} required className="min-w-[7rem] flex-1">
              <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field
              label={t("CNY per $1 (optional)", "CNY pour 1 $ (facultatif)")}
              hint={lastCny ? undefined : t("About 7.1", "Environ 7,1")}
              className="min-w-[7rem] flex-1"
            >
              <Input inputMode="decimal" value={cny} onChange={(e) => setCny(e.target.value)} />
            </Field>
            <SubmitButton
              className="w-full sm:flex-col sm:items-stretch [&>button]:w-full"
              blocked={!day ? t("Choose a date", "Choisissez une date") : !d(value).gt(0) ? t("Enter a rate above zero", "Saisissez un taux supérieur à zéro") : cny && !d(cny).gt(0) ? t("The yuan rate must be above zero", "Le taux du yuan doit être supérieur à zéro") : null}
              pending={m.isPending}
              onClick={() => m.mutate({ date: day, cdfPerUsd: d(value).toString(), cnyPerUsd: cny && d(cny).gt(0) ? d(cny).toString() : null })}
            >
              {t("Set rate", "Enregistrer le taux")}
            </SubmitButton>
          </div>
        )}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Last rates", "Derniers taux")}</p>
          {(listQ.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="max-h-56 divide-y overflow-y-auto text-sm">
              {(listQ.data ?? []).slice(0, 15).map((r) => (
                <div key={r.date} className="flex justify-between py-1">
                  <span>{date(r.date)}</span>
                  <Num>{cdf(r.cdfPerUsd)}{r.cnyPerUsd ? ` · ${fmtQty(r.cnyPerUsd)} CNY` : ""}</Num>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
