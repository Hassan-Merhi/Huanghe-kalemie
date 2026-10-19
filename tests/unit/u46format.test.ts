import { describe, expect, it } from "vitest";

describe("forty-first UI audit: amounts carried across a currency change, advances applied in English", async () => {
  const { convertTypedAmount, convertedNote, setFormatLang } = await import("../../client/src/lib/format");
  const { memoText } = await import("../../client/src/lib/systemText");
  const NB = " ";
  const fr = (_en: string, f: string) => f;
  const en = (e: string) => e;

  describe("convertTypedAmount", () => {
    it("converts at the rate given, francs whole and dollars to the cent", () => {
      // The audit's case: 6 000 $ from Caisse USD, then Caisse FC.
      expect(convertTypedAmount("6000", "USD", "CDF", "2808")).toBe("16848000");
      expect(convertTypedAmount("12.34", "USD", "CDF", "2808")).toBe("34651");
      expect(convertTypedAmount("16848000", "CDF", "USD", "2808")).toBe("6000.00");
      expect(convertTypedAmount("50000", "CDF", "USD", "2808")).toBe("17.81");
    });
    it("keeps the amount for the same currency or nothing typed, and gives null when it cannot convert", () => {
      expect(convertTypedAmount("6000", "USD", "USD", "2808")).toBe("6000");
      expect(convertTypedAmount("", "USD", "CDF", "2808")).toBe("");
      expect(convertTypedAmount("6000", null, "CDF", "2808")).toBe("6000");
      expect(convertTypedAmount("6000", "USD", "CDF", undefined)).toBeNull();
      expect(convertTypedAmount("1.200?", "USD", "CDF", "2808")).toBeNull();
      expect(convertTypedAmount("100", "USD", "CNY", "2808")).toBeNull();
    });
  });

  it("says the amounts were converted at the day's rate, or cleared", () => {
    setFormatLang("fr");
    expect(convertedNote(fr, "CDF", "2808", true)).toBe(`Montant converti au taux du jour (2${NB}808${NB}FC pour 1${NB}$)${NB}: vérifiez-le.`);
    expect(convertedNote(fr, "CDF", "2808", true, true)).toBe(`Montants convertis au taux du jour (2${NB}808${NB}FC pour 1${NB}$)${NB}: vérifiez-les.`);
    expect(convertedNote(fr, "CDF", undefined, false)).toBe(`Montant effacé${NB}: saisissez-le en FC.`);
    expect(convertedNote(en, "USD", undefined, false, true)).toBe("Amounts cleared: enter them in $.");
  });

  it("puts in English the advance the server applied on an offload or a franc bill", () => {
    expect(memoText("Avance imputée sur le conteneur HHU-2026-004", "en")).toBe("Advance applied to container HHU-2026-004");
    expect(memoText("Avance imputée sur les frais du conteneur HHU-2026-005", "en")).toBe("Advance applied to the costs of container HHU-2026-005");
    expect(memoText("Avance imputée sur la dépense Fret Kalemie", "en")).toBe("Advance applied to the expense Fret Kalemie");
    expect(memoText("Avance imputée", "en")).toBe("Advance applied");
    expect(memoText("Avance imputée sur le conteneur HHU-2026-004", "fr")).toBe("Avance imputée sur le conteneur HHU-2026-004");
  });
});
