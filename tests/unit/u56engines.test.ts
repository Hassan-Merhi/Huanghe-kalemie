import { describe, expect, it } from "vitest";

describe("thirty-seventh UI audit: engine numbers on two motorcycles", async () => {
  const { engineKey, engineRepeats } = await import("../../client/src/lib/engines");
  const fr = (_en: string, f: string) => f;
  const en = (e: string) => e;
  const registered = [
    { id: 16, chassisNo: "LHJPCK100016", engineNo: "162FMJ500016", productName: "Haojue 125" },
    { id: 20, chassisNo: null, engineNo: "162FMJ900020", productName: "Haojue 150" },
    { id: 30, chassisNo: null, engineNo: "162FMJ700030", productName: "Haojue 150" },
  ];

  it("compares engine numbers without case or spaces", () => {
    expect(engineKey(" 162fmj 800001 ")).toBe("162FMJ800001");
    expect(engineKey(null)).toBe("");
  });

  it("names the bike already carrying the engine number", () => {
    expect(engineRepeats(fr, [{ id: 40, engineNo: "162fmj500016 " }], registered).get(0)).toBe("Le numéro de moteur 162FMJ500016 est déjà sur LHJPCK100016");
    expect(engineRepeats(en, [{ id: 40, engineNo: "162FMJ900020" }], registered).get(0)).toBe("Engine number 162FMJ900020 is already on another motorcycle (Haojue 150)");
    // The bike's own saved engine is not a repeat, nor an empty field.
    expect(engineRepeats(fr, [{ id: 16, engineNo: "162FMJ500016" }, { id: 41, engineNo: "" }], registered).size).toBe(0);
  });

  it("marks a number typed twice in the dialog, on both lines", () => {
    const r = engineRepeats(fr, [{ id: 50, engineNo: "162FMJ800001" }, { id: 51, engineNo: "162fmj800001 " }], registered);
    expect([...r.entries()]).toEqual([
      [0, "Le numéro de moteur 162FMJ800001 est saisi deux fois (motos 1 et 2)"],
      [1, "Le numéro de moteur 162FMJ800001 est saisi deux fois (motos 1 et 2)"],
    ]);
  });

  it("leaves out lines not saved, whose bikes keep their registered engine", () => {
    // Bike 30 is in the dialog but has no chassis typed: its saved engine still counts against line 1.
    const r = engineRepeats(fr, [{ id: 52, engineNo: "162FMJ700030" }, { id: 30, engineNo: "162FMJ700030", saved: false }], registered);
    expect([...r.entries()]).toEqual([[0, "Le numéro de moteur 162FMJ700030 est déjà sur une autre moto (Haojue 150)"]]);
    // Once saved with another engine, the old one is free.
    expect(engineRepeats(fr, [{ id: 52, engineNo: "162FMJ700030" }, { id: 30, engineNo: "162FMJ700031" }], registered).size).toBe(0);
  });
});
