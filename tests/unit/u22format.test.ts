import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

describe("seventeenth UI audit: what settles a contact's francs", async () => {
  const { owedOn, paymentSplit } = await import("../../client/src/lib/allocation");
  const D = (x: string | number) => new Decimal(x);
  // Transit Lubumbashi: 3 260 $ and 84 000 FC owed (booked at 30,10 $), 2 808 FC for 1 $ today.
  const transit = { balance: "-3290.10", foreign: [{ currency: "CDF", native: "-84000.00", usd: "-30.10" }] };
  const owed = owedOn(transit, "payment");
  const split = (usd: string) => paymentSplit({ usd: D(usd), francs: null, rate: D(2808), owedUsd: owed.usd, owedFc: owed.fc });

  it("settles all the francs for the dollars they are worth today, with no cent left as an advance (as contactLines)", () => {
    expect(owed.usd.toFixed(2)).toBe("3260.00");
    expect(owed.fc.toFixed(2)).toBe("84000.00");
    // The voucher line's "Tout": 3 260 $ + 84 000 FC at 2 808 = 3 289,91 $.
    expect(split("3289.91")).toEqual([
      { kind: "usd", usd: "3260.00" },
      { kind: "cdf", usd: "29.91", native: "84000.00" },
    ]);
  });

  it("makes an advance of what is paid beyond that, the booked 3 290,10 $ included", () => {
    expect(split("3290.10")).toEqual([
      { kind: "usd", usd: "3260.00" },
      { kind: "cdf", usd: "29.91", native: "84000.00" },
      { kind: "advance", usd: "0.19", native: null },
    ]);
  });

  it("buys whole francs, rounded down, with less", () => {
    expect(split("3270")).toEqual([
      { kind: "usd", usd: "3260.00" },
      { kind: "cdf", usd: "10.00", native: "28080.00" },
    ]);
  });
});
