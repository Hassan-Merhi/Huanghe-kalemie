import { describe, expect, it } from "vitest";

describe("dollar amounts typed in a form field", async () => {
  const { parseNumberInput, ambiguousDollars, unusableText, typedNumberOk, d, num, setFormatLang } = await import("../../client/src/lib/format");
  it("refuses a single dot or comma before three digits, which may be thousands or cents", () => {
    setFormatLang("fr");
    expect(parseNumberInput("1.200", { usd: true })).toBeNull();
    expect(parseNumberInput("1,200", { usd: true })).toBeNull();
    expect(parseNumberInput("1.400 $", { usd: true })).toBeNull();
    expect(parseNumberInput("−12.500", { usd: true })).toBeNull();
    expect(ambiguousDollars("1.200")).toBe("1200");
    expect(ambiguousDollars("−12,500")).toBe("-12500");
    expect(ambiguousDollars("+999.000")).toBe("999000");
  });
  it("keeps what is not ambiguous", () => {
    setFormatLang("fr");
    expect(parseNumberInput("12.50", { usd: true })).toBe("12.50");
    expect(parseNumberInput("1.5", { usd: true })).toBe("1.5");
    expect(parseNumberInput("0.500", { usd: true })).toBe("0.500");
    expect(parseNumberInput("1200", { usd: true })).toBe("1200");
    expect(parseNumberInput("1 200", { usd: true })).toBe("1200");
    expect(parseNumberInput("1.200,00", { usd: true })).toBe("1200.00");
    expect(parseNumberInput("1,200.50", { usd: true })).toBe("1200.50");
    expect(parseNumberInput("1.234.567", { usd: true })).toBe("1234567");
    expect(ambiguousDollars("12.50")).toBeNull();
    expect(ambiguousDollars("1234.567")).toBeNull();
  });
  it("leaves quantities and francs as they were", () => {
    expect(parseNumberInput("1.234")).toBe("1.234");
    expect(parseNumberInput("1.200", { thousands: true })).toBe("1200");
  });
  it("reads an English comma as thousands even in a dollar field", () => {
    setFormatLang("en");
    expect(parseNumberInput("1,200", { usd: true })).toBe("1200");
    expect(parseNumberInput("1.200", { usd: true })).toBeNull();
    setFormatLang("fr");
  });
  it("passes up unusable text that no page reads as an amount", () => {
    expect(unusableText("1.200")).toBe("1.200?");
    expect(unusableText("12a")).toBe("12a");
    expect(typedNumberOk("1.200?")).toBe(false);
    expect(typedNumberOk("12a")).toBe(false);
    expect(typedNumberOk("")).toBe(true);
    expect(typedNumberOk("1200")).toBe(true);
    expect(d("1.200?").toString()).toBe("0");
    expect(d("1,200?").toString()).toBe("0");
    expect(num("1.200?")).toBe(0);
  });
});
