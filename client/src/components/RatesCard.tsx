import { useState, type ReactNode } from "react";
import type Decimal from "decimal.js";
import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import { Field, Num, SubmitButton } from "@/components/common";
import { useRate } from "@/components/pickers";
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
import type { Settings } from "@/lib/types";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { cdf, d, date, money, pct, qty as fmtQty, todayLocal } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** The day's franc (and yuan) rate: shown to everyone, set by managers and the owner. */
export function RatesCard() {
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
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] }).data;
  const tolerance = d(settings?.rateTolerancePct ?? "3");
  // Compared with the last rate before the chosen day (as the server does for managers), never with that
  // day's own rate, which may be the very mistake being put right.
  const rows = listQ.data ?? [];
  const refCdf = rows.find((r) => r.date < day)?.cdfPerUsd ?? (current && current.source !== day ? current.cdfPerUsd : null);
  const refCny = rows.find((r) => r.date < day && r.cnyPerUsd)?.cnyPerUsd ?? null;
  const gapOf = (typedRate: string, ref: string | null): Decimal | null => {
    const x = d(typedRate);
    return ref && d(ref).gt(0) && x.gt(0) ? x.minus(ref).abs().dividedBy(ref).times(100) : null;
  };
  const cdfGap = gapOf(value, refCdf);
  const cnyGap = cny ? gapOf(cny, refCny) : null;
  const cdfFar = !!cdfGap && cdfGap.gt(tolerance);
  // No yuan rate on file yet: only a rate a yuan cannot have (outside 4 to 12,5 ¥ for 1 $, as the server
  // checks a container's) is questioned.
  const cnyOdd = !refCny && !!cny && d(cny).gt(0) && (d(cny).lt(4) || d(cny).gt("12.5"));
  const cnyFar = (!!cnyGap && cnyGap.gt(tolerance)) || cnyOdd;
  // "28 500" for 2 850, or "2,85": every franc check at the till compares with this rate, so it cannot catch it.
  const farHint = (gap: Decimal, ref: string, sign: string): ReactNode => (
    <span className="font-medium text-amber-800 dark:text-amber-400">
      {t(
        `Far from the rate on file (1 $ = ${fmtQty(ref)} ${sign}, ${pct(gap.toDecimalPlaces(0).toString(), 0)} apart): check it`,
        `Loin du taux enregistré (1\u00a0$ = ${fmtQty(ref)}\u00a0${sign}, ${pct(gap.toDecimalPlaces(0).toString(), 0)} d'écart)\u00a0: vérifiez-le`,
      )}
    </span>
  );
  const [confirming, setConfirming] = useState(false);
  const save = () => m.mutate({ date: day, cdfPerUsd: d(value).toString(), cnyPerUsd: cny && d(cny).gt(0) ? d(cny).toString() : null });

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
            <Field label={t("FC per $1", "FC pour 1\u00a0$")} required className="min-w-[7rem] flex-1" hint={cdfFar && refCdf ? farHint(cdfGap!, refCdf, "FC") : undefined}>
              <Input inputMode="decimal" thousands value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field
              // A short label, on one line like its neighbour, so both fields sit at the same height.
              label={t("¥ per $1", "¥ pour 1\u00a0$")}
              hint={cnyFar && refCny ? farHint(cnyGap!, refCny, "¥") : cnyOdd ? <span className="font-medium text-amber-800 dark:text-amber-400">{t("A dollar buys about 7.1 ¥: check it", "Un dollar vaut environ 7,1\u00a0¥\u00a0: vérifiez-le")}</span> : lastCny ? t("Optional", "Facultatif") : t("Optional, about 7.1", "Facultatif, environ 7,1")}
              className="min-w-[7rem] flex-1"
            >
              <Input inputMode="decimal" value={cny} onChange={(e) => setCny(e.target.value)} />
            </Field>
            <SubmitButton
              className="w-full sm:flex-col sm:items-stretch [&>button]:w-full"
              blocked={!day ? t("Choose a date", "Choisissez une date") : !d(value).gt(0) ? t("Enter a rate above zero", "Saisissez un taux supérieur à zéro") : cny && !d(cny).gt(0) ? t("The yuan rate must be above zero", "Le taux du yuan doit être supérieur à zéro") : null}
              pending={m.isPending}
              onClick={() => (cdfFar || cnyFar ? setConfirming(true) : save())}
            >
              {t("Set rate", "Enregistrer le taux")}
            </SubmitButton>
          </div>
        )}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Save this rate?", "Enregistrer ce taux\u00a0?")}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  {cdfFar && refCdf && (
                    <p>
                      {t(
                        `1 $ = ${fmtQty(value)} FC is ${pct(cdfGap!.toDecimalPlaces(0).toString(), 0)} away from the last rate (${fmtQty(refCdf)} FC).`,
                        `1\u00a0$ = ${fmtQty(value)}\u00a0FC s'écarte de ${pct(cdfGap!.toDecimalPlaces(0).toString(), 0)} du dernier taux (${fmtQty(refCdf)}\u00a0FC).`,
                      )}
                    </p>
                  )}
                  {cnyOdd && <p>{t(`1 $ = ${fmtQty(cny)} ¥ is far from the usual rate (about 7.1 ¥).`, `1\u00a0$ = ${fmtQty(cny)}\u00a0¥ est loin du taux habituel (environ 7,1\u00a0¥).`)}</p>}
                  {cnyFar && refCny && (
                    <p>
                      {t(
                        `1 $ = ${fmtQty(cny)} ¥ is ${pct(cnyGap!.toDecimalPlaces(0).toString(), 0)} away from the last yuan rate (${fmtQty(refCny)} ¥).`,
                        `1\u00a0$ = ${fmtQty(cny)}\u00a0¥ s'écarte de ${pct(cnyGap!.toDecimalPlaces(0).toString(), 0)} du dernier taux du yuan (${fmtQty(refCny)}\u00a0¥).`,
                      )}
                    </p>
                  )}
                  <p>{t("Every franc amount at the till and in the books is converted at this rate. Save it only if it is right.", "Chaque montant en francs, à la caisse comme dans les comptes, est converti à ce taux. Enregistrez-le seulement s'il est juste.")}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Correct it", "Corriger")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={m.isPending}
                onClick={() => {
                  setConfirming(false);
                  save();
                }}
              >
                {t("Save anyway", "Enregistrer quand même")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Last rates", "Derniers taux")}</p>
          {(listQ.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="max-h-56 divide-y overflow-y-auto text-sm">
              {(listQ.data ?? []).slice(0, 15).map((r) => (
                <div key={r.date} className="flex justify-between py-1">
                  <span>{date(r.date)}</span>
                  <Num>{cdf(r.cdfPerUsd)}{r.cnyPerUsd ? ` · ${fmtQty(r.cnyPerUsd)}\u00a0¥` : ""}</Num>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
