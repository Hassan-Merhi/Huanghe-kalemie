/**
 * The till's sale in progress, kept in the tab's sessionStorage for one user at one location, so opening
 * Ventes or reloading on a cheap phone does not throw away a half-rung sale. It is only a draft: on resuming,
 * the till reads the items, their stock and prices and the day's rate again, and the server checks the sale
 * as usual (a stale franc rate is still refused).
 */
export const DRAFT_VERSION = 1;
const PREFIX = "hk.pos.draft";

export interface DraftLine {
  /** The item as the till last read it; its price and cost are read again on resuming. */
  variant: { id: number; sellPrice: string; productName?: string; unit?: string | null };
  unitId: number | null;
  qty: string;
  unitPrice: string;
  lineDiscount: string;
}

export interface DraftPay {
  accountId: number | null;
  amount: string;
  rate: string | null;
}

export interface PosDraft {
  v: number;
  userId: number;
  locationId: number;
  /** When it was last saved (ms), and the day and franc rate the till worked with then. */
  savedAt: number;
  day: string;
  cdfRate: string;
  lines: DraftLine[];
  discount: string;
  customerId: number | null;
  customer: { id: number } | null;
  note: string;
  pays: DraftPay[];
  changeAccId: number | null;
  changeAmt: string;
  francsChosen: boolean;
}

export const draftKey = (userId: number, locationId: number) => `${PREFIX}.${userId}.${locationId}`;

/** Nothing worth keeping: no item and no payment typed. */
export function draftEmpty(d: Pick<PosDraft, "lines" | "pays">): boolean {
  return d.lines.length === 0 && !d.pays.some((p) => p.amount.trim() !== "");
}

const str = (x: unknown): x is string => typeof x === "string";
const idOrNull = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isInteger(x) && x > 0);

/**
 * A stored draft read back, or null when it is not one this till wrote for that user (another version, a
 * hand-edited value, a broken JSON): a draft that cannot be trusted is dropped, never half restored.
 */
export function parseDraft(text: string | null | undefined, userId: number): PosDraft | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== DRAFT_VERSION || d.userId !== userId || !idOrNull(d.locationId) || d.locationId === null) return null;
  if (typeof d.savedAt !== "number" || !str(d.day) || !str(d.cdfRate) || !str(d.discount) || !str(d.note) || !str(d.changeAmt)) return null;
  if (!idOrNull(d.customerId) || !idOrNull(d.changeAccId) || typeof d.francsChosen !== "boolean") return null;
  if (d.customer !== null && (typeof d.customer !== "object" || (d.customer as { id?: unknown }).id !== d.customerId)) return null;
  if (!Array.isArray(d.lines) || !Array.isArray(d.pays)) return null;
  for (const l of d.lines as Record<string, unknown>[]) {
    if (!l || typeof l !== "object" || !l.variant || typeof l.variant !== "object") return null;
    const v = l.variant as Record<string, unknown>;
    if (!idOrNull(v.id) || v.id === null || !str(v.sellPrice)) return null;
    if (!idOrNull(l.unitId) || !str(l.qty) || !str(l.unitPrice) || !str(l.lineDiscount)) return null;
  }
  for (const p of d.pays as Record<string, unknown>[]) {
    if (!p || typeof p !== "object" || !idOrNull(p.accountId) || !str(p.amount) || !(p.rate === null || str(p.rate))) return null;
  }
  return d as unknown as PosDraft;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Saves the draft, or removes it once the cart is empty. Storage that is full or blocked is simply skipped. */
export function saveDraft(draft: PosDraft): void {
  const s = storage();
  try {
    if (draftEmpty(draft)) s?.removeItem(draftKey(draft.userId, draft.locationId));
    else s?.setItem(draftKey(draft.userId, draft.locationId), JSON.stringify(draft));
  } catch {
    /* full or blocked: the till still works, only without the draft */
  }
}

export function removeDraft(userId: number, locationId: number): void {
  try {
    storage()?.removeItem(draftKey(userId, locationId));
  } catch {
    /* blocked storage: nothing was kept */
  }
}

/** The user's draft at that location, else the latest one they left at another location. */
export function findDraft(userId: number, locationId: number | null): PosDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    if (locationId) {
      const here = parseDraft(s.getItem(draftKey(userId, locationId)), userId);
      if (here && !draftEmpty(here)) return here;
    }
    let best: PosDraft | null = null;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(`${PREFIX}.${userId}.`)) continue;
      const d = parseDraft(s.getItem(k), userId);
      if (d && !draftEmpty(d) && (!best || d.savedAt > best.savedAt)) best = d;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * On resuming, a line's price is the item's new list price when it was sold at the old one (the list price
 * changed since): a price typed by hand is kept as typed. Returns the line's price and whether it changed.
 */
export function resumedPrice(line: Pick<DraftLine, "unitPrice">, oldList: string, newList: string): { unitPrice: string; changed: boolean } {
  const n = (x: string) => (x.trim() === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  const typed = n(line.unitPrice);
  const was = n(oldList);
  const now = n(newList);
  if (typed === null || was === null || now === null || was === now || Math.abs(typed - was) > 0.0001) return { unitPrice: line.unitPrice, changed: false };
  return { unitPrice: now.toFixed(2), changed: true };
}
