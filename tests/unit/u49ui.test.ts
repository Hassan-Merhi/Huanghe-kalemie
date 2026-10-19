import { describe, expect, it } from "vitest";

describe("forty-fourth UI audit: a stored price shown back in a dollar or yuan field", async () => {
  const { ambiguousDollars, exactMoney, inputText, parseNumberInput, setFormatLang } = await import("../../client/src/lib/format");

  it("shows a stored 4.125 as \"4,1250\" in a strict field, never as text the field questions", () => {
    setFormatLang("fr");
    expect(inputText("4.125", { strict: true })).toBe("4,1250");
    expect(inputText("-4.125", { strict: true })).toBe("-4,1250");
    expect(inputText("999.125", { strict: true })).toBe("999,1250");
    // Not in doubt: kept as before.
    expect(inputText("4.125")).toBe("4,125");
    expect(inputText("0.125", { strict: true })).toBe("0,125");
    expect(inputText("1234.125", { strict: true })).toBe("1 234,125");
    expect(inputText("4.5", { strict: true })).toBe("4,5");
    expect(inputText("4.000", { strict: true })).toBe("4");
    expect(inputText("4.125000", { strict: true })).toBe("4,125000");
    setFormatLang("en");
    expect(inputText("4.125", { strict: true })).toBe("4.1250");
    setFormatLang("fr");
  });

  it("reads the text it shows back as the stored value, with no question", () => {
    for (const lang of ["fr", "en"] as const) {
      setFormatLang(lang);
      for (const v of ["4.125", "-4.125", "12.5", "0.125", "999.999", "1234.125", "7"]) {
        const shown = inputText(v, { strict: true });
        expect(ambiguousDollars(shown), shown).toBeNull();
        expect(Number(parseNumberInput(shown, { usd: true })), shown).toBe(Number(v));
      }
    }
    setFormatLang("fr");
  });

  it("gives the decimal reading of a question exactly: 4,125 ¥, not 4,13 ¥", () => {
    setFormatLang("fr");
    expect(exactMoney("4.125", "CNY")).toBe("4,125 ¥");
    expect(exactMoney("4.125")).toBe("4,125 $");
    expect(exactMoney("1.2")).toBe("1,20 $");
    expect(exactMoney("-4.125", "CNY")).toBe("−4,125 ¥");
    setFormatLang("en");
    expect(exactMoney("4.125")).toBe("$4.125");
    setFormatLang("fr");
  });
});

describe("forty-fourth UI audit: a rate in English", async () => {
  const { dollarRate, setFormatLang } = await import("../../client/src/lib/format");
  it("writes $1 = 2,820 FC in English and 1 $ = 2 820 FC in French", () => {
    setFormatLang("en");
    expect(dollarRate("2820")).toBe("$1 = 2,820 FC");
    expect(dollarRate("7.15", "¥")).toBe("$1 = 7.15 ¥");
    setFormatLang("fr");
    expect(dollarRate("2820")).toBe("1 $ = 2 820 FC");
  });
});
