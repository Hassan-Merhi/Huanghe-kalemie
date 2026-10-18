import { describe, expect, it } from "vitest";
import { frPlural } from "@shared/french";

/** U24: a word agreeing with a count, as French does it (singular below two). */
describe("frPlural", () => {
  it("keeps the singular below two and adds an s from two", () => {
    expect(frPlural(0, "disponible")).toBe("disponible");
    expect(frPlural("1", "disponible")).toBe("disponible");
    expect(frPlural("1.5", "nécessaire")).toBe("nécessaire");
    expect(frPlural("2", "nécessaire")).toBe("nécessaires");
    expect(frPlural("77.000", "disponible")).toBe("disponibles");
    expect(frPlural(-3, "pièce")).toBe("pièces");
  });
  it("takes an irregular plural", () => {
    expect(frPlural(2, "travail", "travaux")).toBe("travaux");
  });
});
