import { describe, expect, it } from "vitest";

describe("thirteenth UI audit: one franc rounding wording", async () => {
  const { fcRounding, setFormatLang } = await import("../../client/src/lib/format");
  const fr = (_en: string, f: string) => f;
  const NB = " ";

  it("signs the rounding as the books keep it, with words that say which way", () => {
    setFormatLang("fr");
    // 75 800 FC for 75 816 FC: 16 FC short, a cent less for the shop.
    expect(fcRounding(fr, "-0.01", "-16")).toEqual({ figure: `−16${NB}FC (−0,01${NB}$)`, words: "en moins pour la boutique", short: "manquant" });
    // 7 FC over: under half a cent, still said in francs, as the till showed it.
    expect(fcRounding(fr, "0.00", "7")).toEqual({ figure: `+7${NB}FC`, words: "en plus pour la boutique", short: "gardé" });
    // Sale page and list: dollars only.
    expect(fcRounding(fr, "0.02")?.figure).toBe(`+0,02${NB}$`);
    expect(fcRounding(fr, "-0.03")?.short).toBe("manquant");
    expect(fcRounding(fr, "0.00")).toBeNull();
    expect(fcRounding(fr, 0, "0")).toBeNull();
  });
});
