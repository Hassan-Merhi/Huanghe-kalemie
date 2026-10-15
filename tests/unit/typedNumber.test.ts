import { describe, expect, it } from "vitest";
import { parseTypedNumber } from "../../shared/money";

describe("numbers typed in a spreadsheet", () => {
  it("reads French and English styles", () => {
    expect(parseTypedNumber("1 415,51")).toBe("1415.51");
    expect(parseTypedNumber("1 415,51 $")).toBe("1415.51");
    expect(parseTypedNumber("1,415.51")).toBe("1415.51");
    expect(parseTypedNumber("12,5")).toBe("12.5");
    expect(parseTypedNumber("2.800 FC")).toBe("2800");
    expect(parseTypedNumber("1,250")).toBe("1250");
    expect(parseTypedNumber("-3,75")).toBe("-3.75");
    expect(parseTypedNumber(" ")).toBeNull();
    expect(parseTypedNumber(12.5)).toBe("12.5");
  });
});
