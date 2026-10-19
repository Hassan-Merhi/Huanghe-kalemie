import { afterEach, describe, expect, it } from "vitest";

describe("forty-sixth UI audit: a sale left unfinished steps back once the day moves on", async () => {
  const draft = await import("../../client/src/lib/posDraft");
  const g = globalThis as { window?: unknown };
  afterEach(() => delete g.window);
  function fakeStorage() {
    const m = new Map<string, string>();
    return {
      get length() { return m.size; },
      key: (i: number) => Array.from(m.keys())[i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      map: m,
    };
  }
  const saved = 1_700_000_000_000;

  it("announces it in full while it is recent and no sale was completed since", () => {
    expect(draft.draftNags({ savedAt: saved }, null, saved + 60_000)).toBe(true);
    // Five sales later (the audit's 21:03 draft still nagging): a sale completed after it demotes it.
    expect(draft.draftNags({ savedAt: saved }, saved + 30_000, saved + 60_000)).toBe(false);
    // A sale completed before it was last saved is no reason: the draft is the newer work.
    expect(draft.draftNags({ savedAt: saved }, saved - 30_000, saved + 60_000)).toBe(true);
  });

  it("and only from the link after a few hours, sale or no sale", () => {
    const h = 3600_000;
    expect(draft.draftNags({ savedAt: saved }, null, saved + (draft.DRAFT_NAG_HOURS - 1) * h)).toBe(true);
    expect(draft.draftNags({ savedAt: saved }, null, saved + (draft.DRAFT_NAG_HOURS + 1) * h)).toBe(false);
  });

  it("keeps the last sale per user in the tab, beside the drafts and not among them", () => {
    const s = fakeStorage();
    g.window = { sessionStorage: s };
    expect(draft.lastSaleAt(3)).toBeNull();
    draft.noteSale(3, saved);
    expect(draft.lastSaleAt(3)).toBe(saved);
    expect(draft.lastSaleAt(4)).toBeNull();
    // The sale's note is not read back as a draft of that user.
    expect(draft.listDrafts(3, 1)).toEqual([]);
    s.setItem("hk.pos.lastSale.3", "garbage");
    expect(draft.lastSaleAt(3)).toBeNull();
  });
});

describe("forty-sixth UI audit: the count form's cost reads as the item's page does", async () => {
  const { variantUnitCost, variantUnitCostValue, setFormatLang } = await import("../../client/src/lib/format");
  it("prefills 4,125 $ for 5 pieces imported at 4,125 $ (20,63 $), not 4,126 $", () => {
    setFormatLang("fr");
    const joint = { avgCost: "4.126000", stockValue: "20.63", stockQty: "5.000", keptUnitCost: "4.125000" };
    expect(variantUnitCostValue(joint)).toBe("4.125");
    expect(variantUnitCost(joint)).toBe("4,125 $");
    // The same without the kept cost (an older movement): the roundest figure that gives the value.
    expect(variantUnitCostValue({ ...joint, keptUnitCost: null })).toBe("4.125");
    // Stock at two costs, no rounder figure: value ÷ quantity as before.
    expect(variantUnitCostValue({ avgCost: "0.165000", stockValue: "0.33", stockQty: "2.000", keptUnitCost: "0.200000" })).toBe("0.165");
    // A row without the value (a cashier's, or an older API): the average given.
    expect(variantUnitCostValue({ avgCost: "4.126000" })).toBe("4.126000");
  });
});
