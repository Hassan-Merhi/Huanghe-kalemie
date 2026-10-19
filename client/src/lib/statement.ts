import Decimal from "decimal.js";

/** The fields of a statement row the merge reads (ContactDetail's StatementRow has more). */
export interface StatementLine {
  journalId: number;
  memo: string | null;
  debit: string;
  credit: string;
  currency: string;
  nativeAmount: string | null;
  balance: string;
}

/** A row standing for an advance applied: the dollars it moved, and the yuan or francs it settled. */
export type MergedStatementRow<R extends StatementLine> = R & { advanceUsd?: string; advanceNative?: { currency: string; amount: string }[] };

/**
 * An advance applied (J-000057 "Avance imputée sur le conteneur HHU-2026-003") is booked as two lines on the
 * contact: the yuan (or francs) settled, and the dollars of the advance used. Shown as two rows, the running
 * balance reads 9 007,60 → 7 457,60 → 9 007,60, as if 1 550 $ more had been paid. Shown as one row instead, with
 * no debit or credit and the balance after it: the advance moved no money. Display only; only such a journal's
 * pair of equal and opposite lines is merged, every other row is kept as it is.
 */
export function mergeAdvanceRows<R extends StatementLine>(rows: R[]): MergedStatementRow<R>[] {
  const out: MergedStatementRow<R>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    const applied = (r: R) => (r.memo ?? "").startsWith("Avance imputée");
    if (b && a.journalId === b.journalId && applied(a) && applied(b)) {
      const move = (r: R) => new Decimal(r.debit || 0).minus(r.credit || 0);
      if (!move(a).isZero() && move(a).plus(move(b)).isZero()) {
        const native = [a, b]
          .filter((r) => r.currency !== "USD" && r.nativeAmount && !new Decimal(r.nativeAmount).isZero())
          .map((r) => ({ currency: r.currency, amount: new Decimal(r.nativeAmount!).abs().toString() }));
        out.push({ ...b, debit: "0", credit: "0", currency: "USD", nativeAmount: null, advanceUsd: move(a).abs().toFixed(2), advanceNative: native });
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}
