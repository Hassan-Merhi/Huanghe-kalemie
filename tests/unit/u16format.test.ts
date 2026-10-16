import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

describe("eleventh UI audit: chart labels, what a voucher line owes", async () => {
  const { axisLines } = await import("../../client/src/lib/format");
  const { owedOn, paymentSplit } = await import("../../client/src/lib/allocation");

  it("puts a long category name on two lines between words instead of cutting it", () => {
    expect(axisLines("Carburant du groupe électrogène")).toEqual(["Carburant du", "groupe électrogène"]);
    expect(axisLines("Pneus et chambres à air")).toEqual(["Pneus et chambres", "à air"]);
    expect(axisLines("Huiles et lubrifiants")).toEqual(["Huiles et", "lubrifiants"]);
    expect(axisLines("Motos")).toEqual(["Motos"]);
    // Only what does not fit on two lines is cut.
    expect(axisLines("Frais de transport des pièces détachées au dépôt")).toEqual(["Frais de transport", "des pièces détach…"]);
    expect(axisLines("Anticonstitutionnellement")).toEqual(["Anticonstitutionn…"]);
  });

  it("reads what is owed on a contact in the direction of the voucher line", () => {
    // A customer who owes 1 450 $: owed on a receipt, nothing on a payment.
    const garage = { balance: "1450.00", foreign: [] };
    expect(owedOn(garage, "receipt").usd.toFixed(2)).toBe("1450.00");
    expect(owedOn(garage, "payment").usd.toFixed(2)).toBe("0.00");
    // An agent we owe 868,66 $, of which 84 000 FC (29,91 $) in francs.
    const agent = { balance: "-868.66", foreign: [{ currency: "CDF", native: "-84000.00", usd: "-29.91" }] };
    const owed = owedOn(agent, "payment");
    expect(owed.usd.toFixed(2)).toBe("838.75");
    expect(owed.fc.toFixed(0)).toBe("84000");
    expect(owedOn(agent, "receipt").usd.toFixed(2)).toBe("0.00");
  });

  it("finds the advance in a receipt far above the debt (49 140 000 FC for 1 450 $)", () => {
    const owed = owedOn({ balance: "1450.00", foreign: [] }, "receipt");
    const rate = new Decimal(2808);
    const francs = new Decimal(49140000);
    const split = paymentSplit({ usd: francs.dividedBy(rate), francs, rate, owedUsd: owed.usd, owedFc: owed.fc });
    expect(split.find((p) => p.kind === "usd")?.usd).toBe("1450.00");
    expect(split.find((p) => p.kind === "advance")?.usd).toBe("16050.00");
    // Nothing owed to an employee: the whole payment is an advance.
    const none = owedOn({ balance: "0.00", foreign: [] }, "payment");
    expect(paymentSplit({ usd: new Decimal(5000), francs: null, rate: null, owedUsd: none.usd, owedFc: none.fc })).toEqual([{ kind: "advance", usd: "5000.00", native: null }]);
  });
});
