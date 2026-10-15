import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText, Loading, Num } from "@/components/common";
import { cdf, d, date, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Settings } from "@/lib/types";
import { journalTypeLabel } from "@/pages/ContactDetail";

interface VoucherLine {
  id: number;
  accountId: number;
  accountName: string;
  accountCode: string;
  accountType: string;
  isMoney: boolean;
  partyName: string | null;
  debit: string;
  credit: string;
  currency: string;
  nativeAmount: string | null;
  rate: string | null;
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
  createdAt?: string;
  total: string;
  reversedByJournalId: number | null;
  reversesJournalId: number | null;
  lines: VoucherLine[];
}

type Paper = "A5" | "A4";

const printCss = (paper: Paper) => `@media print {
  @page { size: ${paper}; margin: 10mm; }
  .print-area.voucher-print { position: absolute; left: 0; top: 0; width: 100% !important; font-size: ${paper === "A5" ? "10px" : "12px"} !important; padding: 0 !important; border: 0 !important; box-shadow: none !important; }
  .print-area.voucher-print * { color: #000 !important; background: transparent !important; border-color: #888 !important; }
  .print-area.voucher-print table { width: 100%; border-collapse: collapse; }
  .print-area.voucher-print th, .print-area.voucher-print td { border-bottom: 1px solid #aaa; padding: 3px 4px; }
  .print-area .no-print { display: none !important; }
}`;

export default function VoucherPrint() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [paper, setPaper] = useState<Paper>("A5");
  const q = useQuery<Voucher>({ queryKey: [`/api/vouchers/${id}`] });
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] });
  const v = q.data;

  if (q.isLoading) return <Loading />;
  if (q.error || !v) return <ErrorText error={q.error ?? t("Voucher not found", "Pièce introuvable")} />;

  const hasCdf = v.lines.some((l) => l.nativeAmount && d(l.nativeAmount).abs().gt(0));
  const totalDebit = v.lines.reduce((s, l) => s.plus(d(l.debit)), d(0));
  const totalCredit = v.lines.reduce((s, l) => s.plus(d(l.credit)), d(0));
  const title = journalTypeLabel(v.type, t);

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
              <span className="text-muted-foreground">{t("Description", "Libellé")}: </span>
              <span className="font-medium">{v.memo}</span>
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">{t("Account", "Compte")}</th>
                  <th className="py-2 pr-2 font-medium">{t("Contact", "Contact")}</th>
                  <th className="py-2 pr-2 font-medium">{t("Note", "Note")}</th>
                  {hasCdf && <th className="py-2 pr-2 text-right font-medium">CDF</th>}
                  <th className="py-2 pr-2 text-right font-medium">{t("Debit", "Débit")}</th>
                  <th className="py-2 text-right font-medium">{t("Credit", "Crédit")}</th>
                </tr>
              </thead>
              <tbody>
                {v.lines.map((l) => (
                  <tr key={l.id} className="border-b align-top">
                    <td className="py-2 pr-2"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {l.accountName}</td>
                    <td className="py-2 pr-2">{l.partyName ?? ""}</td>
                    <td className="py-2 pr-2 text-muted-foreground">{l.memo ?? ""}</td>
                    {hasCdf && (
                      <td className="py-2 pr-2 text-right">
                        {l.nativeAmount && d(l.nativeAmount).abs().gt(0) ? (
                          <Num>
                            {cdf(d(l.nativeAmount).abs().toString())}
                            {l.rate && <span className="block text-xs text-muted-foreground">@ {d(l.rate).toDecimalPlaces(2).toString()}</span>}
                          </Num>
                        ) : ""}
                      </td>
                    )}
                    <td className="py-2 pr-2 text-right"><Num>{d(l.debit).gt(0) ? usd(l.debit) : ""}</Num></td>
                    <td className="py-2 text-right"><Num>{d(l.credit).gt(0) ? usd(l.credit) : ""}</Num></td>
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
            </table>
          </div>

          <p className="text-sm">
            <span className="text-muted-foreground">{t("Amount", "Montant")}: </span>
            <span className="text-base font-semibold">{usd(v.total)}</span>
            <span className="ml-4 text-muted-foreground">{t("Created by", "Saisi par")}: </span>
            <span>{v.createdByName ?? "—"}</span>
          </p>

          <div className="grid grid-cols-3 gap-3 pt-4">
            {[t("Prepared by", "Préparé par"), t("Approved by", "Approuvé par"), t("Received by", "Reçu par")].map((label) => (
              <div key={label} className="flex h-24 flex-col justify-between rounded-md border p-2 text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="border-t pt-1 text-muted-foreground">{t("Name & signature", "Nom et signature")}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
