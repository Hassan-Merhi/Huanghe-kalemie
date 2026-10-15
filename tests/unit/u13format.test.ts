import { describe, expect, it } from "vitest";

describe("eighth UI audit: \"1.000\" litres asked about, franc rates grouped", async () => {
  const { ambiguousMeasure, parseNumberInput, unusableText, unclearQty, setFormatLang } = await import("../../client/src/lib/format");
  const fr = (_en: string, f: string) => f;

  it("asks about digits followed by \".000\" in litres, and nothing else", () => {
    expect(ambiguousMeasure("1.000")).toBe("1000");
    expect(ambiguousMeasure("12.000")).toBe("12000");
    expect(ambiguousMeasure("250.000")).toBe("250000");
    expect(ambiguousMeasure("-5.000")).toBe("-5000");
    for (const kept of ["1,5", "2.5", "12.75", "1.250", "1,000", "1.0", "1.00", "1000", "0.000", "1234.000", "1.000.000"]) {
      expect(ambiguousMeasure(kept), kept).toBeNull();
    }
    // What a litre field sends up for "1.000": a question no page reads as 1 L.
    expect(parseNumberInput("1.000", { measured: true })).toBeNull();
    expect(unusableText("1.000")).toBe("1.000?");
    setFormatLang("fr");
    expect(unclearQty(fr, "1.000?")).toBe("Précisez la quantité : 1 000 ou 1");
    // The decimals the shop types stay decimals, "1.250" still 1,25 as before.
    expect(parseNumberInput("1.250", { measured: true })).toBe("1.250");
    expect(parseNumberInput("2.5", { measured: true })).toBe("2.5");
    expect(parseNumberInput("1,5", { measured: true })).toBe("1.5");
    expect(parseNumberInput("12.75", { measured: true })).toBe("12.75");
    // Without it (a price, a weight), "1.000" is 1 as before.
    expect(parseNumberInput("1.000", {})).toBe("1.000");
  });

  it("reads a franc rate typed \"2.808\" as 2 808, as the till does", () => {
    expect(parseNumberInput("2.808", { thousands: true })).toBe("2808");
    expect(parseNumberInput("2,808", { thousands: true })).toBe("2808");
    expect(parseNumberInput("2808,5", { thousands: true })).toBe("2808.5");
  });
});
