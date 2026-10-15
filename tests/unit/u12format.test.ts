import { describe, expect, it } from "vitest";

describe("seventh UI audit: whole quantities asked about, account names in English", async () => {
  const { parseNumberInput, unusableText, typedNumberOk, setFormatLang } = await import("../../client/src/lib/format");
  const { unclearQty } = await import("../../client/src/lib/format");
  const { accountText } = await import("../../client/src/lib/systemText");
  const fr = (_en: string, f: string) => f;

  it("reads \"1.000\" in a whole-unit field as a question, and \"1.5\" litres as a decimal", () => {
    // What a whole-unit field sends up: "1.000?", which no page can read as 1.
    expect(parseNumberInput("1.000", { usd: true })).toBeNull();
    expect(unusableText("1.000")).toBe("1.000?");
    expect(typedNumberOk("1.000?")).toBe(false);
    setFormatLang("fr");
    expect(unclearQty(fr, "1.000?")).toMatch(/^Précisez la quantité : 1\s000 ou 1$/);
    expect(unclearQty(fr, "12")).toBeNull();
    expect(parseNumberInput("1.5", {})).toBe("1.5");
  });

  it("names the default accounts in English and leaves typed names alone", () => {
    expect(accountText("Caisse FC", "en")).toBe("Cash FC");
    expect(accountText("Coût des articles vendus", "en")).toBe("Cost of goods sold");
    expect(accountText("Caisse FC", "fr")).toBe("Caisse FC");
    expect(accountText("Caisse de Mama Wivine", "en")).toBe("Caisse de Mama Wivine");
  });
});
