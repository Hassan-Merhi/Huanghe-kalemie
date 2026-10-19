import { describe, expect, it } from "vitest";

describe("forty-second UI audit: container prices across a currency change, an advance applied as one row", async () => {
  const { convertedUnitPrice } = await import("../../shared/landedCost");
  const { mergeAdvanceRows } = await import("../../client/src/lib/statement");

  describe("convertedUnitPrice", () => {
    const fc = (1 / 2808).toFixed(12);
    it("keeps the value: 45 000 FC are 16,025641 $, 14 025 $ are 99 577,5 ¥", () => {
      expect(convertedUnitPrice("45000", fc, "USD", "1").toFixed()).toBe("16.025641");
      expect(convertedUnitPrice("14025", "1", "CNY", (1 / 7.1).toFixed(12)).toFixed()).toBe("99577.5");
    });
    it("keeps francs whole, unless a priced item would become free", () => {
      expect(convertedUnitPrice("16.025641", "1", "CDF", fc).toFixed()).toBe("45000");
      expect(convertedUnitPrice("0.0001", "1", "CDF", fc).toFixed()).toBe("0.2808");
      expect(convertedUnitPrice("0", "1", "CDF", fc).toFixed()).toBe("0");
    });
  });

  describe("mergeAdvanceRows", () => {
    const row = (o: Partial<Parameters<typeof mergeAdvanceRows>[0][number]>) => ({ journalId: 1, memo: null, debit: "0", credit: "0", currency: "USD", nativeAmount: null, balance: "0", ...o });
    it("shows the audit's J-000057 as one row moving nothing, with the yuan it settled", () => {
      const rows = [
        row({ journalId: 56, memo: "Déchargement du conteneur HHU-2026-003", credit: "10557.60", currency: "CNY", nativeAmount: "-75170.13", balance: "-9007.60" }),
        row({ journalId: 57, memo: "Avance imputée sur le conteneur HHU-2026-003", debit: "1550.00", currency: "CNY", nativeAmount: "11036.00", balance: "-7457.60" }),
        row({ journalId: 57, memo: "Avance imputée sur le conteneur HHU-2026-003", credit: "1550.00", balance: "-9007.60" }),
      ];
      const out = mergeAdvanceRows(rows);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe(rows[0]);
      expect(out[1]).toMatchObject({ journalId: 57, debit: "0", credit: "0", balance: "-9007.60", advanceUsd: "1550.00", advanceNative: [{ currency: "CNY", amount: "11036" }] });
    });
    it("keeps every other row: other journals, unequal lines, another memo", () => {
      const sale = [row({ journalId: 3, memo: "Vente", debit: "100" }), row({ journalId: 3, memo: "Vente", credit: "100" })];
      expect(mergeAdvanceRows(sale)).toEqual(sale);
      const part = [row({ journalId: 4, memo: "Avance imputée", debit: "100" }), row({ journalId: 4, memo: "Avance imputée", credit: "60" })];
      expect(mergeAdvanceRows(part)).toEqual(part);
      const apart = [row({ journalId: 5, memo: "Avance imputée", debit: "100" }), row({ journalId: 6, memo: "Avance imputée", credit: "100" })];
      expect(mergeAdvanceRows(apart)).toEqual(apart);
    });
  });
});
