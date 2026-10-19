import { afterEach, describe, expect, it } from "vitest";
import Decimal from "decimal.js";

describe("thirty-eighth UI audit: advances applied, the till's parked sales, English memos", async () => {
  const { advanceToYuan } = await import("../../client/src/lib/allocation");
  const draft = await import("../../client/src/lib/posDraft");
  const { memoText } = await import("../../client/src/lib/systemText");
  const { advanceText } = await import("../../client/src/lib/format");
  const NB = " ";
  const D = (x: string | number) => new Decimal(x);

  describe("advanceToYuan, as advanceToYuanLines applies it", () => {
    it("settles the yuan a payment leaves from the dollars the supplier holds", () => {
      // The audit's case: 33 000 ¥ owed, 500 $ buys 3 560 ¥ at 7,12; the 5 026,81 $ advance settles the 29 440 ¥ left.
      expect(advanceToYuan({ owedCny: D(33000), owedUsd: D(4600), settledNative: D(3560), advanceUsd: D("5026.81"), cnyRate: D("7.12") })).toEqual({ native: "29440.00", usd: "4134.83" });
      // An advance smaller than what is left settles what it buys.
      expect(advanceToYuan({ owedCny: D(7000), owedUsd: D("985.92"), settledNative: D(710), advanceUsd: D(500), cnyRate: D("7.1") })).toEqual({ native: "3550.00", usd: "500.00" });
    });
    it("values the yuan at their cost with no yuan rate on file, and takes francs held after dollars", () => {
      expect(advanceToYuan({ owedCny: D(7000), owedUsd: D(1000), settledNative: D(0), advanceUsd: D(250), cnyRate: null })).toEqual({ native: "1750.00", usd: "250.00" });
      // 100 $ held and 280 800 FC (100 $ at 2 808): 200 $ of the 1 000 $ owed.
      expect(advanceToYuan({ owedCny: D(7000), owedUsd: D(1000), settledNative: D(0), advanceUsd: D(100), advanceFc: D(280800), fcRate: D(2808), cnyRate: null })).toEqual({ native: "1400.00", usd: "200.00" });
    });
    it("says nothing when nothing is left owed or nothing is held", () => {
      expect(advanceToYuan({ owedCny: D(3560), owedUsd: D(500), settledNative: D(3560), advanceUsd: D(5000), cnyRate: D("7.12") })).toBeNull();
      expect(advanceToYuan({ owedCny: D(3560), owedUsd: D(500), settledNative: D(0), advanceUsd: D(0), cnyRate: D("7.12") })).toBeNull();
      expect(advanceToYuan({ owedCny: D(0), owedUsd: D(0), settledNative: D(0), advanceUsd: D(50), cnyRate: D("7.12") })).toBeNull();
    });
  });

  it("writes an advance applied with what it settled", () => {
    expect(advanceText({ usd: "4134.83", cny: "29440.00" })).toBe(`4${NB}134,83${NB}$ (29${NB}440,00${NB}¥)`);
    expect(advanceText({ usd: "100.00" })).toBe(`100,00${NB}$`);
  });

  describe("posDraft slots", () => {
    const g = globalThis as { window?: unknown };
    afterEach(() => delete g.window);
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
      pays: [],
      changeAccId: null,
      changeAmt: "",
      francsChosen: false,
      ...over,
    });
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

    it("keeps a cart rung while another is offered beside it, never over it", () => {
      const s = fakeStorage();
      g.window = { sessionStorage: s };
      const parked = base();
      const live = base({ slot: "k2x9ab", savedAt: 1_700_000_100_000, lines: [] });
      draft.saveDraft(parked);
      // The new cart's empty save removes only its own key: the parked sale stays.
      draft.saveDraft(live);
      expect(Array.from(s.map.keys())).toEqual(["hk.pos.draft.3.1"]);
      draft.saveDraft({ ...live, lines: parked.lines });
      expect(Array.from(s.map.keys()).sort()).toEqual(["hk.pos.draft.3.1", "hk.pos.draft.3.1.k2x9ab"]);
      // The banner offers the others, the till's own cart left out; both stay listed for the next opening.
      expect(draft.listDrafts(3, 1, live).map((x) => x.slot ?? "")).toEqual([""]);
      expect(draft.listDrafts(3, 1).map((x) => x.slot ?? "")).toEqual(["k2x9ab", ""]);
      // Completing or discarding one removes that one only.
      draft.removeDraft(3, 1, "k2x9ab");
      expect(draft.listDrafts(3, 1).map((x) => x.slot ?? "")).toEqual([""]);
      draft.removeDraft(3, 1);
      expect(draft.findDraft(3, 1)).toBeNull();
    });

    it("lists the drafts at the till's location first, then the latest", () => {
      const s = fakeStorage();
      g.window = { sessionStorage: s };
      draft.saveDraft(base({ locationId: 2, savedAt: 1_700_000_300_000 }));
      draft.saveDraft(base({ slot: "a1", savedAt: 1_700_000_100_000 }));
      draft.saveDraft(base({ slot: "b2", savedAt: 1_700_000_200_000 }));
      expect(draft.listDrafts(3, 1).map((x) => `${x.locationId}.${x.slot ?? ""}`)).toEqual(["1.b2", "1.a1", "2."]);
      expect(draft.findDraft(3, 9)?.locationId).toBe(2);
    });

    it("refuses a slot it did not write, and a draft stored under another key", () => {
      const ok = base({ slot: "k2x9ab" });
      expect(draft.parseDraft(JSON.stringify(ok), 3)).toEqual(ok);
      expect(draft.parseDraft(JSON.stringify({ ...ok, slot: "" }), 3)).toBeNull();
      expect(draft.parseDraft(JSON.stringify({ ...ok, slot: "../x" }), 3)).toBeNull();
      const s = fakeStorage();
      g.window = { sessionStorage: s };
      s.setItem("hk.pos.draft.3.1.other", JSON.stringify(ok));
      expect(draft.listDrafts(3, 1)).toEqual([]);
      expect(draft.newSlot()).toMatch(/^[a-z0-9]{1,24}$/);
    });
  });

  it("says a cancelled payroll's advance and a default account before an expense's description in English", () => {
    expect(memoText(`Avance rendue${NB}: la paie d'octobre 2026 est annulée`, "en")).toBe("Advance returned: the October 2026 payroll is cancelled");
    expect(memoText(`Avance rendue${NB}: la paie de mars 2027 est annulée`, "en")).toBe("Advance returned: the March 2027 payroll is cancelled");
    expect(memoText(`Avance rendue${NB}: la facture est annulée`, "en")).toBe("Advance returned: the bill is cancelled");
    expect(memoText(`Transport local${NB}: Transport des pièces au dépôt`, "en")).toBe("Local transport: Transport des pièces au dépôt");
    expect(memoText("Loyer", "en")).toBe("Rent");
    // A name nobody wrote for the shop stays as typed; French stays French.
    expect(memoText(`Garage Kasongo${NB}: Pièces`, "en")).toBe(`Garage Kasongo${NB}: Pièces`);
    expect(memoText(`Transport local${NB}: Transport des pièces au dépôt`, "fr")).toBe(`Transport local${NB}: Transport des pièces au dépôt`);
  });
});
