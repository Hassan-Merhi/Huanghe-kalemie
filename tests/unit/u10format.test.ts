import { describe, expect, it } from "vitest";

describe("yuan amounts and refused amounts in a form field", async () => {
  const { parseNumberInput, ambiguousDollars, ambiguousReadings, unusableText, d, setFormatLang } = await import("../../client/src/lib/format");
  const { frNumber } = await import("../../shared/french");
  it("refuses a yuan price typed 6.500 as it refuses dollars, and reads its sign", () => {
    setFormatLang("fr");
    expect(parseNumberInput("6.500", { usd: true })).toBeNull();
    expect(parseNumberInput("6.500 ¥", { usd: true })).toBeNull();
    expect(ambiguousDollars("6,500 ¥")).toBe("6500");
    expect(parseNumberInput("6 500 ¥", { usd: true })).toBe("6500");
    expect(parseNumberInput("6,50 CNY", { usd: true })).toBe("6.50");
  });
  it("passes up 1,200 so that no page reads it as 1,20", () => {
    expect(unusableText("1,200")).toBe("1,200?");
    expect(d(unusableText("1,200")).toString()).toBe("0");
  });
  it("gives both readings of an ambiguous amount, and none for anything else", () => {
    expect(ambiguousReadings("1.200?")).toEqual(["1200", "1.2"]);
    expect(ambiguousReadings("1,200?")).toEqual(["1200", "1.2"]);
    expect(ambiguousReadings("−6.500?")).toEqual(["-6500", "-6.5"]);
    expect(ambiguousReadings("1200")).toBeNull();
    expect(ambiguousReadings("12a")).toBeNull();
    expect(ambiguousReadings("")).toBeNull();
  });
  it("writes server rates the French way", () => {
    expect(frNumber("0.01")).toBe("0,01");
    expect(frNumber("7.15")).toBe("7,15");
    expect(frNumber("5")).toBe("5");
  });
});
