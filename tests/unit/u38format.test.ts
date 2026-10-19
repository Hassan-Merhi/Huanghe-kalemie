import { afterEach, describe, expect, it } from "vitest";

describe("thirty-third UI audit: a container's rate refused before the server refuses it", async () => {
  const { containerRateRefusal, usdPerUnit, setFormatLang } = await import("../../client/src/lib/format");
  const NB = " ";
  const fr = (_en: string, f: string) => f;
  const en = (e: string) => e;
  afterEach(() => setFormatLang("fr"));

  it("refuses a yuan rate typed upside down when no yuan rate is on file, as the server does", () => {
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("0.138"), null, "3")).toBe(
      `0,138${NB}¥ pour 1${NB}$ semble faux${NB}: un dollar vaut environ 7,1${NB}¥. Indiquez combien de yuans vaut 1${NB}$.`,
    );
    setFormatLang("en");
    expect(containerRateRefusal(en, "CNY", usdPerUnit("0.138"), null, "3")).toMatch(/^0\.138 CNY for \$1 looks wrong/);
    // 4 to 12,5 ¥ for 1 $ is taken (the server's 0,08 to 0,25 $ per yuan).
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("7.1"), null, "3")).toBeNull();
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("4"), null, "3")).toBeNull();
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("12.5"), null, "3")).toBeNull();
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("13"), null, "3")).not.toBeNull();
  });

  it("refuses a rate more than the larger of the tolerance and 5 % from the one on file, francs too", () => {
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("0.138"), "7.1", "3")).toBe(
      `Plus de 5${NB}% d'écart avec le taux enregistré (1${NB}$ = 7,1${NB}¥)${NB}: vérifiez la facture, ou mettez d'abord à jour le taux du jour`,
    );
    // 7,4 ¥ is 4 % off: a warning under the field, not a refusal.
    expect(containerRateRefusal(fr, "CNY", usdPerUnit("7.4"), "7.1", "3")).toBeNull();
    expect(containerRateRefusal(fr, "CDF", usdPerUnit("2.808"), "2808", "3")).toMatch(/^Plus de 5 % d'écart avec le taux enregistré \(1 \$ = 2 808 FC\)/);
    expect(containerRateRefusal(fr, "CDF", usdPerUnit("2850"), "2808", "3")).toBeNull();
    // A tolerance set above 5 % is the limit.
    expect(containerRateRefusal(fr, "CDF", usdPerUnit("3000"), "2808", "8")).toBeNull();
    expect(containerRateRefusal(fr, "USD", "1", null, "3")).toBeNull();
    expect(containerRateRefusal(fr, "CNY", "", "7.1", "3")).toBeNull();
  });
});
