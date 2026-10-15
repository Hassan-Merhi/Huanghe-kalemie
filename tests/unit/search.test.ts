import { describe, expect, it } from "vitest";
import { foldText, searchAlternatives } from "../../server/services/catalog";

describe("POS search words", () => {
  it("ignores accents and case", () => {
    expect(foldText("Arrière Électricité")).toBe("arriere electricite");
  });
  it("finds French and English names for the same part", () => {
    expect(searchAlternatives("frein")).toContain("brake");
    expect(searchAlternatives("Freins")).toContain("frein");
    expect(searchAlternatives("tyre")).toContain("pneu");
    expect(searchAlternatives("huile")).toContain("oil");
  });
  it("keeps short words as they are", () => {
    expect(searchAlternatives("17")).toEqual(["17"]);
  });
});
