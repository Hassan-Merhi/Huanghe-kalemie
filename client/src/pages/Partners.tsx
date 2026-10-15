import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, LockOpen, Pencil, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { MonthSelect } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useI18n, useT } from "@/lib/i18n";
import { d, pct, date as fmtDate, previousMonth, todayLocal, usd } from "@/lib/format";
import type { Partner } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WIDE_PRINT_CSS, journalTypeLabel } from "@/pages/ContactDetail";

interface SplitLine {
  partnerId: number;
  name?: string;
  sharePct: string;
  shareOfGrossProfit: string;
  operatingExpensesCharged: string;
  net: string;
}
interface PnlRow {
  accountId: number;
  code: string;
  name: string;
  type: "income" | "cost_of_sales" | "expense";
  amount: string;
}
interface PeriodPreview {
  month: string;
  status: "open" | "closed";
  from: string;
  to: string;
  accounts: PnlRow[];
  totals: { income: string; costOfSales: string; grossProfit: string; operatingExpenses: string; netProfit: string };
  split: { grossProfit: string; operatingExpenses: string; netProfit: string; partners: SplitLine[] };
}
interface PeriodRow {
  id: number;
  month: string;
  status: "open" | "closed";
  grossProfit: string | null;
  operatingExpenses: string | null;
  result: Omit<PeriodPreview, "status"> | null;
  closingJournalId: number | null;
  closedAt: string | null;
}
interface PartnerStatement {
  partner: Partner;
  rows: {
    journalId: number;
    number: string;
    date: string;
    type: string;
    memo: string | null;
    account: "capital" | "current";
    amount: string;
    balance: string;
  }[];
  balance: string;
}

function Signed({ value, className }: { value: string; className?: string }) {
  const v = d(value);
  return <Num className={cn(v.isNegative() && "text-destructive", className)}>{usd(value)}</Num>;
}

function useMonthName() {
  const { lang } = useI18n();
  return (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    if (!y || !mo) return m;
    const s = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, mo - 1, 1)));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
}

