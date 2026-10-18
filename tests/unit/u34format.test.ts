import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

describe("twenty-ninth UI audit: the owner's franc refund cap", async () => {
  const { fcRefundCap } = await import("../../client/src/lib/format");
  // As the server pays a franc refund out: rounded down to 100 FC.
  const paidOut = (usdBack: string, rate: Decimal) => new Decimal(usdBack).times(rate).dividedBy(100).floor().times(100);

  it("takes the highest rate whose refund, rounded down to 100 FC, is still within the francs left", () => {
    // 22 $ back of 61 800 FC paid: 2 809 gave 61 798 → 61 700 FC; 2 813 gives 61 886 → 61 800 FC.
    const cap = fcRefundCap("22.00", "61800")!;
    expect(cap.rate.toString()).toBe("2813");
    expect(cap.francs.toString()).toBe("61800");
    expect(paidOut("22.00", cap.rate).toString()).toBe("61800");
    expect(paidOut("22.00", cap.rate.plus(1)).gt(61800)).toBe(true);
  });

  it("never gives more than is left, whatever the cents or the francs left", () => {
    for (const [usdBack, left] of [["39.40", "110600"], ["17.03", "48000"], ["0.99", "2800"], ["250.00", "702050"], ["5", "14099"]]) {
      const cap = fcRefundCap(usdBack, left)!;
      expect(cap.francs.equals(paidOut(usdBack, cap.rate))).toBe(true);
      expect(cap.francs.lte(left)).toBe(true);
      expect(paidOut(usdBack, cap.rate.plus(1)).gt(left)).toBe(true);
    }
  });

  it("offers nothing when there is nothing to give back within the francs left", () => {
    expect(fcRefundCap("0", "61800")).toBeNull();
    expect(fcRefundCap("22", "99")).toBeNull();
    expect(fcRefundCap("22", "0")).toBeNull();
  });
});

describe("twenty-ninth UI audit: a rate gap near a limit", async () => {
  const { gapPct } = await import("../../client/src/lib/format");
  const NB = " ";
  const limits = [new Decimal(3), new Decimal(5)];

  it("shows one decimal when the whole percent would read as a limit it is not", () => {
    expect(gapPct(new Decimal(142).dividedBy(2808).times(100), limits)).toBe(`5,1${NB}%`);
    expect(gapPct(new Decimal(138).dividedBy(2812).times(100), limits)).toBe(`4,9${NB}%`);
    expect(gapPct(new Decimal("3.2"), limits)).toBe(`3,2${NB}%`);
    expect(gapPct(new Decimal("5.04"), limits)).toBe(`5,04${NB}%`);
  });

  it("keeps whole percents elsewhere, and a gap exactly at the limit as it is", () => {
    expect(gapPct(new Decimal("12.4"), limits)).toBe(`12${NB}%`);
    expect(gapPct(new Decimal("5"), limits)).toBe(`5${NB}%`);
    expect(gapPct(new Decimal("4.4"), limits)).toBe(`4${NB}%`);
    expect(gapPct(new Decimal("4.9"))).toBe(`5${NB}%`);
  });
});
