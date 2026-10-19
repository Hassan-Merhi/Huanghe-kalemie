import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, Eye, Pencil, Plus, Search, Trash2, X } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Loading, Num, PageHeader, StatCard } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useAccounts, useRateTooFar } from "@/components/pickers";
import { cdf, d, date, number, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useVoucherChecks } from "@/lib/voucherChecks";
import { VOUCHER_KINDS, voucherKindLabel, type VoucherDraft, type VoucherKind } from "@/pages/Vouchers";

/**
 * A franc payment or receipt is shown in the francs it was typed in, with its dollars beside them
 * ("14 000 000 FC (≈ 4 985,75 $)"), so whoever validates it sees the notes that will leave the drawer.
 */
function useDraftFrancs() {
  const accounts = useAccounts();
  return (r: VoucherDraft): string | null => {
    if (r.kind !== "payment" && r.kind !== "receipt") return null;
    const account = accounts.data?.find((a) => a.id === Number(r.payload.accountId));
    if (account?.currency !== "CDF") return null;
    const lines = Array.isArray(r.payload.lines) ? (r.payload.lines as Record<string, unknown>[]) : [];
    const amounts = lines.map((l) => String(l.amount ?? "").trim()).filter((x) => /^\d+(\.\d+)?$/.test(x));
    if (!amounts.length) return null;
    return cdf(amounts.reduce((s, x) => s.plus(d(x)), d(0)).toFixed(0));
  };
}

/** "14 000 000 FC" over "≈ 4 985,75 $" for a franc voucher, else its dollars. */
function DraftAmount({ r, francs, className }: { r: VoucherDraft; francs: string | null; className?: string }) {
  if (!francs) return <Num className={className}>{r.totalUsd ? usd(r.totalUsd) : "—"}</Num>;
  return (
    <span className="inline-block text-right">
      <Num className={cn("whitespace-nowrap", className)}>{francs}</Num>
      {r.totalUsd && <span className="block whitespace-nowrap text-xs font-normal text-muted-foreground tabular">≈ {usd(r.totalUsd)}</span>}
    </span>
  );
}

const isAmount = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

const KIND_TONE: Record<VoucherKind, string> = {
  payment: "border-red-500/40 text-red-700 dark:text-red-400",
  receipt: "border-emerald-500/40 text-emerald-800 dark:text-emerald-400",
  journal: "border-violet-500/40 text-violet-700 dark:text-violet-400",
  transfer: "border-sky-500/40 text-sky-700 dark:text-sky-400",
  adjustment: "border-amber-500/40 text-amber-800 dark:text-amber-400",
};

interface FinalizeResult {
  kind: VoucherKind;
  result: { id?: number; journalId?: number | null };
}

