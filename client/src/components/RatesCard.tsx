import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import { Field, Num, SubmitButton } from "@/components/common";
import { useRate } from "@/components/pickers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { cdf, d, date, money, qty as fmtQty, todayLocal } from "@/lib/format";
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
