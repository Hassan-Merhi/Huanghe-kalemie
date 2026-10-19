import { useState, type ReactNode } from "react";
import Decimal from "decimal.js";
import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import { Field, Num, SubmitButton, useCorrectFocus } from "@/components/common";
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
import { cdf, d, date, gapPct, money, pct, qty as fmtQty, todayLocal } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** The day's franc (and yuan) rate: shown to everyone, set by managers and the owner. */
export function RatesCard() {
  const t = useT();
  const { can, user } = useAuth();
  const isOwner = user?.role === "owner";
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
  // Compared, as the server does, with whichever is nearer of the last rate before the chosen day and that
  // day's own rate, so a day's own mistake (28 100) put right does not warn against itself; "281", far
  // from both, is said against today's 2 810 shown above, not yesterday's 2 812.
  const rows = listQ.data ?? [];
  const beforeRow = rows.find((r) => r.date < day) ?? (current && current.source !== day ? { date: current.source, cdfPerUsd: current.cdfPerUsd } : null);
  const before = beforeRow?.cdfPerUsd ?? null;
  const own = rows.find((r) => r.date === day)?.cdfPerUsd ?? null;
  const nearer = (refs: (string | null)[], x: string) =>
    refs.filter((r): r is string => !!r && d(r).gt(0)).reduce<string | null>((best, r) => (!best || d(r).minus(d(x)).abs().lt(d(best).minus(d(x)).abs()) ? r : best), null);
  const refNear = d(value).gt(0) ? nearer([before, own], value) : before;
  const refCny = rows.find((r) => r.date < day && r.cnyPerUsd)?.cnyPerUsd ?? null;
  const gapOf = (typedRate: string, ref: string | null): Decimal | null => {
    const x = d(typedRate);
    return ref && d(ref).gt(0) && x.gt(0) ? x.minus(ref).abs().dividedBy(ref).times(100) : null;
  };
  const nearGap = gapOf(value, refNear);
  const cdfFar = !!nearGap && nearGap.gt(tolerance);
  // Far from both: said against the day's rate shown on the card, not one from another day.
  const refCdf = cdfFar ? own ?? refNear : refNear;
  const cdfGap = gapOf(value, refCdf);
  const cnyGap = cny ? gapOf(cny, refCny) : null;
  // Far from both, the check itself went by the nearer one (2 900 is 3,3 % from today's 2 808 and 3,1 % from
  // yesterday's 2 812): the confirmation names that one too, with its own gap.
  const checkedApart = cdfFar && refNear && refCdf !== refNear ? refNear : null;
  // The day's own rate, or the last one before it, named with its date so the two never read as one.
  const refName = (ref: string) =>
    ref === own && ref !== before
      ? t(`the rate already set for ${date(day)} (${fmtQty(ref)} FC)`, `du taux déjà saisi pour le ${date(day)} (${fmtQty(ref)}\u00a0FC)`)
      : beforeRow && /^\d{4}-/.test(beforeRow.date)
        ? t(`the last rate (${fmtQty(ref)} FC on ${date(beforeRow.date)})`, `du dernier taux (${fmtQty(ref)}\u00a0FC le ${date(beforeRow.date)})`)
        : t(`the last rate (${fmtQty(ref)} FC)`, `du dernier taux (${fmtQty(ref)}\u00a0FC)`);
  // A manager cannot save a past day's rate, nor one far from the last (the server refuses both): said
  // here, without offering "save anyway". The owner may save any rate after confirming.
  const managerLimit = Decimal.max(tolerance, 5);
  // A day that has its rate already is also held to it, as the server does: 2 950 is near yesterday's 2 812
  // but 5,06 % from today's 2 808.
  const ownGap = own && d(value).gt(0) && !d(value).equals(d(own)) ? gapOf(value, own) : null;
  const gapText = (gap: Decimal) => gapPct(gap, [tolerance, managerLimit]);
  const ownerOnly = isOwner
    ? null
    : day && day < today
      ? t("Only the owner can change a past day's rate.", "Seul le propriétaire peut modifier le taux d'un jour passé.")
      : nearGap && nearGap.gt(managerLimit) && refCdf
        ? t(
            `More than ${pct(managerLimit.toString(), 0)} away from ${fmtQty(refCdf)} FC: only the owner can save it. Check the figure, or ask the owner.`,
            `Plus de ${pct(managerLimit.toString(), 0)} d'écart avec ${fmtQty(refCdf)}\u00a0FC\u00a0: seul le propriétaire peut l'enregistrer. Vérifiez le chiffre, ou demandez au propriétaire.`,
          )
        : ownGap && ownGap.gt(managerLimit) && own
          ? t(
            `More than ${pct(managerLimit.toString(), 0)} away from the rate already set for this day (${fmtQty(own)} FC): only the owner can save it. Check the figure, or ask the owner.`,
            `Plus de ${pct(managerLimit.toString(), 0)} d'écart avec le taux déjà saisi pour ce jour (${fmtQty(own)}\u00a0FC)\u00a0: seul le propriétaire peut l'enregistrer. Vérifiez le chiffre, ou demandez au propriétaire.`,
          )
          : null;
  const ownerOnlyCny = !isOwner && !ownerOnly && cnyTyped && cnyGap && cnyGap.gt(managerLimit) && refCny
    ? t(
        `More than ${pct(managerLimit.toString(), 0)} away from ${fmtQty(refCny)} ¥: only the owner can save it.`,
        `Plus de ${pct(managerLimit.toString(), 0)} d'écart avec ${fmtQty(refCny)}\u00a0¥\u00a0: seul le propriétaire peut l'enregistrer.`,
      )
    : null;
  // No yuan rate on file yet: only a rate a yuan cannot have (outside 4 to 12,5 ¥ for 1 $, as the server
  // checks a container's) is questioned.
  const cnyOdd = !refCny && !!cny && d(cny).gt(0) && (d(cny).lt(4) || d(cny).gt("12.5"));
  const cnyFar = (!!cnyGap && cnyGap.gt(tolerance)) || cnyOdd;
  // "28 500" for 2 850, or "2,85": every franc check at the till compares with this rate, so it cannot catch it.
  const farHint = (gap: Decimal, ref: string, sign: string): ReactNode => (
    <span className="font-medium text-amber-800 dark:text-amber-400">
      {t(
        `Far from the rate on file ($1 = ${fmtQty(ref)} ${sign}, ${gapText(gap)} apart): check it`,
        `Loin du taux enregistré (1\u00a0$ = ${fmtQty(ref)}\u00a0${sign}, ${gapText(gap)} d'écart)\u00a0: vérifiez-le`,
      )}
    </span>
  );
  const [confirming, setConfirming] = useState(false);
  // "Corriger" goes back to the rate asked about: the franc rate, else the yuan rate.
  const correct = useCorrectFocus(() => (cdfFar ? "rate-cdf" : "rate-cny"));
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
            <Field label={t("FC per $1", "FC pour 1\u00a0$")} required className="min-w-[7rem] flex-1" hint={ownerOnly ? <span className="font-medium text-amber-800 dark:text-amber-400">{ownerOnly}</span> : cdfFar && refCdf ? farHint(cdfGap!, refCdf, "FC") : undefined}>
              <Input inputMode="decimal" thousands rate data-correct="rate-cdf" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field
              // A short label, on one line like its neighbour, so both fields sit at the same height.
              label={t("¥ per $1", "¥ pour 1\u00a0$")}
              hint={ownerOnlyCny ? <span className="font-medium text-amber-800 dark:text-amber-400">{ownerOnlyCny}</span> : cnyFar && refCny ? farHint(cnyGap!, refCny, "¥") : cnyOdd ? <span className="font-medium text-amber-800 dark:text-amber-400">{t("A dollar buys about 7.1 ¥: check it", "Un dollar vaut environ 7,1\u00a0¥\u00a0: vérifiez-le")}</span> : lastCny ? t("Optional", "Facultatif") : t("Optional, about 7.1", "Facultatif, environ 7,1")}
              className="min-w-[7rem] flex-1"
            >
              <Input inputMode="decimal" rate data-correct="rate-cny" value={cny} onChange={(e) => setCny(e.target.value)} />
            </Field>
            <SubmitButton
              className="w-full sm:flex-col sm:items-stretch [&>button]:w-full"
              blocked={!day ? t("Choose a date", "Choisissez une date") : !d(value).gt(0) ? t("Enter a rate above zero", "Saisissez un taux supérieur à zéro") : cny && !d(cny).gt(0) ? t("The yuan rate must be above zero", "Le taux du yuan doit être supérieur à zéro") : ownerOnly || ownerOnlyCny ? t("Only the owner can save this rate", "Seul le propriétaire peut enregistrer ce taux") : null}
              pending={m.isPending}
              onClick={() => (cdfFar || cnyFar ? setConfirming(true) : save())}
            >
              {t("Set rate", "Enregistrer le taux")}
            </SubmitButton>
          </div>
        )}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent {...correct.content}>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Save this rate?", "Enregistrer ce taux\u00a0?")}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  {cdfFar && refCdf && (
                    <p>
                      {checkedApart
                        ? t(
                          `$1 = ${fmtQty(value)} FC is ${gapText(cdfGap!)} away from ${refName(refCdf)} and ${gapText(nearGap!)} from ${refName(checkedApart)}, the nearer.`,
                          `1\u00a0$ = ${fmtQty(value)}\u00a0FC s'écarte de ${gapText(cdfGap!)} ${refName(refCdf)} et de ${gapText(nearGap!)} ${refName(checkedApart)}, le plus proche.`,
                        )
                        : t(
                          `$1 = ${fmtQty(value)} FC is ${gapText(cdfGap!)} away from ${refName(refCdf)}.`,
                          `1\u00a0$ = ${fmtQty(value)}\u00a0FC s'écarte de ${gapText(cdfGap!)} ${refName(refCdf)}.`,
                        )}
                    </p>
                  )}
                  {cnyOdd && <p>{t(`$1 = ${fmtQty(cny)} ¥ is far from the usual rate (about 7.1 ¥).`, `1\u00a0$ = ${fmtQty(cny)}\u00a0¥ est loin du taux habituel (environ 7,1\u00a0¥).`)}</p>}
                  {cnyFar && refCny && (
                    <p>
                      {t(
                        `$1 = ${fmtQty(cny)} ¥ is ${gapText(cnyGap!)} away from the last yuan rate (${fmtQty(refCny)} ¥).`,
                        `1\u00a0$ = ${fmtQty(cny)}\u00a0¥ s'écarte de ${gapText(cnyGap!)} du dernier taux du yuan (${fmtQty(refCny)}\u00a0¥).`,
                      )}
                    </p>
                  )}
                  {/* Said of the rate in question: the yuan rate only restates what suppliers are owed in yuan. */}
                  {cdfFar && <p>{t("Every franc amount at the till and in the books is converted at this rate.", "Chaque montant en francs, à la caisse comme dans les comptes, est converti à ce taux.")}</p>}
                  {cnyFar && <p>{t("What suppliers are owed in yuan is restated at the yuan rate at month end.", "Ce qui est dû en yuans aux fournisseurs est réévalué au taux du yuan en fin de mois.")}</p>}
                  <p>{cdfFar && cnyFar ? t("Save them only if they are right.", "Enregistrez-les seulement s'ils sont justes.") : t("Save it only if it is right.", "Enregistrez-le seulement s'il est juste.")}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel {...correct.cancel}>{t("Correct it", "Corriger")}</AlertDialogCancel>
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
