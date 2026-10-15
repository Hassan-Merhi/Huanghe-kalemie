import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorText, Field, Loading, SubmitButton } from "@/components/common";
import { ApiError, queryClient } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { dateTime, formatLang, number, usd } from "@/lib/format";

interface Snapshot { id: number; kind: "daily" | "before_restore"; day: string; size: number; createdAt: string }
interface Status { snapshots: Snapshot[]; lastDownloadAt: string | null; empty: boolean }
interface Totals { rows: Record<string, number>; debit: string; credit: string; stockValue: string; stockQty: string }
interface Inspect { exportedAt: string; migrations: number; totals: Totals; empty: boolean }
interface Check { label: string; expected: string; actual: string; ok: boolean }

const kb = (n: number) => (n < 1024 * 1024 ? `${number(Math.ceil(n / 1024))} Ko` : `${number((n / 1024 / 1024).toFixed(1))} Mo`);
const daysSince = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);

async function send<T>(url: string, file: File, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: "POST", body: file, credentials: "include", headers: { "content-type": "application/octet-stream", ...headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (formatLang() === "fr" && body.messageFr) || body.message || res.statusText, body.code);
  return body as T;
}

/** Download, daily snapshots and restore, on the owner's Settings page. */
export function BackupPanel() {
  const { t } = useI18n();
  const q = useQuery<Status>({ queryKey: ["/api/backups"] });
  const last = q.data?.lastDownloadAt;
  const stale = !last || daysSince(last) > 7;
  return (
    <div className="grid max-w-4xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Download a backup", "Télécharger une sauvegarde")}</CardTitle>
          <CardDescription>
            {t(
              "One file with everything, users included, taken at a single moment. Keep a copy every week away from the shop (USB key, phone, e-mail to yourself). The file holds the users' password codes, so keep it private.",
              "Un seul fichier avec tout, utilisateurs compris, pris au même instant. Gardez-en une copie chaque semaine hors de la boutique (clé USB, téléphone, e-mail à vous-même). Le fichier contient les codes des mots de passe : gardez-le privé.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <a href="/api/backup" download onClick={() => setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/backups"] }), 3000)}>
              <Download className="mr-1 h-4 w-4" /> {t("Download now", "Télécharger maintenant")}
            </a>
          </Button>
          {q.data && (
            <p className={stale ? "text-sm text-amber-700 dark:text-amber-400" : "text-sm text-muted-foreground"}>
              {last
                ? t(`Last download: ${dateTime(last)}`, `Dernier téléchargement : ${dateTime(last)}`)
                : t("No backup has been downloaded yet.", "Aucune sauvegarde n'a encore été téléchargée.")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Automatic daily snapshots", "Copies automatiques du jour")}</CardTitle>
          <CardDescription>
            {t(
              "The server keeps one snapshot a day for the last 7 days, and one just before each restore. They live on the server, so they help after a mistake, not after losing the server: keep downloading copies too.",
              "Le serveur garde une copie par jour pendant 7 jours, et une juste avant chaque restauration. Elles restent sur le serveur : elles servent après une erreur, pas après la perte du serveur. Continuez à télécharger des copies.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorText error={q.error} />
          ) : !q.data?.snapshots.length ? (
            <p className="text-sm text-muted-foreground">{t("The first snapshot is taken a minute after the server starts.", "La première copie est prise une minute après le démarrage du serveur.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Taken", "Prise le")}</TableHead>
                  <TableHead>{t("Kind", "Type")}</TableHead>
                  <TableHead className="text-right">{t("Size", "Taille")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.snapshots.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="whitespace-nowrap">{dateTime(s.createdAt)}</TableCell>
                    <TableCell>
                      {s.kind === "daily" ? <Badge variant="secondary">{t("Daily", "Du jour")}</Badge> : <Badge variant="outline">{t("Before a restore", "Avant restauration")}</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular">{kb(s.size)}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/backups/${s.id}`} download>
                          <Download className="mr-1 h-4 w-4" /> {t("Download", "Télécharger")}
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RestoreCard empty={q.data?.empty ?? false} />
    </div>
  );
}

function RestoreCard({ empty }: { empty: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{ rows: number; checks: Check[] } | null>(null);
  const WORD = t("REPLACE", "REMPLACER");

  async function pick(f: File | undefined) {
    setFile(f ?? null);
    setInfo(null);
    setResult(null);
    setError(null);
    if (!f) return;
    setBusy(true);
    try {
      setInfo(await send<Inspect>("/api/backup/inspect", f));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send<{ rows: number; checks: Check[] }>(`/api/backup/restore${info?.empty ? "" : "?replace=1"}`, file, { "X-Current-Password": password });
      setResult(r);
      // Everyone, including you, signs in again against the restored users.
      setTimeout(() => (window.location.href = "/"), 6000);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const needsReplace = info && !info.empty;
  const blocked = !file
    ? t("Choose a backup file", "Choisissez un fichier de sauvegarde")
    : !info
      ? t("The file is being checked", "Le fichier est en cours de vérification")
      : needsReplace && !replace
        ? t("Tick the box to replace the current data", "Cochez la case pour remplacer les données actuelles")
        : needsReplace && typed.trim().toUpperCase() !== WORD
          ? t(`Type ${WORD} to confirm`, `Tapez ${WORD} pour confirmer`)
          : !password
            ? t("Enter your password", "Saisissez votre mot de passe")
            : null;
  const rowsIn = (tot: Totals) => Object.values(tot.rows).reduce((s, n) => s + n, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("Restore a backup", "Restaurer une sauvegarde")}</CardTitle>
        <CardDescription>
          {empty
            ? t(
                "This shop is empty: a backup can rebuild it completely. Afterwards everyone signs in again with the passwords from the backup.",
                "Cette boutique est vide : une sauvegarde peut la reconstruire entièrement. Ensuite chacun se reconnecte avec les mots de passe de la sauvegarde.",
              )
            : t(
                "Restoring replaces everything in this shop with the file. A copy of today's data is kept first, and the totals are checked before anything is changed.",
                "La restauration remplace tout le contenu de cette boutique par le fichier. Une copie des données actuelles est gardée d'abord, et les totaux sont vérifiés avant tout changement.",
              )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input ref={input} type="file" accept=".json,.gz,application/json,application/gzip" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            <Upload className="mr-1 h-4 w-4" /> {t("Choose the file", "Choisir le fichier")}
          </Button>
          {file && <span className="text-sm text-muted-foreground">{file.name} · {kb(file.size)}</span>}
        </div>
        {busy && !info && <Loading />}
        {info && !result && (
          <div className="rounded-md border p-3 text-sm">
            <p>{t("Backup taken", "Sauvegarde prise le")} <span className="font-medium">{dateTime(info.exportedAt)}</span></p>
            <p className="text-muted-foreground">
              {number(rowsIn(info.totals))} {t("records", "enregistrements")} · {number(info.totals.rows.journals ?? 0)} {t("postings", "écritures")} · {number(info.totals.rows.sales ?? 0)} {t("sales", "ventes")} · {t("stock", "stock")} {usd(info.totals.stockValue)}
            </p>
          </div>
        )}
        {needsReplace && !result && (
          <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={replace} onCheckedChange={(v) => setReplace(v === true)} className="mt-0.5" />
              <span>{t("Replace all the data in this shop with the backup.", "Remplacer toutes les données de cette boutique par la sauvegarde.")}</span>
            </label>
            {replace && (
              <Field label={t(`Type ${WORD}`, `Tapez ${WORD}`)} required>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </Field>
            )}
          </div>
        )}
        {info && !result && (
          <Field label={t("Your password", "Votre mot de passe")} required>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="max-w-xs" />
          </Field>
        )}
        {error ? <ErrorText error={error} /> : null}
        {!result && (
          <div className="flex justify-end">
            <SubmitButton variant={needsReplace ? "destructive" : "default"} blocked={blocked} pending={busy && !!info} onClick={run}>
              {t("Restore", "Restaurer")}
            </SubmitButton>
          </div>
        )}
        {result && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              {t(
                `Restored ${number(result.rows)} records; every total matches the backup. You will be asked to sign in again.`,
                `${number(result.rows)} enregistrements restaurés ; tous les totaux correspondent à la sauvegarde. Vous allez devoir vous reconnecter.`,
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("Checked:", "Vérifié\u00a0:")} {result.checks.length} {t("totals", "totaux")} · {t("debits", "débits")} {usd(result.checks.find((c) => c.label === "debit")?.actual ?? "0")} · {t("stock", "stock")} {usd(result.checks.find((c) => c.label === "stockValue")?.actual ?? "0")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
