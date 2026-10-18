import { describe, expect, it } from "vitest";
import { ambiguousTypedAmount, parseTypedAmount, parseTypedNumber, typedWholeCountDoubt } from "../../shared/money";

describe("twenty-fourth UI audit: spreadsheet numbers 1 000 times apart", async () => {
  const { amountCellUnsure, readNumberCell } = await import("../../client/src/lib/sheets");

  it("asks about a price or cost typed \"1,350\", \"1.350\" or \"4,125\" instead of reading it", () => {
    expect(ambiguousTypedAmount("1,650")).toEqual(["1650", "1.65"]);
    expect(ambiguousTypedAmount("1,350")).toEqual(["1350", "1.35"]);
    expect(ambiguousTypedAmount("1.350")).toEqual(["1350", "1.35"]);
    expect(ambiguousTypedAmount("4,125 $")).toEqual(["4125", "4.125"]);
    expect(ambiguousTypedAmount("1,000")).toEqual(["1000", "1"]);
    expect(ambiguousTypedAmount("−1,200")).toEqual(["-1200", "-1.2"]);
    expect(amountCellUnsure("1,650")).toEqual(["1650", "1.65"]);
    // Number cells and text that cannot be a thousands group read as before.
    for (const clear of [1350, 4.125, "4,13", "1 350", "0,125", "1 250,125", "1350", "12,50", "1.250,00", "1,415.51"]) {
      expect(ambiguousTypedAmount(clear), String(clear)).toBeNull();
    }
    expect(parseTypedAmount("4,13")).toBe("4.13");
    expect(parseTypedAmount("1 350")).toBe("1350");
    expect(parseTypedAmount("0,125")).toBe("0.125");
    expect(parseTypedAmount(1350)).toBe("1350");
  });

  it("asks about pieces typed \"12,000\" and refuses \"1,500\" pieces as 1,5", () => {
    expect(typedWholeCountDoubt("12,000")).toEqual({ unsure: ["12000", "12"] });
    expect(typedWholeCountDoubt("12.000")).toEqual({ unsure: ["12000", "12"] });
    expect(typedWholeCountDoubt("1,500")).toEqual({ split: "1.5", whole: "1500" });
    expect(typedWholeCountDoubt("2,250")).toEqual({ split: "2.25", whole: "2250" });
    for (const clear of [1500, "1.500", "1 500", "1500", "12", "12,5", "0,500"]) expect(typedWholeCountDoubt(clear), String(clear)).toBeNull();

    expect(readNumberCell("12,000", false)).toEqual({ value: "12000", unsure: ["12000", "12"] });
    expect(readNumberCell("1,500", false)).toEqual({ value: "1.5", unsure: null, split: ["1.5", "1500"] });
    expect(readNumberCell("1.500", false)).toEqual({ value: "1500", unsure: null });
    expect(readNumberCell(1500, false)).toEqual({ value: "1500", unsure: null });
    // In litres "1,500" is 1,5 as before, and the parser itself is unchanged.
    expect(readNumberCell("1,500", true)).toEqual({ value: "1.5", unsure: null });
    expect(parseTypedNumber("1,500")).toBe("1500");
  });
});
