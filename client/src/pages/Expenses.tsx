import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Info, Plus } from "lucide-react";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { AccountSelect, MoneyAccountSelect, PartySelect, useRate } from "@/components/pickers";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { d, date, money, monthStart, todayLocal, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Account, Party } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ExpenseRow {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  description: string;
  amountNative: string;
  currency: "USD" | "CDF";
  rate: string | null;
  amountUsd: string;
  paidFromAccountId: number | null;
  payablePartyId: number | null;
  voidedAt: string | null;
}

export default function Expenses() {
  const t = useT();
  const { can } = useAuth();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<ExpenseRow | null>(null);
  const q = useQuery<ExpenseRow[]>({ queryKey: ["/api/expenses", { from, to }] });
  const accountsQ = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const partiesQ = useQuery<Party[]>({ queryKey: ["/api/parties"] });
  const rows = q.data ?? [];

  const { total, byCategory } = useMemo(() => {
    const live = rows.filter((r) => !r.voidedAt);
    const map = new Map<string, ReturnType<typeof d>>();
    for (const r of live) map.set(r.accountName, (map.get(r.accountName) ?? d(0)).plus(d(r.amountUsd)));
    return {
      total: live.reduce((s, r) => s.plus(d(r.amountUsd)), d(0)),
      byCategory: Array.from(map.entries()).sort((a, b) => b[1].comparedTo(a[1])),
    };
  }, [rows]);

  const accountName = (id: number | null) => accountsQ.data?.find((a) => a.id === id)?.name ?? `#${id}`;
  const partyName = (id: number | null) => partiesQ.data?.find((p) => p.id === id)?.name ?? `#${id}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("Expenses", "Dépenses")}
        description={t("Shop running costs: rent, salaries, electricity, fuel, phone…", "Dépenses de fonctionnement : loyer, salaires, électricité, carburant, téléphone…")}
        actions={
          can("manager") && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-4 w-4" /> {t("Add expense", "Ajouter une dépense")}
            </Button>
          )
        }
      />

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          {t(
            "These running costs are charged to the 75% partner at month close. Container costs (freight, duties, transport…) are entered on the container, not here.",
            "Ces dépenses de fonctionnement sont imputées à l'associé à 75 % lors de la clôture du mois. Les frais de conteneur (fret, douane, transport…) se saisissent sur le conteneur, pas ici.",
          )}
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("From", "Du")}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </Field>
        <Field label={t("To", "Au")}>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </Field>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard label={t("Total for the period", "Total de la période")} value={usd(total.toFixed(2))} sub={`${rows.filter((r) => !r.voidedAt).length} ${t("expenses", "dépenses")}`} />
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t("By category", "Par catégorie")}</CardTitle>
          </CardHeader>
          <CardContent>
            {byCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <div className="space-y-1.5">
                {byCategory.map(([name, amount]) => (
                  <div key={name} className="flex items-center gap-3 text-sm">
                    <span className="w-40 shrink-0 truncate">{name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded bg-primary" style={{ width: `${total.gt(0) ? amount.dividedBy(total).times(100).toFixed(1) : 0}%` }} />
                    </div>
                    <Num className="w-24 text-right font-medium">{usd(amount.toFixed(2))}</Num>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No expenses in this period", "Aucune dépense sur cette période")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date", "Date")}</TableHead>
                    <TableHead>{t("Category", "Catégorie")}</TableHead>
                    <TableHead>{t("Description", "Description")}</TableHead>
                    <TableHead className="text-right">{t("Amount", "Montant")}</TableHead>
                    <TableHead>{t("Paid from / owed to", "Payé par / dû à")}</TableHead>
                    <TableHead>{t("Status", "Statut")}</TableHead>
                    {can("manager") && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} className={cn(r.voidedAt && "opacity-60")}>
                      <TableCell className="whitespace-nowrap">{date(r.date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.accountName}</TableCell>
                      <TableCell className={cn("min-w-[160px]", r.voidedAt && "line-through")}>{r.description}</TableCell>
                      <TableCell className="text-right">
                        <Num className="font-medium">{money(r.amountNative, r.currency)}</Num>
                        {r.currency === "CDF" && <div className="text-xs text-muted-foreground"><Num>{usd(r.amountUsd)}</Num></div>}
                      </TableCell>
                      <TableCell className="min-w-[130px] text-sm">
                        {r.paidFromAccountId ? accountName(r.paidFromAccountId) : <span className="text-amber-700 dark:text-amber-400">{t("Owed to", "Dû à")} {partyName(r.payablePartyId)}</span>}
                      </TableCell>
                      <TableCell>{r.voidedAt ? <Badge variant="destructive">{t("Cancelled", "Annulée")}</Badge> : <Badge variant="secondary">{t("Recorded", "Enregistrée")}</Badge>}</TableCell>
                      {can("manager") && (
                        <TableCell>
                          {!r.voidedAt && (
                            <Button variant="ghost" size="icon" title={t("Cancel expense", "Annuler la dépense")} onClick={() => setCancelling(r)}>
                              <Ban className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {adding && <AddExpenseDialog onClose={() => setAdding(false)} />}
      {cancelling && <CancelDialog row={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}

function CancelDialog({ row, onClose }: { row: ExpenseRow; onClose: () => void }) {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const voidM = useApiMutation<{ date: string }>("POST", `/api/expenses/${row.id}/void`, { success: t("Expense cancelled", "Dépense annulée"), onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Cancel this expense?", "Annuler cette dépense ?")}</DialogTitle>
          <DialogDescription>
            {row.accountName} · {row.description} · {money(row.amountNative, row.currency)}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          {t(
            "A reversal is posted on the date below: the money goes back to the account it was paid from (or the debt is cancelled). The expense stays in the list, marked cancelled.",
            "Une écriture d'annulation est passée à la date ci-dessous : l'argent revient au compte qui a payé (ou la dette est annulée). La dépense reste dans la liste, marquée annulée.",
          )}
        </p>
        <Field label={t("Cancellation date", "Date d'annulation")}>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Keep", "Garder")}</Button>
          <Button variant="destructive" onClick={() => voidM.mutate({ date: day })} disabled={!day || voidM.isPending}>
            {t("Cancel expense", "Annuler la dépense")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddExpenseDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [day, setDay] = useState(todayLocal());
  const [accountId, setAccountId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"paid" | "owed">("paid");
  const [payFrom, setPayFrom] = useState<Account | null>(null);
  const [partyId, setPartyId] = useState<number | null>(null);
  const [owedCurrency, setOwedCurrency] = useState<"USD" | "CDF">("USD");
  const [rate, setRate] = useState("");
  const [rateTouched, setRateTouched] = useState(false);
  const rateQ = useRate(day);
  useEffect(() => {
    if (!rateTouched && rateQ.data?.cdfPerUsd) setRate(d(rateQ.data.cdfPerUsd).toString());
  }, [rateQ.data?.cdfPerUsd, rateTouched]);

  const currency: "USD" | "CDF" = mode === "paid" ? (payFrom?.currency ?? "USD") : owedCurrency;
  const isCdf = currency === "CDF";
  const amt = d(amount);
  const usdValue = isCdf && d(rate).gt(0) ? amt.dividedBy(d(rate)) : null;
  const create = useApiMutation<Record<string, unknown>>("POST", "/api/expenses", { success: t("Expense recorded", "Dépense enregistrée"), onSuccess: onClose });
  const valid = !!accountId && description.trim() && amt.gt(0) && (mode === "paid" ? !!payFrom : !!partyId) && (!isCdf || d(rate).gt(0));

  function save() {
    create.mutate({
      date: day,
      accountId,
      description: description.trim(),
      amount: amt.toFixed(2),
      currency,
      ...(isCdf ? { rate: d(rate).toString() } : {}),
      ...(mode === "paid" ? { paidFromAccountId: payFrom!.id } : { payablePartyId: partyId }),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Add a running cost", "Ajouter une dépense")}</DialogTitle>
          <DialogDescription>
            {t("Charged to the 75% partner at month close. Container costs go on the container.", "Imputée à l'associé à 75 % à la clôture du mois. Les frais de conteneur se saisissent sur le conteneur.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={t("Category", "Catégorie")}>
            <AccountSelect types={["expense"]} value={accountId} onChange={setAccountId} placeholder={t("Choose category", "Choisir la catégorie")} />
          </Field>
          <Field label={t("Description", "Description")} className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("e.g. October rent", "ex. loyer d'octobre")} />
          </Field>
          <div className="sm:col-span-2">
            <div className="inline-flex rounded-md border p-0.5">
              <Button type="button" size="sm" variant={mode === "paid" ? "default" : "ghost"} onClick={() => setMode("paid")}>
                {t("Paid now", "Payée maintenant")}
              </Button>
              <Button type="button" size="sm" variant={mode === "owed" ? "default" : "ghost"} onClick={() => setMode("owed")}>
                {t("Not paid yet", "Pas encore payée")}
              </Button>
            </div>
          </div>
          {mode === "paid" ? (
            <Field label={t("Paid from", "Payée depuis")} className="sm:col-span-2">
              <MoneyAccountSelect value={payFrom?.id ?? null} onChange={(_, a) => setPayFrom(a)} />
            </Field>
          ) : (
            <>
              <Field label={t("Owed to (agent or supplier)", "Due à (agent ou fournisseur)")}>
                <PartySelect types={["agent", "supplier"]} value={partyId} onChange={(id) => setPartyId(id)} />
              </Field>
              <Field label={t("Currency", "Devise")}>
                <Select value={owedCurrency} onValueChange={(v) => setOwedCurrency(v as "USD" | "CDF")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="CDF">CDF</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
          <Field label={t(`Amount (${currency})`, `Montant (${currency})`)}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </Field>
          {isCdf && (
            <Field label={t("Rate (CDF per 1 USD)", "Taux (CDF pour 1 USD)")} hint={usdValue ? `= ${usd(usdValue.toFixed(2))}` : undefined}>
              <Input inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); setRateTouched(true); }} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={save} disabled={!valid || create.isPending}>{t("Save", "Enregistrer")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
