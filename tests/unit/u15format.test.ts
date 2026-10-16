import { describe, expect, it } from "vitest";
import { knownUnit, unitKey, wholeUnit } from "../../shared/units";
import { containerNumberKey } from "../../shared/containerNumber";

describe("tenth UI audit: units, container numbers, memos", async () => {
  const { memoText } = await import("../../client/src/lib/systemText");

  it("counts the template's \"pce\" and abbreviations with a dot as pieces", () => {
    for (const u of ["pce", "PCE", "pces", "pcs.", "pc.", "pce.", "u.", "Pièce", "pcs"]) {
      expect(unitKey(u), u).toBe("pcs");
      expect(wholeUnit(u), u).toBe(true);
      expect(knownUnit(u), u).toBe(true);
    }
    expect(unitKey("l.")).toBe("litre");
    expect(wholeUnit("kg")).toBe(false);
    // A unit nobody knows stays as typed, with decimals allowed, and is said to be unknown.
    expect(wholeUnit("sac")).toBe(false);
    expect(knownUnit("sac")).toBe(false);
    expect(knownUnit("")).toBe(true);
    expect(unitKey(".")).toBe(".");
  });

  it("compares container numbers without spaces, dashes or dots", () => {
    expect(containerNumberKey("HHU 2026 010")).toBe("HHU2026010");
    expect(containerNumberKey("hhu-2026-010")).toBe("HHU2026010");
    expect(containerNumberKey("HHU.2026/010_")).toBe("HHU2026010");
  });

  it("writes the imported opening stock's memo in English", () => {
    expect(memoText("ADJ-000004 : Stock d'ouverture importé", "en")).toBe("ADJ-000004: Opening stock imported");
    expect(memoText("ADJ-000004 : Stock d'ouverture importé", "fr")).toBe("ADJ-000004 : Stock d'ouverture importé");
    expect(memoText("ADJ-000005 : Inventaire", "en")).toBe("ADJ-000005: Inventaire");
  });
});
