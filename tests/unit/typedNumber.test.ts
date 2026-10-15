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

describe("numbers typed in a form field", async () => {
  const { parseNumberInput } = await import("../../client/src/lib/format");
  it("takes a sign typed with a plus, a hyphen or the true minus", () => {
    expect(parseNumberInput("+12")).toBe("12");
    expect(parseNumberInput("-12,5")).toBe("-12.5");
    expect(parseNumberInput("−12,5")).toBe("-12.5");
    expect(parseNumberInput("− 3")).toBe("-3");
    expect(parseNumberInput("+")).toBeNull();
    expect(parseNumberInput("12a")).toBeNull();
  });
  it("reads spreadsheet signs the same way", () => {
    expect(parseTypedNumber("−3,75")).toBe("-3.75");
    expect(parseTypedNumber("+3,75")).toBe("3.75");
  });
});
