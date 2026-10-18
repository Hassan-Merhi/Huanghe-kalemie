import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText, Loading, Num } from "@/components/common";
import { cdf, d, date, money, qty, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Settings } from "@/lib/types";
import { journalTypeLabel } from "@/pages/ContactDetail";
import { useSystemText } from "@/lib/systemText";

interface VoucherLine {
  id: number;
  accountId: number;
  accountName: string;
  accountCode: string;
  accountType: string;
  isMoney: boolean;
  systemKey?: string | null;
  partyName: string | null;
  debit: string;
  credit: string;
  currency: string;
  nativeAmount: string | null;
  rate: string | null;
  /** An expense line paid in francs: the francs typed on it (the line itself books only dollars). */
  docNativeAmount?: string;
  memo: string | null;
}

interface Voucher {
  id: number;
  number: string;
  date: string;
  type: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: number | null;
  createdByName: string | null;
  /** Set when someone else's pending voucher was validated: createdByName prepared it, this person validated it. */
  validatedByName?: string | null;
  createdAt?: string;
  total: string;
  /** The daybook's amount: francs at the voucher's rate, without the exchange difference. */
  amount?: string;
  fxDiff?: string | null;
  reversedByJournalId: number | null;
  reversesJournalId: number | null;
  lines: VoucherLine[];
}

type Paper = "A5" | "A4";

/** Memo of the exchange difference the server books when francs leave a box at its average cost. */
const COST_FX_MEMO = "Écart de change (coût moyen des devises)";
const isCostFx = (l: VoucherLine) => l.systemKey === "fx" && l.memo === COST_FX_MEMO;
/** A franc line at the voucher's own rate (1 400 000 FC at 2 808 = 498,58 $), as the daybook shows it. */
function docValue(l: VoucherLine, booked: string) {
  if (!d(booked).gt(0) || l.currency !== "CDF" || !l.nativeAmount || !d(l.rate).gt(0)) return d(booked);
  return d(l.nativeAmount).abs().dividedBy(d(l.rate)).toDecimalPlaces(2);
}

/**
 * The lines as printed. When francs left a box at its average cost, the francs read at the voucher's
 * rate and the exchange difference moves to a footnote, so the voucher matches the daybook; when
 * that would not balance, the lines print as booked.
 */
function printedLines(lines: VoucherLine[]) {
  const asBooked = { rows: lines.map((l) => ({ line: l, debit: d(l.debit), credit: d(l.credit) })), bookCost: null as null | { usd: string; diff: string } };
  const fx = lines.filter(isCostFx);
  if (!fx.length) return asBooked;
  const rows = lines.filter((l) => !isCostFx(l)).map((l) => ({ line: l, debit: docValue(l, l.debit), credit: docValue(l, l.credit) }));
  const dr = rows.reduce((s, r) => s.plus(r.debit), d(0));
  const cr = rows.reduce((s, r) => s.plus(r.credit), d(0));
  if (!dr.equals(cr)) return asBooked;
  const changed = rows.filter((r) => !r.debit.equals(d(r.line.debit)) || !r.credit.equals(d(r.line.credit)));
  const booked = changed.reduce((s, r) => s.plus(d(r.line.debit)).plus(d(r.line.credit)), d(0));
  const diff = fx.reduce((s, l) => s.plus(d(l.debit)).minus(d(l.credit)), d(0));
  return { rows, bookCost: { usd: booked.toFixed(2), diff: diff.toFixed(2) } };
}

const printCss = (paper: Paper) => `@media print {
  @page { size: ${paper}; margin: 10mm; }
  .print-area.voucher-print { position: static !important; width: 100% !important; max-width: none !important; margin: 0 !important; font-size: ${paper === "A5" ? "10px" : "12px"} !important; padding: 0 !important; border: 0 !important; box-shadow: none !important; }
  .print-area.voucher-print * { color: #000 !important; background: transparent !important; border-color: #888 !important; }
  .print-area.voucher-print table { width: 100%; border-collapse: collapse; }
  .print-area.voucher-print th, .print-area.voucher-print td { border-bottom: 1px solid #aaa; padding: 3px 4px; }
  .print-area .no-print { display: none !important; }
}`;

