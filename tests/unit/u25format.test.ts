import { describe, expect, it } from "vitest";

describe("twentieth UI audit: unit costs", async () => {
  const { setFormatLang, unitCost } = await import("../../client/src/lib/format");
  const NB = "\u00a0";

  it("shows cents, and up to four decimals when a cost under 10 $ is not whole cents (U28: cents from 10 $)", () => {
    setFormatLang("fr");
    expect(unitCost("4.125")).toBe(`4,125${NB}$`);
    expect(unitCost("0.125")).toBe(`0,125${NB}$`);
    expect(unitCost("0.1250")).toBe(`0,125${NB}$`);
    expect(unitCost("12")).toBe(`12,00${NB}$`);
    expect(unitCost("0.5")).toBe(`0,50${NB}$`);
    expect(unitCost("4.33333333")).toBe(`4,3333${NB}$`);
    expect(unitCost("1250.0625")).toBe(`1${NB}250,06${NB}$`);
  });
});
