import { describe, expect, it } from "vitest";
import { splitProfit } from "@shared/partnerSplit";

const partners = [
  { id: 1, sharePct: 75, bearsOperatingExpenses: true },
  { id: 2, sharePct: 25, bearsOperatingExpenses: false },
];

describe("splitProfit", () => {
  it("matches the plan's example", () => {
    const r = splitProfit(10000, 2000, partners);
    expect(r.partners.map((p) => p.net)).toEqual(["5500.00", "2500.00"]);
    expect(r.netProfit).toBe("8000.00");
  });

  it("lets the 75% partner go negative when expenses exceed their share", () => {
    const r = splitProfit(1000, 1000, partners);
    expect(r.partners.map((p) => p.net)).toEqual(["-250.00", "250.00"]);
  });

  it("shares a gross loss by share", () => {
    const r = splitProfit(-400, 100, partners);
    expect(r.partners.map((p) => p.net)).toEqual(["-400.00", "-100.00"]);
  });

  it("is exact to the cent", () => {
    const r = splitProfit("0.03", 0, partners);
    expect(r.partners.map((p) => p.shareOfGrossProfit)).toEqual(["0.02", "0.01"]);
  });

  it("requires shares to add up to 100", () => {
    expect(() => splitProfit(1, 0, [{ id: 1, sharePct: 70, bearsOperatingExpenses: true }])).toThrow(/100/);
  });
});