export default function OptionalVouchers() {
  const t = useT();
  const { user, can } = useAuth();
  const { toast } = useToast();
  const canSave = can("manager");
  const isOwner = user?.role === "owner";
  const francsOf = useDraftFrancs();
  const q = useQuery<VoucherDraft[]>({ queryKey: ["/api/voucher-drafts"] });
  const [kind, setKind] = useState<"all" | VoucherKind>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<{ action: "finalize" | "delete"; draft: VoucherDraft } | null>(null);
  // A payment the drawer cannot cover is refused by the server: Valider waits, with the reason, as on the voucher form.
  const [short, setShort] = useState<string | null>(null);
  const [shortFix, setShortFix] = useState<string | null>(null);
  const onShort = useCallback((reason: string | null, fix: string | null) => {
    setShort(reason);
    setShortFix(fix);
  }, []);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter(
      (r) =>
        (kind === "all" || r.kind === kind) &&
        (!from || r.date >= from) &&
        (!to || r.date <= to) &&
        (!s || (r.memo ?? "").toLowerCase().includes(s)),
    );
  }, [q.data, kind, from, to, search]);
  const total = rows.reduce((sum, r) => sum.plus(r.totalUsd ? d(r.totalUsd) : 0), d(0));
  const filtered = kind !== "all" || !!from || !!to || !!search.trim();

  // The draft's updatedAt goes with it: a draft changed since it was shown here is refused (409) and the list reloads.
  const finalize = useApiMutation<{ id: number; updatedAt: string }, FinalizeResult>("POST", (b) => `/api/voucher-drafts/${b.id}/finalize`, {
    onError: () => {
      void q.refetch();
    },
    onSuccess: (res) => {
      const journalId = res.result?.id ?? res.result?.journalId ?? null;
      toast({
        title: t("Voucher validated and posted", "Pièce validée et passée"),
        description: journalId ? (
          <Link href={`/vouchers/${journalId}`} className="underline">{t("Open / print the voucher", "Ouvrir / imprimer la pièce")}</Link>
        ) : undefined,
      });
    },
  });
  const remove = useApiMutation<{ id: number }>("DELETE", (b) => `/api/voucher-drafts/${b.id}`, {
    success: t("Pending voucher deleted", "Pièce en attente supprimée"),
  });

  function run() {
    if (!confirm) return;
    if (confirm.action === "finalize" && short) return;
    if (confirm.action === "finalize") finalize.mutate({ id: confirm.draft.id, updatedAt: confirm.draft.updatedAt });
    else remove.mutate({ id: confirm.draft.id });
    setConfirm(null);
  }

  const canFinalize = (r: VoucherDraft) => canSave && (r.kind !== "journal" || isOwner);
  const editHref = (r: VoucherDraft) => `/vouchers?tab=${r.kind}&draft=${r.id}`;

  function actions(r: VoucherDraft, compact?: boolean) {
    return (
      // One line in the table; a phone card wraps them.
      <div className={cn("flex items-center gap-1", compact ? "flex-wrap" : "flex-nowrap justify-end")}>
        <Button size="sm" variant="ghost" className="px-2" asChild>
          <Link href={editHref(r)}>
            {canSave ? <Pencil className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
            {canSave ? t("Edit", "Modifier") : t("View", "Voir")}
          </Link>
        </Button>
        {canSave && (
          <Button
            size="sm"
            variant="ghost"
            className="px-2 text-emerald-800 dark:text-emerald-400"
            disabled={!canFinalize(r) || finalize.isPending}
            title={!canFinalize(r) ? t("Only the owner can post a journal entry", "Seul le propriétaire peut passer une écriture") : undefined}
            onClick={() => setConfirm({ action: "finalize", draft: r })}
          >
            <Check className="mr-1 h-3.5 w-3.5" /> {t("Validate", "Valider")}
          </Button>
        )}
        {canSave && (
          <Button size="sm" variant="ghost" className="px-2 text-destructive" disabled={remove.isPending} onClick={() => setConfirm({ action: "delete", draft: r })}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> {t("Delete", "Supprimer")}
          </Button>
        )}
      </div>
    );
  }

  const kindBadge = (k: VoucherKind) => (
    <Badge variant="outline" className={cn("whitespace-nowrap", KIND_TONE[k])}>{voucherKindLabel(k, t)}</Badge>
  );

  return (
    <div>
      <PageHeader
        title={t("Pending vouchers", "Pièces en attente")}
        description={t(
          "Optional vouchers are saved but change no balance, stock or report until they are validated.",
          "Les pièces en attente sont enregistrées mais ne changent aucun solde, stock ni rapport tant qu'elles ne sont pas validées.",
        )}
        actions={
          canSave ? (
            <Button asChild><Link href="/vouchers"><Plus className="mr-1 h-4 w-4" /> {t("New voucher", "Nouvelle pièce")}</Link></Button>
          ) : undefined
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
        <StatCard label={filtered ? t("Shown", "Affichées") : t("Pending vouchers", "Pièces en attente")} value={rows.length} />
        <StatCard label={t("Total ($)", "Total ($)")} value={usd(total.toFixed(2))} sub={t("Stock adjustments have no total", "Les ajustements de stock n'ont pas de total")} />
      </div>

      {/* Du / Au over their fields, so a phone shows the whole "jj/mm/aaaa" and says which date is which. */}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as "all" | VoucherKind)}>
          <SelectTrigger className="w-full sm:w-52" aria-label={t("Voucher type", "Type de pièce")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All types", "Tous les types")}</SelectItem>
            {VOUCHER_KINDS.map((k) => <SelectItem key={k} value={k}>{voucherKindLabel(k, t)}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="w-[calc(50%-0.25rem)] space-y-1 sm:w-40">
          <span className="block text-xs text-muted-foreground">{t("From", "Du")}</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("From", "Du")} />
        </label>
        <label className="w-[calc(50%-0.25rem)] space-y-1 sm:w-40">
          <span className="block text-xs text-muted-foreground">{t("To", "Au")}</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("To", "Au")} />
        </label>
        <div className="relative w-full sm:w-auto sm:min-w-[14rem] sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder={t("Search description", "Chercher dans le libellé")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => { setKind("all"); setFrom(""); setTo(""); setSearch(""); }}>
            <X className="mr-1 h-4 w-4" /> {t("Clear", "Effacer")}
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={filtered ? t("Nothing matches these filters", "Rien ne correspond à ces filtres") : t("No pending vouchers", "Aucune pièce en attente")}>
          {!filtered && t("Use “Save as optional” on a voucher to keep it here before posting it.", "Utilisez «\u00a0Mettre en attente\u00a0» sur une pièce pour la garder ici avant de la passer.")}
        </EmptyState>
      ) : (
        <>
          {/* Desktop */}
          <Card className="hidden md:block">
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date", "Date")}</TableHead>
                    <TableHead>{t("Type", "Type")}</TableHead>
                    <TableHead>{t("Description", "Libellé")}</TableHead>
                    <TableHead className="text-right">{t("Total", "Total")}</TableHead>
                    <TableHead>{t("Created by", "Saisi par")}</TableHead>
                    <TableHead className="px-2 text-right">{t("Actions", "Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{date(r.date)}</TableCell>
                      <TableCell>{kindBadge(r.kind)}</TableCell>
                      {/* The description takes the row's spare width, so the actions stay on one line in view: on up to
                          three lines at 768–1279 px, where the column is narrow, on two from 1280 px (cut only beyond that). */}
                      <TableCell className="w-full min-w-[8rem] max-w-0 truncate md:whitespace-normal xl:min-w-[10rem]" title={r.memo || undefined}>
                        <span className="md:line-clamp-3 xl:line-clamp-2">{r.memo || <span className="text-muted-foreground">—</span>}</span>
                      </TableCell>
                      <TableCell className="text-right"><DraftAmount r={r} francs={francsOf(r)} /></TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{r.createdByName ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap px-2">{actions(r)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Mobile */}
          <div className="space-y-2 md:hidden">
            {rows.map((r) => (
              <Card key={r.id}>
                <CardContent className="space-y-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {kindBadge(r.kind)}
                        <span className="text-xs text-muted-foreground">{date(r.date)}</span>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium">{r.memo || "—"}</p>
                      <p className="text-xs text-muted-foreground">{r.createdByName ?? "—"}</p>
                    </div>
                    <DraftAmount r={r} francs={francsOf(r)} className="font-semibold" />
                  </div>
                  {actions(r, true)}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "finalize" ? t("Validate this voucher?", "Valider cette pièce\u00a0?") : t("Delete this pending voucher?", "Supprimer cette pièce en attente\u00a0?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "finalize"
                ? t(
                    "It will be posted with all the usual checks: balances, stock and reports change, and it leaves this list.",
                    "Elle sera passée avec tous les contrôles habituels\u00a0: les soldes, le stock et les rapports changent, et elle quitte cette liste.",
                  )
                : t("Nothing was posted from it, so nothing else changes. This cannot be undone.", "Rien n'a été passé à partir d'elle, donc rien d'autre ne change. Action irréversible.")}
            </AlertDialogDescription>
            {confirm && <DraftSummary key={confirm.draft.id} draft={confirm.draft} check={confirm.action === "finalize"} onShort={onShort} />}
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:items-center">
            {confirm?.action === "finalize" && short && (
              <p className="order-last text-center text-xs text-muted-foreground sm:order-none sm:mr-auto sm:text-left" role="status">
                {shortFix}
              </p>
            )}
            <AlertDialogCancel>{t("Cancel", "Annuler")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={run}
              disabled={confirm?.action === "finalize" && !!short}
              className={cn(confirm?.action === "delete" && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
            >
              {confirm?.action === "finalize" ? t("Validate", "Valider") : t("Delete", "Supprimer")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The pending voucher in the confirmation: its description (or what the day book will call it), and on
 * "Valider" the same unusual-amount and over-debt questions as the voucher form, since this posts it.
 */
function DraftSummary({ draft, check, onShort }: { draft: VoucherDraft; check: boolean; onShort?: (reason: string | null, fix: string | null) => void }) {
  const t = useT();
  const p = draft.payload;
  const lines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : [];
  const checks = useVoucherChecks({
    kind: draft.kind,
    day: draft.date,
    accountId: Number(p.accountId) || null,
    rate: p.rate ? String(p.rate) : null,
    lines: lines.map((l) => ({ partyId: Number(l.partyId) || null, accountId: Number(l.accountId) || null, amount: l.amount == null ? "" : String(l.amount) })),
    enabled: check,
  });
  const warnings = check ? [...checks.unusual, ...checks.overDebt, ...checks.advanceUse] : [];
  // A rate the server would refuse stops Valider with its reason, as on the voucher form: the owner's rate is
  // kept on a franc voucher (staff's is replaced by the day's), and a transfer's two amounts make one.
  const isOwner = useAuth().user?.role === "owner";
  const accounts = useAccounts().data;
  const accOf = (x: unknown) => accounts?.find((a) => a.id === Number(x));
  const from = accOf(p.fromAccountId);
  const to = accOf(p.toAccountId);
  const fa = d(isAmount(String(p.fromAmount ?? "")) ? String(p.fromAmount) : 0);
  const ta = d(isAmount(String(p.toAmount ?? "")) ? String(p.toAmount) : 0);
  const implied = draft.kind === "transfer" && from && to && from.currency !== to.currency && fa.gt(0) && ta.gt(0)
    ? from.currency === "CDF" && to.currency === "USD" ? fa.dividedBy(ta) : from.currency === "USD" && to.currency === "CDF" ? ta.dividedBy(fa) : null
    : null;
  const voucherRate = (draft.kind === "payment" || draft.kind === "receipt") && isOwner && checks.currency === "CDF" && p.rate ? String(p.rate) : "";
  const tooFar = useRateTooFar(draft.date, implied ? implied.toString() : voucherRate);
  const rateFar = tooFar && implied
    ? t(
        `These amounts mean 1 $ = ${number(implied.toDecimalPlaces(2).toString())} FC, too far from the day's rate`,
        `Ces montants donnent 1\u00a0$ = ${number(implied.toDecimalPlaces(2).toString())}\u00a0FC, trop loin du taux du jour`,
      )
    : tooFar;
  const short = check ? checks.short ?? rateFar : null;
  const fix = !short
    ? null
    : checks.short
      ? t("Add money to the account or lower the amount first.", "Approvisionnez le compte ou réduisez le montant d'abord.")
      : implied
        ? t("Correct the two amounts with Edit, or change the day's rate.", "Corrigez les deux montants avec Modifier, ou modifiez le taux du jour.")
        : t("Correct the rate with Edit, or change the day's rate.", "Corrigez le taux avec Modifier, ou modifiez le taux du jour.");
  useEffect(() => {
    onShort?.(short, fix);
    return () => onShort?.(null, null);
  }, [short, fix, onShort]);
  const memo = draft.memo || checks.fallbackMemo || t("no description", "sans libellé");
  // Francs as typed, then their dollars: the francs are what leave (or come into) the drawer.
  const amount = checks.currency === "CDF" && checks.total.gt(0)
    ? `${cdf(checks.total.toFixed(0))}${draft.totalUsd ? ` (≈\u00a0${usd(draft.totalUsd)})` : ""}`
    : draft.totalUsd ? usd(draft.totalUsd) : null;
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium text-foreground">
        {voucherKindLabel(draft.kind, t)} · {date(draft.date)} · <span className={cn(!draft.memo && "italic")}>{memo}</span>
        {amount ? <> · <span className="whitespace-nowrap">{amount}</span></> : ""}
      </p>
      {short && (
        <p role="alert" className="font-medium text-destructive" data-testid="draft-short">{short}.</p>
      )}
      {warnings.length > 0 && (
        <div role="alert" className="space-y-1 font-medium text-amber-800 dark:text-amber-400" data-testid="draft-warnings">
          {warnings.map((w) => <p key={w}>{w}.</p>)}
          {warnings.length > checks.advanceUse.length && <p className="font-normal text-muted-foreground">{t("Check for an extra zero before validating.", "Vérifiez qu'il n'y a pas un zéro de trop avant de valider.")}</p>}
        </div>
      )}
    </div>
  );
}
