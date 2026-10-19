import { afterEach, describe, expect, it } from "vitest";

describe("thirty-seventh UI audit: the till's sale in progress, daily charts, English memos", async () => {
  const draft = await import("../../client/src/lib/posDraft");
  const { everyDay, MAX_FILLED_DAYS } = await import("../../client/src/lib/days");
  const { memoText } = await import("../../client/src/lib/systemText");

  const base = (over: Partial<import("../../client/src/lib/posDraft").PosDraft> = {}) => ({
    v: draft.DRAFT_VERSION,
    userId: 3,
    locationId: 1,
    savedAt: 1_700_000_000_000,
    day: "2026-10-19",
    cdfRate: "2808",
    lines: [{ variant: { id: 7, sellPrice: "22.00", productName: "Pneu" }, unitId: null, qty: "2", unitPrice: "22.00", lineDiscount: "" }],
    discount: "",
    customerId: null,
    customer: null,
    note: "",
    pays: [{ accountId: 2, amount: "123600", rate: null }],
    changeAccId: null,
    changeAmt: "",
    francsChosen: false,
    ...over,
  });

  describe("posDraft", () => {
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

    it("reads back only a draft it wrote for that user, never half of one", () => {
      const ok = base();
      expect(draft.parseDraft(JSON.stringify(ok), 3)).toEqual(ok);
      // Another user's, another version, broken JSON or a line without its item: dropped.
      expect(draft.parseDraft(JSON.stringify(ok), 4)).toBeNull();
      expect(draft.parseDraft(JSON.stringify({ ...ok, v: 0 }), 3)).toBeNull();
      expect(draft.parseDraft("{", 3)).toBeNull();
      expect(draft.parseDraft(null, 3)).toBeNull();
      expect(draft.parseDraft(JSON.stringify({ ...ok, lines: [{ qty: "1" }] }), 3)).toBeNull();
      expect(draft.parseDraft(JSON.stringify({ ...ok, pays: [{ accountId: 2, amount: 5, rate: null }] }), 3)).toBeNull();
      expect(draft.parseDraft(JSON.stringify({ ...ok, customerId: 9, customer: { id: 8 } }), 3)).toBeNull();
      expect(draft.parseDraft(JSON.stringify({ ...ok, customerId: 9, customer: { id: 9, name: "Garage" } }), 3)?.customerId).toBe(9);
    });

    it("keeps one draft per user and location, and removes it once the cart is empty", () => {
      const s = fakeStorage();
      g.window = { sessionStorage: s };
      draft.saveDraft(base());
      draft.saveDraft(base({ locationId: 2, savedAt: 1_700_000_100_000 }));
      draft.saveDraft(base({ userId: 5 }));
      expect(Array.from(s.map.keys()).sort()).toEqual(["hk.pos.draft.3.1", "hk.pos.draft.3.2", "hk.pos.draft.5.1"]);
      // The draft at the till's location first, else the user's latest elsewhere; never another user's.
      expect(draft.findDraft(3, 1)?.locationId).toBe(1);
      expect(draft.findDraft(3, 9)?.locationId).toBe(2);
      expect(draft.findDraft(7, 1)).toBeNull();
      // A cart emptied (no item, no payment typed) takes its draft away; a payment alone is kept.
      draft.saveDraft(base({ lines: [], pays: [{ accountId: 2, amount: "", rate: null }] }));
      expect(s.map.has("hk.pos.draft.3.1")).toBe(false);
      draft.saveDraft(base({ lines: [] }));
      expect(s.map.has("hk.pos.draft.3.1")).toBe(true);
      draft.removeDraft(3, 1);
      draft.removeDraft(3, 2);
      expect(draft.findDraft(3, 1)).toBeNull();
    });

    it("works without storage, as in a private window", () => {
      g.window = {
        get sessionStorage() {
          throw new Error("blocked");
        },
      };
      expect(() => draft.saveDraft(base())).not.toThrow();
      expect(draft.findDraft(3, 1)).toBeNull();
    });

    it("takes a new list price only for a line sold at the old one", () => {
      expect(draft.resumedPrice({ unitPrice: "22.00" }, "22.00", "24.50")).toEqual({ unitPrice: "24.50", changed: true });
      // A price typed by hand stays; so does one whose list price did not move.
      expect(draft.resumedPrice({ unitPrice: "20.00" }, "22.00", "24.50")).toEqual({ unitPrice: "20.00", changed: false });
      expect(draft.resumedPrice({ unitPrice: "22" }, "22.00", "22.00")).toEqual({ unitPrice: "22", changed: false });
      expect(draft.resumedPrice({ unitPrice: "1.200?" }, "22.00", "24.50")).toEqual({ unitPrice: "1.200?", changed: false });
    });
  });

  describe("everyDay", () => {
    const zero = (date: string) => ({ date, revenue: "0" });
    it("draws the days without sales at zero, up to today", () => {
      const rows = [{ date: "2026-10-13", revenue: "40" }, { date: "2026-10-19", revenue: "25" }];
      const out = everyDay(rows, "2026-10-12", "2026-10-31", zero, "2026-10-19");
      expect(out.map((r) => r.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
      expect(out.map((r) => r.revenue)).toEqual(["0", "40", "0", "0", "0", "0", "0", "25"]);
      // Across a month end and the end of February.
      expect(everyDay([], "2028-02-28", "2028-03-01", zero).map((r) => r.date)).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    });
    it("keeps the rows as they are for a range it cannot or should not fill", () => {
      const rows = [{ date: "2026-10-13", revenue: "40" }];
      expect(everyDay(rows, "2026-10-20", "2026-10-10", zero)).toBe(rows);
      expect(everyDay(rows, "", "2026-10-10", zero)).toBe(rows);
      expect(everyDay(rows, "2020-01-01", "2026-10-10", zero)).toBe(rows);
      expect(everyDay([], "2026-01-01", "2026-12-31", zero).length).toBeLessThanOrEqual(MAX_FILLED_DAYS);
    });
  });

  it("says the Payroll page's advance libellé and the advance deducted from a franc salary in English", () => {
    expect(memoText("Avance sur salaire", "en")).toBe("Salary advance");
    expect(memoText("Avance sur salaire", "fr")).toBe("Avance sur salaire");
    expect(memoText("Avance déduite du salaire octobre 2026", "en")).toBe("Advance deducted from the October 2026 salary");
  });
});
