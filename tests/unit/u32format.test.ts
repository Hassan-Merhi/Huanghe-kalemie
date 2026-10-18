import { describe, expect, it } from "vitest";

describe("twenty-seventh UI audit: a lone separator is not a number", async () => {
  const { d, parseNumberInput, typedNumberOk, unusableText } = await import("../../client/src/lib/format");

  it("refuses a lone comma, dot or sign rather than reading 0", () => {
    for (const s of [",", ".", "-", "-,", "+.", "−,", ",,", ".,", " , "]) {
      expect(parseNumberInput(s), s).toBeNull();
      expect(parseNumberInput(s, { usd: true }), s).toBeNull();
      expect(parseNumberInput(s, { thousands: true }), s).toBeNull();
      expect(parseNumberInput(s, { measured: true }), s).toBeNull();
    }
    // What the field passes up is refused by the page's checks, and is no amount.
    expect(typedNumberOk(unusableText(","))).toBe(false);
    expect(d(",").toString()).toBe("0");
  });

  it("still reads a number with its separator first or last", () => {
    expect(parseNumberInput(",5")).toBe("0.5");
    expect(parseNumberInput(".5")).toBe("0.5");
    expect(parseNumberInput("5,")).toBe("5");
    expect(parseNumberInput("-,5")).toBe("-0.5");
    expect(parseNumberInput("12,50", { usd: true })).toBe("12.50");
    expect(parseNumberInput("")).toBe("");
  });
});
