import { afterEach, describe, expect, it } from "vitest";

describe("thirty-first UI audit: a unit typed that is not the field's own", async () => {
  const { unitMismatch, unitMismatchText, unitRefusedText, refusedUnit, percentOf, d, typedNumberOk, setFormatLang } = await import("../../client/src/lib/format");
  afterEach(() => setFormatLang("fr"));

  it("refuses francs or yuan in a dollar field, and dollars or yuan in a franc one", () => {
    expect(unitMismatch("61800 FC", "USD")).toBe("CDF");
    expect(unitMismatch("500 CDF", "USD")).toBe("CDF");
    expect(unitMismatch("40 ¥", "USD")).toBe("CNY");
    expect(unitMismatch("20 $", "CDF")).toBe("USD");
    expect(unitMismatch("20 RMB", "CDF")).toBe("CNY");
    expect(unitMismatch("500 FC", "CNY")).toBe("CDF");
    expect(unitMismatch("22 $", "USD")).toBeNull();
    expect(unitMismatch("50 000 FC", "CDF")).toBeNull();
    expect(unitMismatch("40 ¥", "CNY")).toBeNull();
    expect(unitMismatch("22", "USD")).toBeNull();
  });

  it("refuses % in amounts, quantities and rates, and a currency in a percentage", () => {
    expect(unitMismatch("10%", "USD")).toBe("pct");
    expect(unitMismatch("10 %", "CDF")).toBe("pct");
    expect(unitMismatch("3 %", "qty")).toBe("pct");
    expect(unitMismatch("5 $", "qty")).toBe("USD");
    expect(unitMismatch("3%", "rate")).toBe("pct");
    expect(unitMismatch("2 850 FC", "rate")).toBeNull();
    expect(unitMismatch("10 %", "pct")).toBeNull();
    expect(unitMismatch("10 $", "pct")).toBe("USD");
  });

  it("says that the field is in dollars, and where francs go", () => {
    expect(unitMismatchText("CDF", "USD", "Caisse FC")).toBe("Ce champ est en dollars : pour des francs, choisissez Caisse FC");
    expect(unitMismatchText("CDF", "CNY", "Caisse FC")).toBe("Ce champ est en yuans : pour des francs, choisissez Caisse FC");
    expect(unitMismatchText("USD", "CDF")).toBe("Ce champ est en francs : écrivez le montant en FC");
    expect(unitMismatchText("pct", "USD")).toBe("Pas de % ici : écrivez le montant en $");
    setFormatLang("en");
    expect(unitMismatchText("CDF", "USD", "Caisse FC")).toBe("This field is in dollars: for francs, choose Caisse FC");
  });

  it("passes up a refused text no page can read as an amount", () => {
    const sent = unitRefusedText("500 FC");
    expect(sent).toBe("500FC!");
    // Without the mark, d("500 FC") reads 500.
    expect(d("500 FC").toString()).toBe("500");
    expect(d(sent).toString()).toBe("0");
    expect(typedNumberOk(sent)).toBe(false);
    expect(refusedUnit(sent, "USD")).toBe("CDF");
    expect(refusedUnit("500", "USD")).toBeNull();
    expect(refusedUnit("1.200?", "USD")).toBeNull();
  });

  it("turns 10 % of a discount into that share of the line, to the cent", () => {
    expect(percentOf("10%", "22.00")).toBe("2.20");
    expect(percentOf("10 %", "1450")).toBe("145.00");
    expect(percentOf("12,5 %", "19.99")).toBe("2.50");
    expect(percentOf("10", "22")).toBeNull();
    expect(percentOf("10 $%", "22")).toBeNull();
    expect(percentOf("-10 %", "22")).toBeNull();
    expect(percentOf("%", "22")).toBeNull();
  });
});