export default function Partners() {
  const t = useT();
  const { can } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const partnersQ = useQuery<Partner[]>({ queryKey: ["/api/partners"] });
  const partners = partnersQ.data ?? [];

  return (
    <div>
      <style>{WIDE_PRINT_CSS}</style>
      <PageHeader
        title={t("Partners and months", "Associés et mois")}
        description={t(
          "Each month the gross profit is split between the partners by their share. Shop running costs are then taken only from the partner who pays them.",
          "Chaque mois, la marge brute est partagée entre les associés selon leur part. Les frais de fonctionnement sont ensuite pris uniquement chez l'associé qui les supporte.",
        )}
        actions={
          can() && partners.length > 0 && (
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1 h-4 w-4" /> {t("Edit partners", "Modifier les associés")}
            </Button>
          )
        }
      />

      <ErrorText error={partnersQ.error} />
      {partnersQ.isLoading ? <Loading /> : <PartnerCards partners={partners} />}

      <MonthSection />

      {partners.length > 0 && <StatementSection partners={partners} />}

      {editOpen && <EditPartnersDialog partners={partners} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

function PartnerCards({ partners }: { partners: Partner[] }) {
  const t = useT();
  if (partners.length === 0) return <EmptyState title={t("No partner", "Aucun associé")} />;
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      {partners.map((p) => {
        const current = d(p.currentBalance);
        return (
          <Card key={p.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-lg">{p.name}</CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="text-base">{pct(p.sharePct)}</Badge>
                  {p.bearsOperatingExpenses && <Badge>{t("Pays the shop running costs", "Paie les frais de fonctionnement")}</Badge>}
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Profit account", "Compte de bénéfices")}</p>
                <p className={cn("mt-1 text-2xl font-semibold tabular", current.isNegative() && "text-destructive")}>{usd(p.currentBalance)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {current.isNegative()
                    ? t(
                        "Owes the business: running costs were higher than this partner's share of the profit, or more was taken out than earned.",
                        "Doit à l'entreprise\u00a0: les frais ont dépassé sa part du bénéfice, ou il a retiré plus que gagné.",
                      )
                    : current.isZero()
                      ? t("Nothing owed either way.", "Rien à devoir.")
                      : t("Profit owed to this partner (not yet taken out).", "Bénéfice dû à cet associé (pas encore retiré).")}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Capital", "Capital")}</p>
                <p className="mt-1 text-2xl font-semibold tabular">{usd(p.capitalBalance)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("Money put into the business.", "Argent apporté à l'entreprise.")}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function MonthSection() {
  const t = useT();
  const { can } = useAuth();
  const monthName = useMonthName();
  const [month, setMonth] = useState(previousMonth());
  const [confirm, setConfirm] = useState<"close" | "reopen" | null>(null);
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const previewQ = useQuery<PeriodPreview>({ queryKey: [`/api/periods/${month}`], enabled: valid });
  const periodsQ = useQuery<PeriodRow[]>({ queryKey: ["/api/periods"] });
  const periods = periodsQ.data ?? [];
  const latestClosed = periods.filter((p) => p.status === "closed").map((p) => p.month).sort().pop();
  const ended = month < todayLocal().slice(0, 7);
  const p = previewQ.data;

  const close = useApiMutation("POST", `/api/periods/${month}/close`, { success: t("Month closed", "Mois clôturé"), onSuccess: () => setConfirm(null) });
  const reopen = useApiMutation("POST", `/api/periods/${month}/reopen`, { success: t("Month reopened", "Mois rouvert"), onSuccess: () => setConfirm(null) });

  const costs = (type: PnlRow["type"]) => (p?.accounts ?? []).filter((a) => a.type === type);

  return (
    <div className="mb-6 space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>{t("Monthly result", "Résultat du mois")}</CardTitle>
              <CardDescription>{t("Choose a month to see how its profit is shared.", "Choisissez un mois pour voir le partage de son bénéfice.")}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MonthSelect className="w-48" value={month} onChange={setMonth} />
              {p && (
                <Badge variant={p.status === "closed" ? "default" : "secondary"}>
                  {p.status === "closed" ? t("Closed", "Clôturé") : t("Open", "Ouvert")}
                </Badge>
              )}
              {can() && p?.status === "open" && (
                <SubmitButton onClick={() => setConfirm("close")} blocked={!ended && t("Only a month that has ended can be closed", "Seul un mois terminé peut être clôturé")}>
                  <Lock className="mr-1 h-4 w-4" /> {t("Close month", "Clôturer le mois")}
                </SubmitButton>
              )}
              {can() && p?.status === "closed" && latestClosed === month && (
                <Button variant="outline" onClick={() => setConfirm("reopen")}>
                  <LockOpen className="mr-1 h-4 w-4" /> {t("Reopen", "Rouvrir")}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <ErrorText error={previewQ.error} />
          {previewQ.isLoading && <Loading />}
          {p && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <Step label={t("Income (sales)", "Recettes (ventes)")} value={p.totals.income} />
                <Step label={t("Cost of goods sold and stock losses", "Coût des articles vendus et pertes de stock")} value={p.totals.costOfSales} minus />
                <Step label={t("Gross profit", "Marge brute")} value={p.totals.grossProfit} strong />
                <Step label={t("Running costs", "Frais de fonctionnement")} value={p.totals.operatingExpenses} minus />
                <Step label={t("Net profit", "Bénéfice net")} value={p.totals.netProfit} strong />
              </div>

              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                <p className="font-medium">{t("How the split works", "Comment se fait le partage")}</p>
                <p className="mt-1">
                  {t(
                    "Gross profit is split 75/25. Rent, salaries and other running costs are then taken only from the 75% partner.",
                    "La marge brute est partagée 75/25. Le loyer, les salaires et les autres frais de fonctionnement sont ensuite pris uniquement chez l'associé à 75 %.",
                  )}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {t(
                    "Container costs (freight, duties, transport…) are already inside the cost of the items, so both partners share them.",
                    "Les frais de conteneur (fret, douane, transport…) sont déjà dans le coût des articles\u00a0: les deux associés les partagent.",
                  )}
                </p>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Partner", "Associé")}</TableHead>
                      <TableHead className="text-right">{t("Share", "Part")}</TableHead>
                      <TableHead className="text-right">{t("Share of gross profit", "Part de la marge brute")}</TableHead>
                      <TableHead className="text-right">{t("Running costs charged", "Frais imputés")}</TableHead>
                      <TableHead className="text-right">{t("Net result", "Résultat net")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.split.partners.map((s) => (
                      <TableRow key={s.partnerId}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-right"><Num>{pct(s.sharePct)}</Num></TableCell>
                        <TableCell className="text-right"><Signed value={s.shareOfGrossProfit} /></TableCell>
                        <TableCell className="text-right">
                          <Num className={d(s.operatingExpensesCharged).isZero() ? "text-muted-foreground" : ""}>
                            {d(s.operatingExpensesCharged).isZero() ? usd(0) : `− ${usd(s.operatingExpensesCharged)}`}
                          </Num>
                        </TableCell>
                        <TableCell className="text-right font-semibold"><Signed value={s.net} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>{t("Total", "Total")}</TableCell>
                      <TableCell className="text-right">100%</TableCell>
                      <TableCell className="text-right"><Signed value={p.split.grossProfit} /></TableCell>
                      <TableCell className="text-right"><Num>{d(p.split.operatingExpenses).isZero() ? "" : "− "}{usd(p.split.operatingExpenses)}</Num></TableCell>
                      <TableCell className="text-right"><Signed value={p.split.netProfit} /></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
              {p.status === "open" && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "This is a preview. Nothing is posted to the partners until the owner closes the month.",
                    "Ceci est un aperçu. Rien n'est passé aux associés tant que le propriétaire n'a pas clôturé le mois.",
                  )}
                </p>
              )}

              {p.accounts.length > 0 && (
                <details className="rounded-lg border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">{t("Details by account", "Détail par compte")}</summary>
                  <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
                    {([
                      ["income", t("Income", "Recettes")],
                      ["cost_of_sales", t("Cost of sales", "Coût des ventes")],
                      ["expense", t("Running costs", "Frais de fonctionnement")],
                    ] as const).map(([type, label]) => (
                      <div key={type}>
                        <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">{label}</p>
                        {costs(type).length === 0 && <p className="text-muted-foreground">—</p>}
                        {costs(type).map((a) => (
                          <div key={a.accountId} className="flex justify-between gap-2 py-0.5">
                            <span className="truncate">{a.name}</span>
                            <Num>{usd(a.amount)}</Num>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Months", "Mois")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ErrorText error={periodsQ.error} />
          {periods.length === 0 ? (
            <div className="p-4"><EmptyState title={t("No month closed yet", "Aucun mois clôturé")} /></div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Month", "Mois")}</TableHead>
                    <TableHead>{t("Status", "Statut")}</TableHead>
                    <TableHead className="text-right">{t("Gross profit", "Marge brute")}</TableHead>
                    <TableHead className="text-right">{t("Running costs", "Frais")}</TableHead>
                    <TableHead>{t("Result per partner", "Résultat par associé")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((row) => (
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => setMonth(row.month)}>
                      <TableCell className="whitespace-nowrap font-medium">{monthName(row.month)}</TableCell>
                      <TableCell>
                        <Badge variant={row.status === "closed" ? "default" : "secondary"}>
                          {row.status === "closed" ? t("Closed", "Clôturé") : t("Open", "Ouvert")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{row.grossProfit != null ? <Signed value={row.grossProfit} /> : "—"}</TableCell>
                      <TableCell className="text-right">{row.operatingExpenses != null ? <Num>{usd(row.operatingExpenses)}</Num> : "—"}</TableCell>
                      <TableCell className="text-sm">
                        {row.result?.split?.partners?.length
                          ? row.result.split.partners.map((s) => (
                              <span key={s.partnerId} className="mr-3 whitespace-nowrap">
                                {s.name}: <Signed value={s.net} />
                              </span>
                            ))
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirm === "close"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`Close ${monthName(month)}?`, `Clôturer ${monthName(month)} ?`)}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{t("This locks the month: nothing dated in it can be added or changed until it is reopened.", "Cela verrouille le mois\u00a0: rien de daté dans ce mois ne peut être ajouté ou modifié tant qu'il n'est pas rouvert.")}</p>
                <p>{t("Each partner's result is posted to their profit account:", "Le résultat de chaque associé est passé à son compte de bénéfices\u00a0:")}</p>
                <ul className="list-disc pl-5">
                  {p?.split.partners.map((s) => (
                    <li key={s.partnerId}>{s.name}: <Signed value={s.net} /></li>
                  ))}
                </ul>
                <p>{t("Months are closed in order, and only months that have ended.", "Les mois se clôturent dans l'ordre, et seulement une fois terminés.")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel", "Annuler")}</AlertDialogCancel>
            <AlertDialogAction disabled={close.isPending} onClick={(e) => { e.preventDefault(); close.mutate({}); }}>
              {t("Close month", "Clôturer le mois")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "reopen"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`Reopen ${monthName(month)}?`, `Rouvrir ${monthName(month)} ?`)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "The results posted to the partners for this month are taken back and the month can be changed again. Close it again when the corrections are done.",
                "Les résultats passés aux associés pour ce mois sont annulés et le mois peut à nouveau être modifié. Clôturez-le de nouveau après les corrections.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel", "Annuler")}</AlertDialogCancel>
            <AlertDialogAction disabled={reopen.isPending} onClick={(e) => { e.preventDefault(); reopen.mutate({}); }}>
              {t("Reopen", "Rouvrir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Step({ label, value, minus, strong }: { label: string; value: string; minus?: boolean; strong?: boolean }) {
  const neg = d(value).isNegative();
  return (
    <div className={cn("rounded-lg border p-3", strong && "border-primary/40 bg-primary/5")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 tabular", strong ? "text-xl font-semibold" : "text-lg", neg && "text-destructive")}>
        {minus && !d(value).isZero() ? "− " : ""}
        {usd(value)}
      </p>
    </div>
  );
}

function StatementSection({ partners }: { partners: Partner[] }) {
  const t = useT();
  const [partnerId, setPartnerId] = useState<number>(partners[0].id);
  useEffect(() => {
    if (!partners.some((p) => p.id === partnerId)) setPartnerId(partners[0].id);
  }, [partners, partnerId]);
  const q = useQuery<PartnerStatement>({ queryKey: [`/api/partners/${partnerId}/statement`] });
  const s = q.data;
  return (
    <Card className="print-area print-wide">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">{t("Partner statement", "Relevé de l'associé")}{s ? ` · ${s.partner.name}` : ""}</CardTitle>
            <CardDescription>{t("+ money or profit in, − money out or costs charged.", "+ argent ou bénéfice reçu, − retrait ou frais imputés.")}</CardDescription>
          </div>
          <div className="no-print flex gap-2">
            {partners.length > 1 && (
              <Select value={String(partnerId)} onValueChange={(v) => setPartnerId(Number(v))}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ErrorText error={q.error} />
        {q.isLoading ? (
          <Loading />
        ) : !s || s.rows.length === 0 ? (
          <div className="p-4"><EmptyState title={t("No movements yet", "Aucun mouvement")} /></div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Date", "Date")}</TableHead>
                  <TableHead>{t("Type", "Type")}</TableHead>
                  <TableHead>{t("Details", "Détails")}</TableHead>
                  <TableHead>{t("Account", "Compte")}</TableHead>
                  <TableHead className="text-right">{t("Amount", "Montant")}</TableHead>
                  <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.rows.map((r, i) => {
                  const a = d(r.amount);
                  return (
                    <TableRow key={`${r.journalId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{journalTypeLabel(r.type, t)}</TableCell>
                      <TableCell className="min-w-[160px]">{r.memo}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.account === "capital" ? t("Capital", "Capital") : t("Profit", "Bénéfices")}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Num className={a.isNegative() ? "text-destructive" : "text-green-700 dark:text-green-400"}>
                          {a.isNegative() ? "− " : "+ "}
                          {usd(a.abs().toFixed(2))}
                        </Num>
                      </TableCell>
                      <TableCell className="text-right"><Signed value={r.balance} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5}>{t("Capital + profit account", "Capital + compte de bénéfices")}</TableCell>
                  <TableCell className="text-right"><Signed value={s.balance} /></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EditPartnersDialog({ partners, onClose }: { partners: Partner[]; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState(partners.map((p) => ({ id: p.id, name: p.name, sharePct: d(p.sharePct).toString(), bearsOperatingExpenses: p.bearsOperatingExpenses })));
  const total = rows.reduce((s, r) => s.plus(d(r.sharePct)), d(0));
  const okTotal = total.equals(100);
  const anyBearer = rows.some((r) => r.bearsOperatingExpenses);
  const save = useApiMutation("PUT", "/api/partners", { success: t("Partners saved", "Associés enregistrés"), onSuccess: onClose });
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Edit partners", "Modifier les associés")}</DialogTitle>
          <DialogDescription>
            {t("New shares apply to months closed from now on. Months already closed keep their split.", "Les nouvelles parts s'appliquent aux mois clôturés à partir de maintenant. Les mois déjà clôturés gardent leur partage.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {rows.map((r, i) => (
            <div key={r.id} className="grid grid-cols-[1fr_6rem] gap-3 rounded-lg border p-3">
              <Field label={t("Name", "Nom")} required>
                <Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
              </Field>
              <Field label={t("Share %", "Part %")} required>
                <Input inputMode="decimal" value={r.sharePct} onChange={(e) => set(i, { sharePct: e.target.value })} />
              </Field>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <Switch checked={r.bearsOperatingExpenses} onCheckedChange={(v) => set(i, { bearsOperatingExpenses: v })} />
                {t("Pays the shop running costs", "Paie les frais de fonctionnement")}
              </label>
            </div>
          ))}
          <p className={cn("text-sm", okTotal ? "text-muted-foreground" : "text-destructive")}>
            {t(`Total: ${total.toString()}% (must be 100%)`, `Total\u00a0: ${pct(total.toString(), 2)} (doit faire 100\u00a0%)`)}
          </p>
          {!anyBearer && <p className="text-sm text-destructive">{t("At least one partner must pay the running costs.", "Au moins un associé doit payer les frais de fonctionnement.")}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            blocked={
              rows.some((r) => !r.name.trim())
                ? t("Enter every partner's name", "Saisissez le nom de chaque associé")
                : !okTotal
                  ? t("The shares must add up to 100%", "Les parts doivent faire 100\u00a0%")
                  : !anyBearer
                    ? t("Choose who pays the running costs", "Choisissez qui paie les frais de fonctionnement")
                    : null
            }
            pending={save.isPending}
            onClick={() => save.mutate({ partners: rows.map((r) => ({ ...r, name: r.name.trim(), sharePct: d(r.sharePct).toFixed(2) })) })}
          >
            {t("Save", "Enregistrer")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
