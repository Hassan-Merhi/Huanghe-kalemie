import { describe, expect, it } from "vitest";
import { computeLandedCost } from "@shared/landedCost";
import { allocateCents } from "@shared/money";

describe("allocateCents", () => {
  it("always adds up to the total", () => {
    const parts = allocateCents("100.00", [1, 1, 1]);
    expect(parts.map((p) => p.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
  });

  it("handles negative totals", () => {
    const parts = allocateCents("-10.00", [3, 1]);
    expect(parts.map((p) => p.toFixed(2))).toEqual(["-7.50", "-2.50"]);
  });

  it("refuses all-zero weights for a non-zero amount", () => {
    expect(() => allocateCents("5", [0, 0])).toThrow();
  });
});

describe("computeLandedCost", () => {
  const lines = [
    { key: "bike", quantity: 10, unitPrice: 1500 },
    { key: "pads", quantity: 1000, unitPrice: 5 },
  ];

  it("splits expenses by purchase value (the plan's worked example)", () => {
    const r = computeLandedCost(lines, [{ key: "all", amountUsd: 4000, method: "value" }]);
    expect(r.fobTotalUsd).toBe("20000.00");
    expect(r.landedTotalUsd).toBe("24000.00");
    expect(r.lines[0].landedUnitCost).toBe("1800.000000");
    expect(r.lines[1].landedUnitCost).toBe("6.000000");
  });

  it("supports quantity, weight, volume and single-line methods", () => {
    const r = computeLandedCost(
      [
        { key: 1, quantity: 2, unitPrice: 100, weightKg: 300, volumeCbm: 1 },
        { key: 2, quantity: 8, unitPrice: 10, weightKg: 100, volumeCbm: 3 },
      ],
      [
        { key: "q", amountUsd: 100, method: "quantity" },
        { key: "w", amountUsd: 100, method: "weight" },
        { key: "v", amountUsd: 100, method: "volume" },
        { key: "l", amountUsd: 50, method: "line", targetLineKey: 2 },
      ],
    );
    expect(r.lines[0].byExpense).toEqual({ q: "20.00", w: "75.00", v: "25.00", l: "0.00" });
    expect(r.lines[1].byExpense).toEqual({ q: "80.00", w: "25.00", v: "75.00", l: "50.00" });
    expect(r.landedTotalUsd).toBe("630.00");
  });

  it("converts the container currency to USD", () => {
    const r = computeLandedCost([{ key: 1, quantity: 10, unitPrice: 70 }], [], "0.14");
    expect(r.lines[0].fobUsd).toBe("98.00");
    expect(r.lines[0].landedUnitCost).toBe("9.800000");
  });

  it("keeps the landed total exact when cents do not divide evenly", () => {
    const r = computeLandedCost(
      [
        { key: 1, quantity: 3, unitPrice: 1 },
        { key: 2, quantity: 3, unitPrice: 1 },
        { key: 3, quantity: 3, unitPrice: 1 },
      ],
      [{ key: "x", amountUsd: "0.10", method: "value" }],
    );
    const total = r.lines.reduce((s, l) => s + Math.round(Number(l.landedTotalUsd) * 100), 0);
    expect(total).toBe(910);
  });

  it("refuses a weight split when no line has a weight", () => {
    expect(() => computeLandedCost(lines, [{ key: "w", amountUsd: 10, method: "weight" }])).toThrow(/weight/);
  });
});
