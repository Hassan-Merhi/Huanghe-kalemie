import { describe, expect, it } from "vitest";

describe("twenty-third UI audit: unit costs from 10 $ to the cent", async () => {
  const { setFormatLang, unitCost, variantUnitCost } = await import("../../client/src/lib/format");
  const NB = " ";

  it("rounds a motorcycle's unit cost to the cent and keeps a bolt's decimals", () => {
    setFormatLang("fr");
    expect(unitCost("1098.0495")).toBe(`1${NB}098,05${NB}$`);
    expect(unitCost("1056.4495")).toBe(`1${NB}056,45${NB}$`);
    expect(unitCost("909.090909")).toBe(`909,09${NB}$`);
    expect(unitCost("10.125")).toBe(`10,13${NB}$`);
    expect(unitCost("9.125")).toBe(`9,125${NB}$`);
    expect(unitCost("0.0049")).toBe(`0,0049${NB}$`);
    // The count form's figure, by the valuation's rule, rounds the same way: 3 motos worth 3 294,15 $.
    expect(variantUnitCost({ avgCost: "1098.050000", stockValue: "3294.15", stockQty: "3" })).toBe(`1${NB}098,05${NB}$`);
    expect(variantUnitCost({ avgCost: "1098.049500", stockValue: "4392.20", stockQty: "4" })).toBe(`1${NB}098,05${NB}$`);
  });
});
