import { describe, expect, it } from "vitest";

describe("twenty-eighth UI audit: more francs handed back than paid", async () => {
  const { fcRateGap } = await import("../../client/src/lib/format");
  const fr = (_en: string, f: string) => f;
  const en = (e: string) => e;

  it("says the francs below zero in francs, as a rate difference", () => {
    expect(fcRateGap(fr, "-1000.00")?.figure).toMatch(/^Francs \u22121.000\u00a0FC \(écart de taux\)$/);
    expect(fcRateGap(en, "-1000")?.figure).toMatch(/^Francs \u22121.000\u00a0FC \(rate difference\)$/);
    expect(fcRateGap(fr, "-1000")?.words).toContain("\u00a0: le remboursement");
  });

  it("says nothing when the francs net to zero or more, or are not known", () => {
    expect(fcRateGap(fr, "0")).toBeNull();
    expect(fcRateGap(fr, "70200.00")).toBeNull();
    expect(fcRateGap(fr, null)).toBeNull();
    expect(fcRateGap(fr, undefined)).toBeNull();
  });
});
