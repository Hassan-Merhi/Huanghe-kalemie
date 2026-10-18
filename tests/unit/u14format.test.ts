import { describe, expect, it } from "vitest";
import { ambiguousTypedMeasure, parseTypedNumber } from "../../shared/money";

describe("ninth UI audit: packing-list measures, Kalemie dates, margins", async () => {
  const { pct, date, shopDay, setFormatLang } = await import("../../client/src/lib/format");
  const { readNumberCell } = await import("../../client/src/lib/sheets");

  it("reads a measure's three decimals as decimals, as a form field does", () => {
    expect(parseTypedNumber("2,250", { measured: true })).toBe("2.25");
    expect(parseTypedNumber("12,375", { measured: true })).toBe("12.375");
    expect(parseTypedNumber("0,856", { measured: true })).toBe("0.856");
    expect(parseTypedNumber("1.250", { measured: true })).toBe("1.25");
    expect(parseTypedNumber("1 234,567", { measured: true })).toBe("1234.567");
    expect(parseTypedNumber("1.234,5", { measured: true })).toBe("1234.5");
    expect(parseTypedNumber("1,234.567", { measured: true })).toBe("1234.567");
    // The same mark repeated still groups thousands.
    expect(parseTypedNumber("1.234.567", { measured: true })).toBe("1234567");
    expect(parseTypedNumber("12,50", { measured: true })).toBe("12.5");
    expect(parseTypedNumber("3,0", { measured: true })).toBe("3");
    expect(parseTypedNumber("-0,125", { measured: true })).toBe("-0.125");
    // What the browser sends comes back the same when the server reads it again.
    for (const plain of ["2.25", "12.375", "0.856", "2250", "1"]) expect(parseTypedNumber(plain, { measured: true }), plain).toBe(plain);
  });

  it("keeps pieces and money as they were", () => {
    expect(parseTypedNumber("2,250")).toBe("2250");
    expect(parseTypedNumber("1.000")).toBe("1000");
    expect(parseTypedNumber("2.800 FC")).toBe("2800");
    expect(parseTypedNumber("12,5")).toBe("12.5");
  });

  it("asks about \"1.000\" in a measure, and nothing else", () => {
    expect(ambiguousTypedMeasure("1.000")).toEqual(["1000", "1"]);
    expect(ambiguousTypedMeasure("250.000")).toEqual(["250000", "250"]);
    for (const kept of ["1,000", "1.250", "1000", "0.000", "1.000.000", "12,375"]) expect(ambiguousTypedMeasure(kept), kept).toBeNull();
    expect(ambiguousTypedMeasure(1000)).toBeNull();
  });

  it("reads a sheet cell for its unit", () => {
    expect(readNumberCell("2,250", true)).toEqual({ value: "2.25", unsure: null });
    // U29: "2,250" pieces is 2,25 in a French sheet, which no piece can be: asked, not read as 2 250.
    expect(readNumberCell("2,250", false)).toEqual({ value: "2.25", unsure: null, split: ["2.25", "2250"] });
    expect(readNumberCell("2 250", false)).toEqual({ value: "2250", unsure: null });
    expect(readNumberCell("1.000", true)).toEqual({ value: "1", unsure: ["1000", "1"] });
    expect(readNumberCell(12.375, true)).toEqual({ value: "12.375", unsure: null });
    expect(readNumberCell(undefined, true)).toEqual({ value: null, unsure: null });
  });

  it("shows a timestamp on its Kalemie day", () => {
    // 00:29 in Kalemie on the 15th is 22:29 UTC on the 14th.
    expect(shopDay("2026-10-14T22:29:00.000Z")).toBe("2026-10-15");
    expect(date("2026-10-14T22:29:00.000Z")).toBe("15/10/2026");
    expect(date("2026-10-14T21:59:00+00:00")).toBe("14/10/2026");
    expect(date("2026-10-14")).toBe("14/10/2026");
  });

  it("writes every margin with one decimal", () => {
    setFormatLang("fr");
    expect(pct(43, 1, 1)).toBe("43,0 %");
    expect(pct(38.6, 1, 1)).toBe("38,6 %");
    expect(pct(43)).toBe("43 %");
  });
});