export default function VoucherPrint() {
  const t = useT();
  const sys = useSystemText();
  const { id } = useParams<{ id: string }>();
  const [paper, setPaper] = useState<Paper>("A5");
  const q = useQuery<Voucher>({ queryKey: [`/api/vouchers/${id}`] });
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] });
  const v = q.data;
  useEffect(() => {
    document.title = `${t("Voucher", "Pièce")} ${v?.number ?? ""} · Huanghe Kalemie`;
  }, [t, v?.number]);

  if (q.isLoading) return <Loading />;
  if (q.error || !v) return <ErrorText error={q.error ?? t("Voucher not found", "Pièce introuvable")} />;

  const hasCdf = v.lines.some((l) => l.nativeAmount && d(l.nativeAmount).abs().gt(0));
  const onlyCdf = v.lines.every((l) => !l.nativeAmount || d(l.nativeAmount).isZero() || l.currency === "CDF");
  const { rows, bookCost } = printedLines(v.lines);
  const totalDebit = rows.reduce((s, r) => s.plus(r.debit), d(0));
  const totalCredit = rows.reduce((s, r) => s.plus(r.credit), d(0));
  const title = journalTypeLabel(v.type, t);
  const amountUsd = v.amount ?? v.total;
  // Francs paid out or taken in: the amount in francs first, its dollar value at the voucher's rate beside it.
  // A franc refund prints what the customer received (61 700 FC, 21,97 $), not the goods' 22,00 $.
  const cashFc = v.lines.filter((l) => l.isMoney && l.currency === "CDF" && l.nativeAmount && !d(l.nativeAmount).isZero());
  const onlyFrancs = cashFc.length > 0 && cashFc.every((l) => d(l.nativeAmount).isNegative() === d(cashFc[0].nativeAmount).isNegative()) && v.lines.every((l) => !l.isMoney || cashFc.includes(l));
  const cashFcTotal = onlyFrancs ? cashFc.reduce((s, l) => s.plus(d(l.nativeAmount).abs()), d(0)) : null;
  const cashFcUsd = onlyFrancs ? cashFc.reduce((s, l) => s.plus(docValue(l, d(l.debit).gt(0) ? l.debit : l.credit)), d(0)).toFixed(2) : amountUsd;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <style>{printCss(paper)}</style>
      <div className="no-print flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" asChild>
          <Link href="/daybook"><ArrowLeft className="mr-1 h-4 w-4" /> {t("Day book", "Journal du jour")}</Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={paper} onValueChange={(x) => setPaper(x as Paper)}>
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="A5">A5</SelectItem>
              <SelectItem value="A4">A4</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => window.print()}><Printer className="mr-1 h-4 w-4" /> {t("Print", "Imprimer")}</Button>
        </div>
      </div>

      <Card className="print-area voucher-print">
        <CardContent className="space-y-5 p-4 sm:p-6">
          {v.reversedByJournalId && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong className="uppercase">{t("Cancelled", "Annulée")}</strong>{" — "}
                {t("this voucher was reversed by ", "cette pièce a été annulée par ")}
                <Link href={`/vouchers/${v.reversedByJournalId}`} className="underline">{t("this entry", "cette écriture")}</Link>.
              </span>
            </div>
          )}

          <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-lg font-semibold">{settings.data?.shopName ?? "Huanghe Kalemie"}</p>
              <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm sm:text-right">
              <dt className="text-muted-foreground">{t("No.", "N°")}</dt>
              <dd className="font-mono font-medium">{v.number}</dd>
              <dt className="text-muted-foreground">{t("Date", "Date")}</dt>
              <dd>{date(v.date)}</dd>
              {v.reversesJournalId && (
                <>
                  <dt className="text-muted-foreground">{t("Reverses", "Annule")}</dt>
                  <dd><Link href={`/vouchers/${v.reversesJournalId}`} className="underline">{t("original voucher", "pièce d'origine")}</Link></dd>
                </>
              )}
            </dl>
          </header>

          {v.memo && (
            <p className="text-sm">
              <span className="text-muted-foreground">{t("Description: ", "Libellé\u00a0: ")}</span>
              <span className="font-medium">{sys.memo(v.memo)}</span>
            </p>
          )}

          <div className="overflow-x-auto">
            <Table className="text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">{t("Account", "Compte")}</th>
                  <th className="py-2 pr-2 font-medium">{t("Contact", "Contact")}</th>
                  <th className="py-2 pr-2 font-medium">{t("Note", "Note")}</th>
                  {hasCdf && <th className="py-2 pr-2 text-right font-medium">{onlyCdf ? "CDF" : t("Currency", "Devise")}</th>}
                  <th className="py-2 pr-2 text-right font-medium">{t("Debit", "Débit")}</th>
                  <th className="py-2 text-right font-medium">{t("Credit", "Crédit")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ line: l, debit, credit }) => (
                  <tr key={l.id} className="border-b align-top">
                    <td className="py-2 pr-2"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {sys.account(l.accountName)}</td>
                    <td className="py-2 pr-2">{l.partyName ?? ""}</td>
                    <td className="py-2 pr-2 text-muted-foreground">{l.memo && l.memo !== l.partyName ? sys.memo(l.memo) : ""}</td>
                    {hasCdf && (
                      <td className="py-2 pr-2 text-right">
                        {l.nativeAmount && d(l.nativeAmount).abs().gt(0) ? (
                          <Num>
                            {l.currency === "CDF" ? cdf(d(l.nativeAmount).abs().toString()) : money(d(l.nativeAmount).abs().toString(), l.currency)}
                            {l.rate && <span className="block text-xs text-muted-foreground">{t("rate", "taux")} {qty(d(l.rate).toDecimalPlaces(2).toString())}{"\u00a0"}{l.currency === "CDF" ? "FC" : l.currency}/$</span>}
                          </Num>
                        ) : l.docNativeAmount ? (
                          <Num>{cdf(l.docNativeAmount)}</Num>
                        ) : ""}
                      </td>
                    )}
                    <td className="py-2 pr-2 text-right"><Num>{debit.gt(0) ? usd(debit.toFixed(2)) : ""}</Num></td>
                    <td className="py-2 text-right"><Num>{credit.gt(0) ? usd(credit.toFixed(2)) : ""}</Num></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="pt-2" colSpan={hasCdf ? 4 : 3}>{t("Total", "Total")}</td>
                  <td className="pr-2 pt-2 text-right"><Num>{usd(totalDebit.toFixed(2))}</Num></td>
                  <td className="pt-2 text-right"><Num>{usd(totalCredit.toFixed(2))}</Num></td>
                </tr>
              </tfoot>
            </Table>
          </div>

          {bookCost && (
            <p className="text-xs text-muted-foreground">
              {d(bookCost.diff).gt(0)
                ? t(
                    `In the books these francs leave at their average cost of ${usd(bookCost.usd)}: the ${usd(bookCost.diff)} difference is an exchange loss (Exchange differences).`,
                    `Dans les comptes, ces francs sortent à leur coût moyen de ${usd(bookCost.usd)}\u00a0: l'écart de ${usd(bookCost.diff)} est une perte de change (Écarts de change).`,
                  )
                : t(
                    `In the books these francs count at their average cost of ${usd(bookCost.usd)}: the ${usd(d(bookCost.diff).abs().toFixed(2))} difference is an exchange gain (Exchange differences).`,
                    `Dans les comptes, ces francs comptent à leur coût moyen de ${usd(bookCost.usd)}\u00a0: l'écart de ${usd(d(bookCost.diff).abs().toFixed(2))} est un gain de change (Écarts de change).`,
                  )}
            </p>
          )}

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">{t("Amount: ", "Montant\u00a0: ")}</span>
              {cashFcTotal ? (
                <>
                  <span className="text-base font-semibold">{cdf(cashFcTotal.toString())}</span>{" "}
                  <span className="text-muted-foreground">({usd(cashFcUsd)})</span>
                </>
              ) : (
                <span className="text-base font-semibold">{usd(amountUsd)}</span>
              )}
            </p>
            <p>
              <span className="text-muted-foreground">{t("Created by: ", "Saisi par\u00a0: ")}</span>
              <span>{v.createdByName ?? "—"}</span>
            </p>
            {v.validatedByName && (
              <p>
                <span className="text-muted-foreground">{t("Validated by: ", "Validé par : ")}</span>
                <span>{v.validatedByName}</span>
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 pt-4">
            {/* A validated pending voucher names who prepared and who approved it; the signatures stay blank. */}
            {[
              { label: t("Prepared by", "Préparé par"), name: v.validatedByName ? v.createdByName : null },
              { label: t("Approved by", "Approuvé par"), name: v.validatedByName ?? null },
              { label: t("Received by", "Reçu par"), name: null },
            ].map(({ label, name }) => (
              <div key={label} className="flex h-24 flex-col justify-between rounded-md border p-2 text-xs">
                <span className="text-muted-foreground">
                  {label}
                  {name && <span className="block font-medium text-foreground">{name}</span>}
                </span>
                <span className="border-t pt-1 text-muted-foreground">{t("Name & signature", "Nom et signature")}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
