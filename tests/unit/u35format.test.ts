import { describe, expect, it } from "vitest";

const fr = (_en: string, f: string) => f;
const en = (e: string) => e;

describe("thirtieth UI audit: a supplier's yuan on a payment's date", async () => {
  const { yuanOnDate } = await import("../../client/src/lib/allocation");
  const row = (date: string, nativeAmount: string | null, debit: string, credit: string, currency = "CNY") => ({ date, currency, nativeAmount, debit, credit });
  // 70 050 ¥ owed from an offload on the 18th, a dollar bill on the 10th, 1 000 ¥ paid on the 18th.
  const rows = [
    row("2026-10-10", null, "0", "500.00", "USD"),
    row("2026-10-18", "-70050.00", "0", "9866.20"),
    row("2026-10-18", "1000.00", "140.84", "0"),
  ];

  it("owes no yuan before the offload that starts the debt, and says when it starts", () => {
    expect(yuanOnDate(rows, "2026-10-15")).toEqual({ native: "0.00", usd: "0.00", latest: "2026-10-18", startsAfter: "2026-10-18" });
  });

  it("is today's balance on or after the latest yuan entry", () => {
    expect(yuanOnDate(rows, "2026-10-18")).toEqual({ native: "-69050.00", usd: "-9725.36", latest: "2026-10-18", startsAfter: null });
    expect(yuanOnDate(rows, "2026-10-20").native).toBe("-69050.00");
  });

  it("counts only yuan that moved, and a later refund is not where the debt starts", () => {
    const more = [row("2026-10-01", "-2000.00", "0", "281.69"), row("2026-10-05", "0.00", "0.01", "0"), row("2026-10-12", "500.00", "70.42", "0")];
    expect(yuanOnDate(more, "2026-10-03")).toEqual({ native: "-2000.00", usd: "-281.69", latest: "2026-10-12", startsAfter: null });
    // A timestamp's date counts as its day.
    expect(yuanOnDate([row("2026-10-18T00:00:00.000Z", "-10.00", "0", "1.41")], "2026-10-17").startsAfter).toBe("2026-10-18");
  });
});

describe("thirtieth UI audit: the till counts lines and pieces", async () => {
  const { cartCount } = await import("../../client/src/lib/units");

  it("says the pieces of 5 × Pneu, not one article", () => {
    expect(cartCount(fr, [{ qty: "5", unit: "pcs" }])).toBe("1 ligne · 5 pièces");
    expect(cartCount(en, [{ qty: "5", unit: "pcs" }])).toBe("1 line · 5 pieces");
    expect(cartCount(fr, [{ qty: "2", unit: "pair" }, { qty: "1", unit: "paire" }])).toBe("2 lignes · 3 paires");
  });

  it("names lines alone when each is one piece, and keeps measured units as lines", () => {
    expect(cartCount(fr, [{ qty: "1", unit: "pcs" }])).toBe("1 ligne");
    expect(cartCount(fr, [{ qty: "1", unit: "pcs" }, { qty: "1", unit: "" }])).toBe("2 lignes");
    expect(cartCount(fr, [{ qty: "2,5", unit: "litre" }])).toBe("1 ligne");
    expect(cartCount(fr, [{ qty: "2,5", unit: "litre" }, { qty: "4", unit: "pcs" }])).toBe("2 lignes · 4 pièces");
    expect(cartCount(fr, [{ qty: "4", unit: "pcs" }, { qty: "2", unit: "set" }])).toBe("2 lignes · 6 unités");
    expect(cartCount(fr, [])).toBe("0 ligne");
  });

  it("skips a quantity not yet whole, and groups thousands with a no-break space", () => {
    expect(cartCount(fr, [{ qty: "2,5", unit: "pcs" }])).toBe("1 ligne");
    expect(cartCount(fr, [{ qty: "1200", unit: "pcs" }])).toMatch(/^1 ligne · 1[  ]200 pièces$/);
  });
});
