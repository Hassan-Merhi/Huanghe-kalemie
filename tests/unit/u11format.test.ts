import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

describe("sixth UI audit: container rate, payment split, system texts", async () => {
  const { perUsdText, usdPerUnit } = await import("../../client/src/lib/format");
  const { paymentSplit } = await import("../../client/src/lib/allocation");
  const { memoText, accountText } = await import("../../client/src/lib/systemText");
  const D = (x: string | number) => new Decimal(x);

  it("keeps a franc rate exact: 2 808 FC is sent with twelve decimals and shown back as 2 808", () => {
    expect(usdPerUnit("2808")).toBe("0.000356125356");
    expect(perUsdText(usdPerUnit("2808"))).toBe("2808");
    expect(perUsdText(usdPerUnit("7.15"))).toBe("7.15");
    expect(perUsdText(usdPerUnit("2808.5"))).toBe("2808.5");
    // 35 000 000 FC at that rate: 12 464,39 $, not 12 460,00 $ (the old six decimals).
    expect(D(35000000).times(usdPerUnit("2808")).toDecimalPlaces(2).toFixed(2)).toBe("12464.39");
    expect(usdPerUnit("")).toBe("");
  });

  it("says yuan typed in take every dollar", () => {
    const parts = paymentSplit({ usd: D(1000), francs: null, rate: D(2808), owedUsd: D(500), owedFc: D(35000000), owedCny: D(7000), cnyRate: D(7), settleCny: D(7000) });
    expect(parts).toEqual([{ kind: "cny", usd: "1000.00", native: "7000.00" }]);
  });

  it("sends dollars to the dollar debt first, then the francs, then an advance", () => {
    expect(paymentSplit({ usd: D(300), francs: null, rate: D(2800), owedUsd: D(500), owedFc: D(280000), owedCny: D(7000), cnyRate: D(7) })).toEqual([{ kind: "usd", usd: "300.00" }]);
    expect(paymentSplit({ usd: D(700), francs: null, rate: D(2800), owedUsd: D(500), owedFc: D(280000), owedCny: D(7000), cnyRate: D(7) })).toEqual([
      { kind: "usd", usd: "500.00" },
      { kind: "cdf", usd: "100.00", native: "280000.00" },
      { kind: "advance", usd: "100.00", native: null },
    ]);
  });

  it("sends dollars beyond the dollar debt to the yuan when no francs are owed", () => {
    expect(paymentSplit({ usd: D(700), francs: null, rate: D(2800), owedUsd: D(500), owedFc: D(0), owedCny: D(7000), cnyRate: D(7) })).toEqual([
      { kind: "usd", usd: "500.00" },
      { kind: "cny", usd: "200.00", native: "1400.00" },
    ]);
  });

  it("sends francs to the franc debt first, then the dollars", () => {
    expect(paymentSplit({ usd: D(200), francs: D(560000), rate: D(2800), owedUsd: D(500), owedFc: D(280000) })).toEqual([
      { kind: "cdf", usd: "100.00", native: "280000.00" },
      { kind: "usd", usd: "100.00" },
    ]);
  });

  it("translates the memos and account names the server writes, not what people typed", () => {
    expect(memoText("Retour R-000001 sur la vente S-000026 : Mauvaise taille", "en")).toBe("Return R-000001 on sale S-000026: Mauvaise taille");
    expect(memoText("Écart de change (coût moyen des devises)", "en")).toBe("Exchange difference (average cost of the currency)");
    expect(memoText("Paiement à Huanghe Group", "en")).toBe("Payment to Huanghe Group");
    expect(memoText("Salaires octobre 2026", "en")).toBe("Salaries October 2026");
    expect(memoText("Retrait d'Associé A", "en")).toBe("Withdrawal by Associé A");
    expect(memoText("Retrait banque du lundi", "en")).toBe("Retrait banque du lundi");
    expect(memoText("Loyer d'octobre boutique", "en")).toBe("Loyer d'octobre boutique");
    expect(memoText("Arrondi FC", "fr")).toBe("Arrondi FC");
    expect(memoText("ADJ-000001\u00a0: Inventaire d'octobre", "en")).toBe("ADJ-000001: Inventaire d'octobre");
    expect(accountText("Caisse FC", "en")).toBe("Cash FC");
    expect(accountText("Associé A : compte de bénéfices", "en")).toBe("Associé A: profit account");
    expect(accountText("Ma caisse", "en")).toBe("Ma caisse");
  });
});
