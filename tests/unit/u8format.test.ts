import { describe, expect, it } from "vitest";
import { frDate, frMoney, frNumber, frenchSpacing } from "../../shared/french";

const NB = " ";

describe("franc amounts and rates typed in a form field", async () => {
  const { parseNumberInput, usd, cdf, setFormatLang } = await import("../../client/src/lib/format");
  it("reads a single dot or comma before three digits as thousands in a franc field", () => {
    expect(parseNumberInput("50.000", { thousands: true })).toBe("50000");
    expect(parseNumberInput("2.850", { thousands: true })).toBe("2850");
    expect(parseNumberInput("2,850", { thousands: true })).toBe("2850");
    expect(parseNumberInput("1.250.000", { thousands: true })).toBe("1250000");
    expect(parseNumberInput("45 000,5", { thousands: true })).toBe("45000.5");
    expect(parseNumberInput("2850", { thousands: true })).toBe("2850");
  });
  it("keeps dollars, litres and quantities as they were", () => {
    expect(parseNumberInput("12.50")).toBe("12.50");
    expect(parseNumberInput("12,50")).toBe("12.50");
    expect(parseNumberInput("1.5")).toBe("1.5");
    expect(parseNumberInput("1.234")).toBe("1.234");
    expect(parseNumberInput("12.50", { thousands: true })).toBe("12.50");
  });
  it("writes negatives with the true minus sign and no space", () => {
    setFormatLang("fr");
    expect(usd("-7.8")).toBe(`−7,80${NB}$`);
    expect(cdf("-2500")).toBe(`−2${NB}500${NB}FC`);
  });
});

describe("French server messages", () => {
  it("formats amounts, numbers and dates", () => {
    expect(frMoney("1800")).toBe(`1${NB}800,00${NB}$`);
    expect(frMoney("45000", "CDF")).toBe(`45${NB}000${NB}FC`);
    expect(frMoney("50550", "CNY")).toBe(`50${NB}550,00${NB}¥`);
    expect(frNumber("45000.5")).toBe(`45${NB}000,5`);
    expect(frNumber("3.000")).toBe("3");
    expect(frDate("2026-10-15")).toBe("15/10/2026");
  });
  it("puts a no-break space before : ; ! ? and %", () => {
    expect(frenchSpacing("Solde insuffisant sur Banque : il manque 20 % ; vraiment ?")).toBe(`Solde insuffisant sur Banque${NB}: il manque 20${NB}%${NB}; vraiment${NB}?`);
    expect(frenchSpacing("Ligne 3 : erreur")).toBe(`Ligne 3${NB}: erreur`);
    expect(frenchSpacing("à 10:30, voir http://x.fr?a=1")).toBe("à 10:30, voir http://x.fr?a=1");
  });
});
