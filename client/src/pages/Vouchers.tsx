import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { CheckCircle2, FileClock, Info, Plus, Printer, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorText, Field, francDecimalsError, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { AccountSelect, MoneyAccountSelect, PartySelect, RateInput, useAccounts, useMoneyAccounts, useRate, useRateField } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { api, invalidateAll } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cdf, curLabel, d, money, number, pct, qty as fmtQty, todayLocal, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Account, Party, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AdjustForm, type AdjustmentDraft, type AdjustmentPayload } from "@/pages/Stock";
import { BalanceWords } from "@/pages/Contacts";
import { useVoucherChecks } from "@/lib/voucherChecks";

type T = (en: string, fr: string) => string;

export type VoucherKind = "payment" | "receipt" | "journal" | "transfer" | "adjustment";
export const VOUCHER_KINDS: VoucherKind[] = ["payment", "receipt", "journal", "transfer", "adjustment"];

export interface VoucherDraft {
  id: number;
  kind: VoucherKind;
  date: string;
  memo: string | null;
  totalUsd: string | null;
  payload: Record<string, unknown>;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Tab / badge label of an optional voucher kind. */
export function voucherKindLabel(kind: string, t: T): string {
  const m: Record<string, [string, string]> = {
    payment: ["Payment", "Paiement"],
    receipt: ["Receipt", "Recette"],
    journal: ["Journal entry", "Écriture"],
    transfer: ["Transfer / exchange", "Transfert / change"],
    adjustment: ["Stock adjustment", "Ajustement de stock"],
  };
  const x = m[kind];
  return x ? t(x[0], x[1]) : kind;
}

/** Accounts a voucher line cannot use directly (kept by their own screens); mirrors the server's list. */
const BLOCKED_KEYS = ["inventory", "goods_in_transit", "receivables", "payables", "sales", "cogs", "stock_adjustments"];

interface DraftInput {
  kind: VoucherKind;
  date: string;
  memo: string | null;
  payload: Record<string, unknown>;
}

/** What every form gets from the page: the draft to prefill, and the save callbacks. */
interface FormProps {
  draft: VoucherDraft | null;
  canSave: boolean;
  savingDraft: boolean;
  onSaveDraft: (d: DraftInput) => void;
  onPosted: (journalId: number | null) => void;
}

// ================================================================== Page

export default function Vouchers() {
  const t = useT();
  const { user, can } = useAuth();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const rawTab = params.get("tab") as VoucherKind | null;
  const tab: VoucherKind = rawTab && VOUCHER_KINDS.includes(rawTab) ? rawTab : "payment";
  const draftId = Number(params.get("draft")) || null;
  const canSave = can("manager");
  const isOwner = user?.role === "owner";
  const [posted, setPosted] = useState<{ kind: VoucherKind; id: number | null } | null>(null);

  const draftsQ = useQuery<VoucherDraft[]>({ queryKey: ["/api/voucher-drafts"], enabled: !!draftId });
  const draft = draftId ? draftsQ.data?.find((x) => x.id === draftId) ?? null : null;

  // A draft link always opens its own tab.
  useEffect(() => {
    if (draft && draft.kind !== tab) navigate(`/vouchers?tab=${draft.kind}&draft=${draft.id}`, { replace: true });
  }, [draft, tab, navigate]);

  const saveDraft = useApiMutation<DraftInput & { id?: number }, VoucherDraft>("POST", "/api/voucher-drafts", {
    success: t("Pending voucher saved: no balance has changed", "Pièce en attente enregistrée\u00a0: aucun solde n'a changé"),
    onSuccess: (row) => {
      setPosted(null);
      if (row.id !== draftId) navigate(`/vouchers?tab=${row.kind}&draft=${row.id}`);
    },
  });

  async function onPosted(kind: VoucherKind, journalId: number | null) {
    if (draftId) {
      // Posted for real: the optional copy is no longer needed.
      await api("DELETE", `/api/voucher-drafts/${draftId}`).catch(() => undefined);
      await invalidateAll();
    }
    setPosted({ kind, id: journalId });
    // Keep "line=account" so the next expense starts on an account line too.
    navigate(`/vouchers?tab=${kind}${params.get("line") === "account" ? "&line=account" : ""}`, { replace: true });
  }

  function formProps(kind: VoucherKind): FormProps {
    return {
      draft: draft && draft.kind === kind ? draft : null,
      canSave,
      savingDraft: saveDraft.isPending,
      onSaveDraft: (x) => saveDraft.mutate({ ...x, ...(draftId ? { id: draftId } : {}) }),
      onPosted: (id) => void onPosted(kind, id),
    };
  }

  const waitingDraft = !!draftId && draftsQ.isLoading;
  const missingDraft = !!draftId && !draftsQ.isLoading && !draft;
  const formKey = (kind: VoucherKind) => `${kind}-${draft && draft.kind === kind ? draft.id : "new"}`;

  function body(kind: VoucherKind, node: ReactNode) {
    if (waitingDraft) return <Loading />;
    return (
      <div className="space-y-4">
        {posted?.kind === kind && <PostedBanner journalId={posted.id} onClose={() => setPosted(null)} />}
        {draft && draft.kind === kind && <DraftBanner draft={draft} />}
        {node}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("Vouchers", "Pièces")}
        description={t(
          "Record payments, receipts, entries, transfers and stock adjustments. Each one appears in the day book.",
          "Enregistrez paiements, recettes, écritures, transferts et ajustements de stock. Chacun apparaît dans le journal du jour.",
        )}
        actions={<Button variant="outline" asChild><Link href="/daybook">{t("Day book", "Journal du jour")}</Link></Button>}
      />
      {!canSave && (
        <Alert className="mb-4">
          <Info className="h-4 w-4" />
          <AlertDescription>{t("You can look at these forms but not save them.", "Vous pouvez consulter ces formulaires mais pas les enregistrer.")}</AlertDescription>
        </Alert>
      )}
      {missingDraft && (
        <div className="mb-4">
          <ErrorText error={t("This pending voucher no longer exists (validated or deleted). The form below is empty.", "Cette pièce en attente n'existe plus (validée ou supprimée). Le formulaire ci-dessous est vide.")} />
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => { setPosted(null); navigate(`/vouchers?tab=${v}`); }}>
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start sm:w-auto">
          {VOUCHER_KINDS.map((k) => <TabsTrigger key={k} value={k}>{voucherKindLabel(k, t)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="payment">{body("payment", <VoucherForm key={formKey("payment")} kind="payment" startOn={params.get("line") === "account" ? "account" : "party"} {...formProps("payment")} />)}</TabsContent>
        <TabsContent value="receipt">{body("receipt", <VoucherForm key={formKey("receipt")} kind="receipt" {...formProps("receipt")} />)}</TabsContent>
        <TabsContent value="journal">
          {isOwner
            ? body("journal", <JournalForm key={formKey("journal")} {...formProps("journal")} />)
            : (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>{t("Owner only", "Réservé au propriétaire")}</AlertTitle>
                <AlertDescription>
                  {t(
                    "Journal entries change the books directly, so only the owner can post them. Use a payment, receipt or transfer voucher instead.",
                    "Les écritures modifient directement les comptes\u00a0: seul le propriétaire peut les passer. Utilisez plutôt une pièce de paiement, de recette ou un transfert.",
                  )}
                </AlertDescription>
              </Alert>
            )}
        </TabsContent>
        <TabsContent value="transfer">{body("transfer", <TransferForm key={formKey("transfer")} {...formProps("transfer")} />)}</TabsContent>
        <TabsContent value="adjustment">{body("adjustment", <AdjustmentTab key={formKey("adjustment")} {...formProps("adjustment")} />)}</TabsContent>
      </Tabs>
    </div>
  );
}

function PostedBanner({ journalId, onClose }: { journalId: number | null; onClose: () => void }) {
  const t = useT();
  return (
    <Alert className="border-emerald-600/40">
      <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      <AlertTitle>{t("Voucher saved", "Pièce enregistrée")}</AlertTitle>
      <AlertDescription className="mt-2 flex flex-wrap gap-2">
        {journalId && (
          <Button size="sm" asChild><Link href={`/vouchers/${journalId}`}><Printer className="mr-1 h-4 w-4" /> {t("Print voucher", "Imprimer la pièce")}</Link></Button>
        )}
        <Button size="sm" variant="outline" asChild><Link href="/daybook">{t("Open day book", "Ouvrir le journal du jour")}</Link></Button>
        <Button size="sm" variant="ghost" onClick={onClose}>{t("New voucher", "Nouvelle pièce")}</Button>
      </AlertDescription>
    </Alert>
  );
}

function DraftBanner({ draft }: { draft: VoucherDraft }) {
  const t = useT();
  return (
    <Alert>
      <FileClock className="h-4 w-4" />
      <AlertTitle>{t("Editing a pending voucher", "Modification d'une pièce en attente")}</AlertTitle>
      <AlertDescription>
        {t(
          `Saved by ${draft.createdByName ?? "—"}. "Save as pending" updates it; "Save" posts it for real and removes it from the optional list.`,
          `Enregistrée par ${draft.createdByName ?? "—"}. «\u00a0Mettre en attente\u00a0» la met à jour\u00a0; «\u00a0Enregistrer\u00a0» la passe pour de bon et la retire de la liste des pièces en attente.`,
        )}
      </AlertDescription>
    </Alert>
  );
}

function ActionBar({ canSave, children }: { canSave: boolean; children: ReactNode }) {
  if (!canSave) return null;
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>;
}

// ================================================================== Helpers

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const numOrNull = (v: unknown) => (typeof v === "number" && v > 0 ? v : Number(v) > 0 ? Number(v) : null);
const asArray = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []);
const isAmount = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

function useBalances() {
  return useAccounts("/api/accounts/balances");
}

/** Account picker for voucher lines: only the account types the voucher allows, without blocked accounts. */
function LineAccountSelect({ value, onChange, types }: { value: number | null; onChange: (id: number) => void; types: Account["type"][] }) {
  const t = useT();
  return <AccountSelect hideCode aria-label={t("Account", "Compte")} value={value} onChange={onChange} types={types} filter={(a) => !a.isMoney && !(a.systemKey && BLOCKED_KEYS.includes(a.systemKey))} />;
}

let rowKey = 1;

// ================================================================== Payment / receipt

interface VLine {
  key: number;
  mode: "party" | "account";
  partyId: number | null;
  accountId: number | null;
  amount: string;
  memo: string;
}

const blankVLine = (mode: VLine["mode"] = "party"): VLine => ({ key: rowKey++, mode, partyId: null, accountId: null, amount: "", memo: "" });

const PARTY_TYPES: Record<"payment" | "receipt", Party["type"][]> = {
  payment: ["supplier", "agent", "employee", "customer"],
  receipt: ["customer", "supplier", "agent", "employee"],
};
const ACCOUNT_TYPES: Record<"payment" | "receipt", Account["type"][]> = {
  payment: ["expense", "liability", "equity", "asset"],
  receipt: ["income", "liability", "equity", "asset"],
};

/** `startOn`: what a new line is for; "account" for an expense (the dashboard's "Add expense"), else a contact. */
function VoucherForm({ kind, draft, canSave, savingDraft, onSaveDraft, onPosted, startOn = "party" }: FormProps & { kind: "payment" | "receipt"; startOn?: VLine["mode"] }) {
  const t = useT();
  const p = draft?.payload ?? {};
  const { data: moneyAccounts } = useMoneyAccounts();
  const balances = useBalances();
  const [day, setDay] = useState(draft?.date ?? todayLocal());
  const [accountId, setAccountId] = useState<number | null>(numOrNull(p.accountId));
  const [memo, setMemo] = useState(str(p.memo ?? draft?.memo));
  const [lines, setLines] = useState<VLine[]>(() => {
    const ls = asArray(p.lines).map<VLine>((l) => ({
      key: rowKey++,
      mode: l.accountId ? "account" : "party",
      partyId: numOrNull(l.partyId),
      accountId: numOrNull(l.accountId),
      amount: str(l.amount),
      memo: str(l.memo),
    }));
    return ls.length ? ls : [blankVLine(startOn)];
  });
  const rateField = useRateField(day);
  useEffect(() => {
    if (p.rate) rateField.setRate(str(p.rate));
    // Only once, from the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [error, setError] = useState<string | null>(null);

  const account = moneyAccounts.find((a) => a.id === accountId) ?? null;
  const currency = account?.currency ?? "USD";
  const isCdf = currency === "CDF";
  const rate = d(rateField.rate);
  const total = lines.reduce((s, l) => s.plus(isAmount(l.amount) ? d(l.amount).toDecimalPlaces(2) : 0), d(0));
  const totalUsd = isCdf ? (rate.gt(0) ? total.dividedBy(rate) : null) : total;
  // Francs change hands in whole notes: say so on the form, before the server refuses it.
  const francSlip = isCdf ? lines.findIndex((l) => isAmount(l.amount) && !d(l.amount).isInteger()) : -1;
  const francSlipText = t(`Line ${francSlip + 1}: franc amounts are whole numbers (no centimes).`, `Ligne ${francSlip + 1}\u00a0: les montants en FC sont des nombres entiers (sans centimes).`);
  // "0,004 $" rounds to nothing: said on the line, not as the server's field path after saving.
  const isTiny = (l: VLine) => isAmount(l.amount) && d(l.amount).gt(0) && d(l.amount).toDecimalPlaces(2).isZero();
  const tinySlip = francSlip < 0 ? lines.findIndex(isTiny) : -1;
  const slipText = francSlip >= 0
    ? francSlipText
    : tinySlip >= 0
      ? t(`Line ${tinySlip + 1}: the amount is less than one cent.`, `Ligne ${tinySlip + 1}\u00a0: le montant vaut moins d'un centime.`)
      : null;
  // An amount that cannot be saved as typed ("250000,50" FC, "1.200") previews nothing: no balance after, no dollars.
  const amountsBad = !!slipText || lines.some((l) => l.amount.trim() && !isAmount(l.amount));
  const bal = balances.data?.find((a) => a.id === accountId);
  const current = bal ? d(isCdf ? bal.nativeBalance : bal.balance) : null;
  const after = current ? (kind === "payment" ? current.minus(total) : current.plus(total)) : null;
  // A payment the account cannot cover is stopped here, like the pending-voucher and supplier dialogs: the
  // server would refuse it anyway, after the "more than is owed" question.
  const short = after && after.lt(0) && kind === "payment" ? t(`Not enough money: the balance would be ${money(after.toFixed(2), currency)}`, `Fonds insuffisants\u00a0: le solde serait de ${money(after.toFixed(2), currency)}`) : null;

  // An unusual payment, or a contact paid (or paying) more than is owed, is said and confirmed before saving.
  const checks = useVoucherChecks({
    kind,
    day,
    accountId,
    rate: isCdf ? rateField.rate : null,
    lines: lines.map((l) => (l.mode === "party" ? { partyId: l.partyId, accountId: null, amount: l.amount } : { partyId: null, accountId: l.accountId, amount: l.amount })),
    enabled: canSave,
  });
  const unusual = [...checks.unusual, ...checks.overDebt];
  // The same question before "Mettre en attente": the owner validating it later should not be the first to see it.
  const [confirmUnusual, setConfirmUnusual] = useState<null | "save" | "draft">(null);

  const m = useApiMutation<Record<string, unknown>, { id: number; total: string }>("POST", `/api/vouchers/${kind}`, {
    success: kind === "payment" ? t("Payment recorded", "Paiement enregistré") : t("Receipt recorded", "Recette enregistrée"),
    onSuccess: (r) => {
      setLines([blankVLine(startOn)]);
      setMemo("");
      onPosted(r.id);
    },
  });

  const set = (key: number, patch: Partial<VLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function payload(strict: boolean): Record<string, unknown> | null {
    const out = lines
      .filter((l) => !strict || l.partyId || l.accountId || l.amount.trim())
      .map((l) => ({
        ...(l.mode === "party" ? { partyId: l.partyId } : { accountId: l.accountId }),
        amount: isAmount(l.amount) ? d(l.amount).toFixed(2) : l.amount.trim(),
        memo: l.memo.trim() || null,
      }));
    return { accountId, ...(isCdf ? { rate: rateField.rate.trim() || null } : {}), memo: memo.trim() || null, lines: out };
  }

  function save(confirmed = false) {
    setError(null);
    if (!account) return setError(t("Choose the money account.", "Choisissez le compte de trésorerie."));
    if (isCdf && !rate.gt(0)) return setError(t("Enter the rate (CDF per 1 USD).", "Saisissez le taux (FC pour 1 $)."));
    const used = lines.filter((l) => l.partyId || l.accountId || l.amount.trim());
    if (!used.length) return setError(t("Add at least one line.", "Ajoutez au moins une ligne."));
    for (const [i, l] of used.entries()) {
      const target = l.mode === "party" ? l.partyId : l.accountId;
      if (!target) return setError(t(`Line ${i + 1}: pick a contact or an account.`, `Ligne ${i + 1}\u00a0: choisissez un contact ou un compte.`));
      if (l.amount.trim() && !isAmount(l.amount)) return setError(t(`Line ${i + 1}: correct the amount.`, `Ligne ${i + 1}\u00a0: corrigez le montant.`));
      if (!isAmount(l.amount) || !d(l.amount).gt(0)) return setError(t(`Line ${i + 1}: enter an amount greater than zero.`, `Ligne ${i + 1}\u00a0: saisissez un montant supérieur à zéro.`));
    }
    if (slipText) return setError(slipText);
    if (short) return;
    if (unusual.length && !confirmed) return setConfirmUnusual("save");
    m.mutate({ date: day, ...payload(true) });
  }

  function saveDraft(confirmed = false) {
    if (unusual.length && !confirmed) return setConfirmUnusual("draft");
    onSaveDraft({ kind, date: day, memo: memo.trim() || null, payload: payload(false)! });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Date", "Date")}><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field
            label={kind === "payment" ? t("Paid from", "Payé depuis") : t("Received into", "Reçu dans")}
            hint={
              current
                ? // "→ après" only once an amount is typed: with none it would repeat the balance.
                  amountsBad || !total.gt(0)
                  ? `${t("Balance", "Solde")} ${money(current.toFixed(2), currency)}`
                  : `${t("Balance", "Solde")} ${money(current.toFixed(2), currency)} → ${t("after", "après")} ${money(after!.toFixed(2), currency)}`
                : undefined
            }
            error={short}
            required
          >
            <MoneyAccountSelect value={accountId} onChange={(id) => setAccountId(id)} />
          </Field>
          {isCdf && (
            <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} hint={totalUsd && !amountsBad ? `= ${usd(totalUsd.toFixed(2))}` : undefined} required>
              <RateInput day={day} value={rateField.rate} onChange={rateField.setRate} ownerOnly />
            </Field>
          )}
          <Field label={t("Description", "Libellé")} className={isCdf ? "" : "lg:col-span-2"}>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={kind === "payment" ? t("e.g. this week's suppliers", "ex. fournisseurs de la semaine") : t("e.g. customer payments", "ex. encaissements clients")} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Lines", "Lignes")}</CardTitle>
          <CardDescription>
            {kind === "payment"
              ? t(
                  "A contact line pays a supplier, agent or employee (or gives money to a customer). An account line is an expense, a partner account or a debt.",
                  "Une ligne contact paie un fournisseur, un agent ou un employé (ou remet de l'argent à un client). Une ligne compte est une dépense, un compte associé ou une dette.",
                )
              : t(
                  "A contact line is a customer paying (or a supplier refund). An account line is other income, a partner contribution or a loan received.",
                  "Une ligne contact est un client qui paie (ou un remboursement fournisseur). Une ligne compte est un autre produit, un apport d'associé ou un prêt reçu.",
                )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[8rem_minmax(0,1.6fr)_8rem_minmax(0,1fr)_2.5rem]">
            <span>{t("Type", "Type")}</span>
            <span>{t("Contact or account", "Contact ou compte")}</span>
            <span className="text-right">{t(`Amount (${curLabel(currency)})`, `Montant (${curLabel(currency)})`)}</span>
            <span>{t("Line note", "Note de ligne")}</span>
            <span />
          </div>
          {lines.map((l, i) => (
            <div key={l.key} className="grid grid-cols-1 gap-2 rounded-lg border p-3 md:grid-cols-[8rem_minmax(0,1.6fr)_8rem_minmax(0,1fr)_2.5rem] md:items-center md:border-0 md:p-1">
              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex rounded-md border p-0.5">
                  {(["party", "account"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => set(l.key, { mode })}
                      className={cn("rounded px-2 py-1 text-xs", l.mode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
                    >
                      {mode === "party" ? t("Contact", "Contact") : t("Account", "Compte")}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground md:hidden">{t("Line", "Ligne")} {i + 1}</span>
              </div>
              <div className="min-w-0">
                {l.mode === "party" ? (
                  <>
                    <PartySelect types={PARTY_TYPES[kind]} value={l.partyId} onChange={(id) => set(l.key, { partyId: id })} placeholder={t("Choose contact…", "Choisir le contact…")} />
                    {/* What is owed, either way, before the amount is typed: "nous doit 1 450,00 $", with the francs
                        in it as on the contact page, and "Tout" filling what settles everything: francs owed count at
                        the day's rate there (3 289,91 $), as the "more than is owed" check reads them, not as booked. */}
                    {checks.partyOf(l.partyId) && (() => {
                      const pty = checks.partyOf(l.partyId)!;
                      const fcBooked = pty.foreign?.find((f) => f.currency === "CDF");
                      // Yuan owed are settled from the contact page's "Payer", which pays them to the yuan.
                      const cnyBooked = pty.foreign?.find((f) => f.currency === "CNY" && !d(f.native).isZero());
                      const all = checks.settleAll(l.partyId);
                      return (
                        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 px-1 text-xs" data-testid="line-owed">
                          <BalanceWords balance={pty.balance} customer={pty.type === "customer"} />
                          {fcBooked && !d(fcBooked.native).isZero() && <span className="text-muted-foreground">({t("of which", "dont")} {cdf(d(fcBooked.native).abs().toFixed(0))})</span>}
                          {cnyBooked && <span className="text-muted-foreground">({t("of which", "dont")} {money(d(cnyBooked.native).abs().toFixed(2), "CNY")})</span>}
                          {cnyBooked && (
                            <span className="w-full text-muted-foreground" data-testid="line-owed-cny">
                              {t("Yuan are settled with ", "Les yuans se règlent avec «\u00a0Payer\u00a0» sur ")}
                              <Link href={`/contacts/${pty.id}`} className="underline underline-offset-2">{t("“Pay” on the contact page", "la fiche du contact")}</Link>.
                            </span>
                          )}
                          {all && (
                            <span className={cn("inline-flex items-center gap-1.5", all.fc.gt(0) && !isCdf && "w-full")}>
                              {all.fc.gt(0) && !isCdf && <span className="text-muted-foreground">{t(`All of it at today's rate: ${usd(all.amount)}`, `Le tout au taux du jour\u00a0: ${usd(all.amount)}`)}</span>}
                              <button type="button" className="rounded border px-2 py-1 font-medium hover:bg-muted" onClick={() => set(l.key, { amount: all.amount })}>
                                {t("All", "Tout")}
                              </button>
                            </span>
                          )}
                        </p>
                      );
                    })()}
                  </>
                ) : (
                  <LineAccountSelect types={ACCOUNT_TYPES[kind]} value={l.accountId} onChange={(id) => set(l.key, { accountId: id })} />
                )}
              </div>
              <Input inputMode="decimal" usd={currency === "USD"} thousands={currency === "CDF"} aria-invalid={(isCdf && isAmount(l.amount) && !d(l.amount).isInteger()) || isTiny(l) || undefined} className="text-right tabular" placeholder={t(`Amount (${curLabel(currency)})`, `Montant (${curLabel(currency)})`)} value={l.amount} onChange={(e) => set(l.key, { amount: e.target.value })} />
              <Input placeholder={t("Note (optional)", "Note (facultatif)")} value={l.memo} onChange={(e) => set(l.key, { memo: e.target.value })} />
              <Button variant="ghost" size="icon" className="justify-self-end" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t("Remove line", "Retirer la ligne")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankVLine(startOn)])}>
              <Plus className="mr-1 h-4 w-4" /> {t("Add line", "Ajouter une ligne")}
            </Button>
            <div className="text-right text-sm">
              <span className="text-muted-foreground">{t("Total", "Total")} </span>
              <Num className="text-lg font-semibold">{amountsBad ? "—" : money(total.toFixed(2), currency)}</Num>
              {slipText && <span className="block text-xs font-medium text-destructive" role="alert">{slipText}</span>}
              {isCdf && !amountsBad && <span className="block text-xs text-muted-foreground">{totalUsd ? `≈ ${usd(totalUsd.toFixed(2))}` : t("enter the rate", "saisissez le taux")}</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      {unusual.length > 0 && (
        <div role="alert" className="space-y-0.5 text-sm font-medium text-amber-800 dark:text-amber-400">
          {unusual.map((u) => <p key={u}>{u}.</p>)}
        </div>
      )}
      {error && <ErrorText error={error} />}
      <ActionBar canSave={canSave}>
        <Button variant="outline" disabled={savingDraft} onClick={() => saveDraft()}>
          {t("Save as pending", "Mettre en attente")}
        </Button>
        <SubmitButton onClick={() => save()} blocked={short} pending={m.isPending}>{t("Save", "Enregistrer")}</SubmitButton>
      </ActionBar>
      <AlertDialog open={!!confirmUnusual} onOpenChange={(o) => !o && setConfirmUnusual(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {checks.unusual.length || !checks.overDebt.length
                ? t("An unusual amount?", "Un montant inhabituel\u00a0?")
                : checks.overGrows === checks.overDebt.length
                  // Nothing is over what is owed: the money goes the way that makes the contact's debt (or ours) grow.
                  ? kind === "payment"
                    ? checks.overGrowsCustomers
                      ? t("Pay money to a customer who already owes?", "Verser de l'argent à un client qui doit déjà\u00a0?")
                      : t("Pay money to a contact who already owes us?", "Verser de l'argent à un contact qui nous doit déjà\u00a0?")
                    : t("Receive money from a contact we already owe?", "Recevoir de l'argent d'un contact à qui nous devons déjà\u00a0?")
                  : kind === "payment"
                    ? t("Pay more than is owed?", "Payer plus que ce qui est dû\u00a0?")
                    : t("Receive more than is owed?", "Recevoir plus que ce qui est dû\u00a0?")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {unusual.map((u) => <p key={u}>{u}.</p>)}
                {checks.overDebt.length > checks.overGrows && (
                  <p>{t("What is over stays on the contact's account and is deducted next time.", "Le surplus reste au compte du contact et sera déduit la prochaine fois.")}</p>
                )}
                {checks.overGrows > 0 && (
                  <p>
                    {kind === "payment"
                      ? t("This increases what they owe us.", "Cela augmente sa dette envers nous.")
                      : t("This increases what we owe them.", "Cela augmente ce que nous lui devons.")}
                  </p>
                )}
                <p>{t("Check for an extra zero before saving.", "Vérifiez qu'il n'y a pas un zéro de trop avant d'enregistrer.")}</p>
                {confirmUnusual === "draft" && (
                  <p>{t("Nothing is posted yet: the same question comes back when it is validated.", "Rien n'est encore passé : la même question reviendra à la validation.")}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const what = confirmUnusual;
                setConfirmUnusual(null);
                if (what === "draft") saveDraft(true);
                else save(true);
              }}
            >
              {confirmUnusual === "draft"
                ? t(`Save as pending · ${money(total.toFixed(2), currency)}`, `Mettre en attente · ${money(total.toFixed(2), currency)}`)
                : kind === "payment"
                  ? t(`Pay ${money(total.toFixed(2), currency)}`, `Payer ${money(total.toFixed(2), currency)}`)
                  : t(`Save ${money(total.toFixed(2), currency)}`, `Enregistrer ${money(total.toFixed(2), currency)}`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ================================================================== Journal entry

interface JLine {
  key: number;
  accountId: number | null;
  partyId: number | null;
  debit: string;
  credit: string;
  native: string;
  rate: string;
  memo: string;
}

const blankJLine = (): JLine => ({ key: rowKey++, accountId: null, partyId: null, debit: "", credit: "", native: "", rate: "", memo: "" });

function JournalForm({ draft, canSave, savingDraft, onSaveDraft, onPosted }: FormProps) {
  const t = useT();
  const p = draft?.payload ?? {};
  const accountsQ = useAccounts();
  const accounts = accountsQ.data ?? [];
  const [day, setDay] = useState(draft?.date ?? todayLocal());
  const dayRate = useRate(day);
  const [memo, setMemo] = useState(str(p.memo ?? draft?.memo));
  const [opening, setOpening] = useState(p.type === "opening");
  const [lines, setLines] = useState<JLine[]>(() => {
    const ls = asArray(p.lines).map<JLine>((l) => ({
      key: rowKey++,
      accountId: numOrNull(l.accountId),
      partyId: numOrNull(l.partyId),
      debit: str(l.debit),
      credit: str(l.credit),
      native: l.nativeAmount ? d(l.nativeAmount).abs().toString() : "",
      rate: str(l.rate),
      memo: str(l.memo),
    }));
    while (ls.length < 2) ls.push(blankJLine());
    return ls;
  });
  const m = useApiMutation<Record<string, unknown>, { id: number }>("POST", "/api/journals", {
    success: t("Entry saved", "Écriture enregistrée"),
    onSuccess: (r) => {
      setLines([blankJLine(), blankJLine()]);
      setMemo("");
      onPosted(r.id);
    },
  });
  const set = (key: number, patch: Partial<JLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const acc = (id: number | null) => accounts.find((a) => a.id === id);
  const partyTypes = (a?: Account): Party["type"][] | null =>
    a?.systemKey === "receivables" ? ["customer"] : a?.systemKey === "payables" ? ["supplier", "agent", "employee"] : null;
  const isCdf = (a?: Account) => !!a && a.isMoney && a.currency === "CDF";

  const totalDebit = lines.reduce((s, l) => s.plus(d(l.debit).toDecimalPlaces(2)), d(0));
  const totalCredit = lines.reduce((s, l) => s.plus(d(l.credit).toDecimalPlaces(2)), d(0));
  const diff = totalDebit.minus(totalCredit);
  const balanced = diff.isZero() && totalDebit.gt(0);
  const empty = totalDebit.isZero() && totalCredit.isZero();
  const problems: string[] = [];
  if (!memo.trim()) problems.push(t("Add a description", "Ajoutez une description"));
  if (lines.some((l) => !l.accountId)) problems.push(t("Choose an account on every line", "Choisissez un compte sur chaque ligne"));
  if (lines.some((l) => d(l.debit).gt(0) && d(l.credit).gt(0))) problems.push(t("A line is either debit or credit", "Une ligne est soit au débit soit au crédit"));
  if (lines.some((l) => partyTypes(acc(l.accountId)) && !l.partyId)) problems.push(t("Pick the contact on receivable/payable lines", "Choisissez le contact sur les lignes créances/dettes"));
  if (lines.some((l) => isCdf(acc(l.accountId)) && (!d(l.native).gt(0) || !d(l.rate).gt(0)))) problems.push(t("CDF accounts need the CDF amount and the rate", "Les comptes en francs ont besoin du montant en FC et du taux"));
  if (totalDebit.isZero()) problems.push(t("Enter some amounts", "Saisissez des montants"));
  if (!diff.isZero()) problems.push(t("Debits and credits must be equal", "Les débits et crédits doivent être égaux"));

  function setNative(l: JLine, native: string, rate: string) {
    const usdValue = d(rate).gt(0) && d(native).gt(0) ? d(native).dividedBy(d(rate)).toFixed(2) : "";
    if (d(l.credit).gt(0)) set(l.key, { native, rate, credit: usdValue });
    else set(l.key, { native, rate, debit: usdValue });
  }

  function chooseAccount(l: JLine, id: number) {
    const a = acc(id);
    const rate = isCdf(a) ? l.rate || (dayRate.data ? d(dayRate.data.cdfPerUsd).toString() : "") : "";
    set(l.key, { accountId: id, partyId: null, native: "", rate });
  }

  function payload() {
    return {
      memo: memo.trim(),
      type: opening ? "opening" : "manual",
      lines: lines.map((l) => {
        const a = acc(l.accountId);
        return {
          accountId: l.accountId,
          debit: d(l.debit).gt(0) ? d(l.debit).toFixed(2) : null,
          credit: d(l.credit).gt(0) ? d(l.credit).toFixed(2) : null,
          partyId: partyTypes(a) ? l.partyId : null,
          memo: l.memo.trim() || null,
          ...(isCdf(a) ? { nativeAmount: d(l.native).toFixed(2), rate: l.rate.trim() ? d(l.rate).toString() : null } : {}),
        };
      }),
    };
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label={t("Date", "Date")}><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
            <Field label={t("Description", "Libellé")} required><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={opening} onCheckedChange={setOpening} />
            {t("Opening balance (cash, debts and capital you start with)", "Solde d'ouverture (caisse, dettes et capital de départ)")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("For corrections the other screens cannot make. Stock and container accounts cannot be used here.", "Pour les corrections impossibles depuis les autres écrans. Les comptes de stock et de conteneurs ne sont pas autorisés ici.")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">{t("Lines", "Lignes")}</CardTitle>
          {empty ? (
            <Badge variant="outline" className="font-normal text-muted-foreground">{t("Enter amounts", "Saisissez des montants")}</Badge>
          ) : (
            <Badge variant={balanced ? "secondary" : "destructive"} className={cn(balanced && "text-emerald-800 dark:text-emerald-400")}>
              {balanced ? t("Balanced", "Équilibrée") : t("Unbalanced", "Déséquilibrée")}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1.5fr)_7rem_7rem_minmax(0,1fr)_2.5rem]">
            <span>{t("Account", "Compte")}</span>
            <span className="text-right">{t("Debit ($)", "Débit ($)")}</span>
            <span className="text-right">{t("Credit ($)", "Crédit ($)")}</span>
            <span>{t("Line note", "Note de ligne")}</span>
            <span />
          </div>
          {lines.map((l, i) => {
            const a = acc(l.accountId);
            const pt = partyTypes(a);
            return (
              <div key={l.key} className="rounded-lg border p-3 md:p-2">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1.5fr)_7rem_7rem_minmax(0,1fr)_2.5rem] md:items-center">
                  <div className="col-span-2 min-w-0 md:col-span-1">
                    <span className="mb-1 block text-xs text-muted-foreground md:hidden">{t("Account", "Compte")} {i + 1}</span>
                    <AccountSelect aria-label={t("Account", "Compte")} value={l.accountId} onChange={(id) => chooseAccount(l, id)} />
                  </div>
                  <Input inputMode="decimal" usd className="text-right tabular" placeholder={t("Debit", "Débit")} value={l.debit} onChange={(e) => set(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                  <Input inputMode="decimal" usd className="text-right tabular" placeholder={t("Credit", "Crédit")} value={l.credit} onChange={(e) => set(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                  <Input className="col-span-2 md:col-span-1" placeholder={t("Note (optional)", "Note (facultatif)")} value={l.memo} onChange={(e) => set(l.key, { memo: e.target.value })} />
                  <Button variant="ghost" size="icon" className="col-span-2 justify-self-end md:col-span-1" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t("Remove line", "Retirer la ligne")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {pt && (
                  <div className="mt-2 md:max-w-md">
                    <Field label={pt[0] === "customer" ? t("Customer", "Client") : t("Supplier, agent or employee", "Fournisseur, agent ou employé")} required>
                      <PartySelect types={pt} value={l.partyId} onChange={(id) => set(l.key, { partyId: id })} allowCreate={false} />
                    </Field>
                  </div>
                )}
                {isCdf(a) && (
                  <div className="mt-2 grid grid-cols-2 gap-2 md:max-w-md">
                    <Field label={t("Amount in CDF", "Montant en FC")} required>
                      <Input inputMode="decimal" thousands value={l.native} onChange={(e) => setNative(l, e.target.value, l.rate)} />
                    </Field>
                    <Field label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} required>
                      <Input inputMode="decimal" thousands value={l.rate} onChange={(e) => setNative(l, l.native, e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankJLine()])}>
              <Plus className="mr-1 h-4 w-4" /> {t("Add line", "Ajouter une ligne")}
            </Button>
            <div className="flex flex-wrap justify-end gap-4 text-sm">
              <span>{t("Debits:", "Débits\u00a0:")} <Num className="font-medium">{usd(totalDebit.toFixed(2))}</Num></span>
              <span>{t("Credits:", "Crédits\u00a0:")} <Num className="font-medium">{usd(totalCredit.toFixed(2))}</Num></span>
              <span className={cn("font-semibold", empty ? "text-muted-foreground" : diff.isZero() ? "text-emerald-800 dark:text-emerald-400" : "text-destructive")}>
                {t("Difference:", "Écart\u00a0:")} <Num>{usd(diff.toFixed(2))}</Num>
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <ActionBar canSave={canSave}>
        <Button variant="outline" disabled={savingDraft} onClick={() => onSaveDraft({ kind: "journal", date: day, memo: memo.trim() || null, payload: payload() })}>
          {t("Save as pending", "Mettre en attente")}
        </Button>
        <SubmitButton blocked={problems[0]} pending={m.isPending} onClick={() => m.mutate({ date: day, ...payload() })}>{t("Save", "Enregistrer")}</SubmitButton>
      </ActionBar>
    </div>
  );
}

// ================================================================== Transfer / exchange (logic from Money.tsx TransferDialog)

function TransferForm({ draft, canSave, savingDraft, onSaveDraft, onPosted }: FormProps) {
  const t = useT();
  const p = draft?.payload ?? {};
  const { data: moneyAccounts } = useMoneyAccounts();
  const balances = useBalances();
  const [day, setDay] = useState(draft?.date ?? todayLocal());
  const [fromId, setFromId] = useState<number | null>(numOrNull(p.fromAccountId));
  const [toId, setToId] = useState<number | null>(numOrNull(p.toAccountId));
  const [fromAmount, setFromAmount] = useState(str(p.fromAmount));
  const [toAmount, setToAmount] = useState(str(p.toAmount));
  const [toTouched, setToTouched] = useState(!!p.toAmount);
  const [memo, setMemo] = useState(str(p.memo ?? draft?.memo));
  const dayRate = useRate(day);
  const from = moneyAccounts.find((a) => a.id === fromId) ?? null;
  const to = moneyAccounts.find((a) => a.id === toId) ?? null;
  const sameCurrency = from && to && from.currency === to.currency;

  // Same currency: the "to" amount follows the "from" amount until edited.
  useEffect(() => {
    if (sameCurrency && !toTouched) setToAmount(fromAmount);
  }, [sameCurrency, fromAmount, toTouched]);

  const fa = d(fromAmount);
  const ta = d(toAmount);
  const implied =
    from && to && from.currency !== to.currency && fa.gt(0) && ta.gt(0)
      ? from.currency === "CDF"
        ? fa.dividedBy(ta)
        : ta.dividedBy(fa)
      : null;
  // Francs leave at what they cost on average; dollars at face value. Francs bought with dollars
  // cost the dollars paid, so only selling or moving francs can show a difference.
  const costOf = (a: Account | null, x: ReturnType<typeof d>) => {
    if (!a || a.currency !== "CDF") return x;
    const b = balances.data?.find((y) => y.id === a.id);
    const n = d(b?.nativeBalance);
    const v = d(b?.balance);
    if (n.gt(0) && v.gt(0) && x.lte(n)) return x.times(v).dividedBy(n);
    const r = d(dayRate.data?.cdfPerUsd);
    return r.gt(0) ? x.dividedBy(r) : null;
  };
  // The server refuses an exchange whose two amounts are far from the day's rate ("28.080" FC for 100 $):
  // said here, in red, before the click.
  const tolerance = d(useQuery<Settings>({ queryKey: ["/api/settings"] }).data?.rateTolerancePct ?? "3");
  const dayCdf = d(dayRate.data?.cdfPerUsd);
  const rateGap = implied && dayCdf.gt(0) ? implied.minus(dayCdf).abs().dividedBy(dayCdf).times(100) : null;
  const rateFar = !!rateGap && rateGap.gt(tolerance);
  const rateFarText = rateFar
    ? t(
        `These amounts mean 1 $ = ${number(implied!.toDecimalPlaces(2).toString())} FC, more than ${pct(tolerance.toString(), 2)} away from today's rate (${number(dayCdf.toString())} FC). Check both amounts.`,
        `Ces montants donnent 1\u00a0$ = ${number(implied!.toDecimalPlaces(2).toString())}\u00a0FC, soit plus de ${pct(tolerance.toString(), 2)} d'écart avec le taux du jour (${number(dayCdf.toString())}\u00a0FC). Vérifiez les deux montants.`,
      )
    : null;
  const value = from ? costOf(from, fa) : null;
  const received = to?.currency === "USD" ? ta : value;
  const diff = value && received ? value.toDecimalPlaces(2).minus(received.toDecimalPlaces(2)) : null;
  const balOf = (a: Account | null) => {
    const b = a && balances.data?.find((x) => x.id === a.id);
    return b ? money(a.currency === "CDF" ? b.nativeBalance : b.balance, a.currency) : null;
  };

  const m = useApiMutation<Record<string, unknown>, { id: number }>("POST", "/api/money/transfer", {
    success: t("Transfer recorded", "Transfert enregistré"),
    onSuccess: (res) => {
      setFromAmount("");
      setToAmount("");
      setToTouched(false);
      setMemo("");
      onPosted(res.id);
    },
  });
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
            : rateFar
              ? t("Check the two amounts: their rate is far from today's", "Vérifiez les deux montants\u00a0: leur taux est loin de celui du jour")
              : null;

  function payload(): Record<string, unknown> {
    return {
      fromAccountId: fromId,
      fromAmount: fa.gt(0) ? fa.toFixed(2) : fromAmount.trim(),
      toAccountId: toId,
      toAmount: ta.gt(0) ? ta.toFixed(2) : toAmount.trim(),
      memo: memo.trim() || null,
    };
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Transfer / exchange", "Transfert / change")}</CardTitle>
          <CardDescription>
            {t(
              "Move money between cash boxes, bank and mobile money, or change dollars into francs. Each amount is in its own account's currency.",
              "Déplacer de l'argent entre caisses, banque et mobile money, ou changer des dollars en francs. Chaque montant est dans la devise de son compte.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Date", "Date")} className="sm:col-span-2 sm:max-w-[12rem]">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={t("From account", "Du compte")} required hint={balOf(from) ? `${t("Balance", "Solde")} ${balOf(from)}` : undefined}>
            <MoneyAccountSelect value={fromId} onChange={(id) => setFromId(id)} />
          </Field>
          <Field label={t(`Amount out${from ? ` (${curLabel(from.currency)})` : ""}`, `Montant sorti${from ? ` (${curLabel(from.currency)})` : ""}`)} error={francDecimalsError(t, from?.currency, fromAmount)} required>
            <Input inputMode="decimal" usd={from?.currency === "USD"} thousands={from?.currency === "CDF"} value={fromAmount} onChange={(e) => setFromAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field
            label={t("To account", "Vers le compte")}
            hint={balOf(to) ? `${t("Balance", "Solde")} ${balOf(to)}` : undefined}
            error={from && to && from.id === to.id ? t("Pick two different accounts", "Choisissez deux comptes différents") : null}
            required
          >
            <MoneyAccountSelect value={toId} onChange={(id) => setToId(id)} />
          </Field>
          <Field label={t(`Amount in${to ? ` (${curLabel(to.currency)})` : ""}`, `Montant reçu${to ? ` (${curLabel(to.currency)})` : ""}`)} error={francDecimalsError(t, to?.currency, toAmount)} required>
            <Input inputMode="decimal" usd={to?.currency === "USD"} thousands={to?.currency === "CDF"} value={toAmount} onChange={(e) => { setToAmount(e.target.value); setToTouched(true); }} placeholder="0" />
          </Field>
          <Field label={t("Note (optional)", "Note (facultatif)")} className="sm:col-span-2">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
          {(implied || (diff && !diff.isZero())) && (
            <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2">
              {implied && (
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{t("Rate of this exchange", "Taux de ce change")}</span>
                  <Num className={cn("font-medium", rateFar && "text-destructive")}>{fmtQty(implied.toDecimalPlaces(2).toString())}{"\u00a0"}FC / $</Num>
                </div>
              )}
              {rateFarText && <p role="alert" className="font-medium text-destructive">{rateFarText}</p>}
              {diff && !diff.isZero() && (
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{t("Exchange difference against what the francs cost", "Différence de change par rapport au coût des francs")}</span>
                  <Num className={diff.isPositive() ? "text-destructive" : "text-emerald-800 dark:text-emerald-400"}>
                    {diff.isPositive() ? t("loss", "perte") : t("gain", "gain")} {usd(diff.abs().toFixed(2))}
                  </Num>
                </div>
              )}
              {from?.currency === "USD" && to?.currency === "CDF" && (
                <p className="text-xs text-muted-foreground">{t("The francs are booked at the dollars paid for them.", "Les francs sont comptés au prix payé en dollars.")}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <ActionBar canSave={canSave}>
        <Button variant="outline" disabled={savingDraft} onClick={() => onSaveDraft({ kind: "transfer", date: day, memo: memo.trim() || null, payload: payload() })}>
          {t("Save as pending", "Mettre en attente")}
        </Button>
        <SubmitButton onClick={() => m.mutate({ date: day, ...payload() })} blocked={blocked} pending={m.isPending}>{t("Save", "Enregistrer")}</SubmitButton>
      </ActionBar>
    </div>
  );
}

// ================================================================== Stock adjustment (form from Stock.tsx)

function AdjustmentTab({ draft, canSave, savingDraft, onSaveDraft, onPosted }: FormProps) {
  // Keyed on the saved version so a background refetch does not overwrite what is being typed.
  const initial = useMemo(
    () => (draft ? { date: draft.date, payload: draft.payload as AdjustmentPayload } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft?.id, draft?.updatedAt],
  );
  return (
    <AdjustForm
      initial={initial}
      readOnly={!canSave}
      savingDraft={savingDraft}
      onSaveDraft={(x: AdjustmentDraft) => onSaveDraft({ kind: "adjustment", date: x.date, memo: x.memo, payload: x.payload as Record<string, unknown> })}
      onDone={(r) => onPosted(r.journalId ?? null)}
    />
  );
}
