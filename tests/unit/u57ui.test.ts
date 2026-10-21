import { afterEach, describe, expect, it } from "vitest";

describe("fifty-second UI audit: an emptied cart is never kept nor offered", async () => {
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
  const base: import("../../client/src/lib/posDraft").PosDraft = {
    v: draft.DRAFT_VERSION, userId: 3, locationId: 1, slot: "abc1", savedAt: 1_700_000_000_000, day: "2026-10-21", cdfRate: "2800",
    lines: [], discount: "", customerId: null, customer: null, note: "",
    // "Tout en espèces FC" pressed for the 22 $ tyre, then "Vider": the 61 800 FC stayed.
    pays: [{ accountId: 2, amount: "61800", rate: null }], changeAccId: null, changeAmt: "", francsChosen: true,
  };
  const line = { variant: { id: 7, sellPrice: "22.00", productName: "Pneu" }, unitId: null, qty: "1", unitPrice: "22.00", lineDiscount: "0" };

  it("counts a cart without items as empty, payments typed or not", () => {
    expect(draft.draftEmpty(base)).toBe(true);
    expect(draft.draftEmpty({ lines: [] })).toBe(true);
    expect(draft.draftEmpty({ ...base, lines: [line] })).toBe(false);
  });

  it("removes the draft once the cart is emptied, and drops one kept before with 0 lines", () => {
    const s = fakeStorage();
    g.window = { sessionStorage: s };
    draft.saveDraft({ ...base, lines: [line] });
    expect(draft.listDrafts(3, 1)).toHaveLength(1);
    draft.saveDraft(base);
    expect(s.map.size).toBe(0);
    // A "0 ligne" draft with its payment, as an earlier till kept it: not offered for "Reprendre".
    s.setItem(draft.draftKey(3, 1, "old1"), JSON.stringify({ ...base, slot: "old1" }));
    expect(draft.listDrafts(3, 1)).toEqual([]);
    expect(draft.findDraft(3, 1)).toBeNull();
  });
});
