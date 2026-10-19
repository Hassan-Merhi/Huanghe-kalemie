import { describe, expect, it } from "vitest";

describe("forty-third UI audit: a price in doubt in a CSV, where no cell is a number", async () => {
  const { csvAmountText } = await import("../../client/src/lib/sheets");
  const { ambiguousTypedAmount, parseTypedAmount } = await import("../../shared/money");

  it("writes the decimal reading so it can no longer read as thousands: \"14\", \"1,35\", \"4,1250\"", () => {
    // The audit's "14.000" FC: 14 000 or 14, and for 14 the file says 14.
    expect(ambiguousTypedAmount("14.000")).toEqual(["14000", "14"]);
    expect(csvAmountText("14", true)).toBe("14");
    expect(csvAmountText("1.35", true)).toBe("1,35");
    expect(csvAmountText("4.125", true)).toBe("4,1250");
    expect(csvAmountText("4.125", false)).toBe("4.1250");
    expect(csvAmountText("-4.125", true)).toBe("-4,1250");
  });

  it("gives text the import reads as that value, never asked about again", () => {
    for (const [value, read] of [["14", "14"], ["1.35", "1.35"], ["4.125", "4.125"], ["-4.125", "-4.125"]]) {
      for (const fr of [true, false]) {
        const text = csvAmountText(value, fr);
        expect(ambiguousTypedAmount(text), text).toBeNull();
        expect(Number(parseTypedAmount(text)), text).toBe(Number(read));
      }
    }
  });
});
