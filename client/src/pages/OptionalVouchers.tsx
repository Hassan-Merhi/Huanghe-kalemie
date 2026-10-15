import { useMemo, useState } from "react";
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
import { d, date, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { VOUCHER_KINDS, voucherKindLabel, type VoucherDraft, type VoucherKind } from "@/pages/Vouchers";

const KIND_TONE: Record<VoucherKind, string> = {
  payment: "border-red-500/40 text-red-700 dark:text-red-400",
  receipt: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  journal: "border-violet-500/40 text-violet-700 dark:text-violet-400",
  transfer: "border-sky-500/40 text-sky-700 dark:text-sky-400",
  adjustment: "border-amber-500/40 text-amber-700 dark:text-amber-400",
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
  const q = useQuery<VoucherDraft[]>({ queryKey: ["/api/voucher-drafts"] });
  const [kind, setKind] = useState<"all" | VoucherKind>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<{ action: "finalize" | "delete"; draft: VoucherDraft } | null>(null);

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

  const finalize = useApiMutation<{ id: number }, FinalizeResult>("POST", (b) => `/api/voucher-drafts/${b.id}/finalize`, {
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
    const body = { id: confirm.draft.id };
    if (confirm.action === "finalize") finalize.mutate(body);
    else remove.mutate(body);
    setConfirm(null);
  }

  const canFinalize = (r: VoucherDraft) => canSave && (r.kind !== "journal" || isOwner);
  const editHref = (r: VoucherDraft) => `/vouchers?tab=${r.kind}&draft=${r.id}`;

  function actions(r: VoucherDraft, compact?: boolean) {
    return (
      <div className={cn("flex flex-wrap items-center gap-1", !compact && "justify-end")}>
        <Button size="sm" variant="ghost" asChild>
          <Link href={editHref(r)}>
            {canSave ? <Pencil className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
            {canSave ? t("Edit", "Modifier") : t("View", "Voir")}
          </Link>
        </Button>
        {canSave && (
          <Button
            size="sm"
            variant="ghost"
            className="text-emerald-700 dark:text-emerald-400"
            disabled={!canFinalize(r) || finalize.isPending}
            title={!canFinalize(r) ? t("Only the owner can post a journal entry", "Seul le propriétaire peut passer une écriture") : undefined}
            onClick={() => setConfirm({ action: "finalize", draft: r })}
          >
            <Check className="mr-1 h-3.5 w-3.5" /> {t("Validate", "Valider")}
          </Button>
        )}
        {canSave && (
          <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending} onClick={() => setConfirm({ action: "delete", draft: r })}>
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
        <StatCard label={t("Total (USD)", "Total (USD)")} value={usd(total.toFixed(2))} sub={t("Stock adjustments have no total", "Les ajustements de stock n'ont pas de total")} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as "all" | VoucherKind)}>
          <SelectTrigger className="w-full sm:w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All types", "Tous les types")}</SelectItem>
            {VOUCHER_KINDS.map((k) => <SelectItem key={k} value={k}>{voucherKindLabel(k, t)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="w-[calc(50%-0.25rem)] sm:w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("From", "Du")} />
        <Input type="date" className="w-[calc(50%-0.25rem)] sm:w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("To", "Au")} />
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
                    <TableHead className="text-right">{t("Actions", "Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{date(r.date)}</TableCell>
                      <TableCell>{kindBadge(r.kind)}</TableCell>
                      <TableCell className="max-w-xs truncate">{r.memo || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-right"><Num>{r.totalUsd ? usd(r.totalUsd) : "—"}</Num></TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{r.createdByName ?? "—"}</TableCell>
                      <TableCell>{actions(r)}</TableCell>
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
                    <Num className="font-semibold">{r.totalUsd ? usd(r.totalUsd) : "—"}</Num>
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
              {confirm && (
                <span className="mt-2 block font-medium text-foreground">
                  {voucherKindLabel(confirm.draft.kind, t)} · {date(confirm.draft.date)}
                  {confirm.draft.memo ? ` · ${confirm.draft.memo}` : ""}
                  {confirm.draft.totalUsd ? ` · ${usd(confirm.draft.totalUsd)}` : ""}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel", "Annuler")}</AlertDialogCancel>
            <AlertDialogAction onClick={run} className={cn(confirm?.action === "delete" && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}>
              {confirm?.action === "finalize" ? t("Validate", "Valider") : t("Delete", "Supprimer")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
