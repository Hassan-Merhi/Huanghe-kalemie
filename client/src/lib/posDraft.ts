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
  /**
   * Which cart it is, so a cart rung while another is offered is kept beside it, not over it: each opening of
   * the till rings under a slot of its own. None for a draft kept before slots (one per user and location).
   */
  slot?: string;
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

export const draftKey = (userId: number, locationId: number, slot?: string | null) => `${PREFIX}.${userId}.${locationId}${slot ? `.${slot}` : ""}`;

/** A slot for the cart of one opening of the till: short, and made without crypto (plain http on old phones). */
export const newSlot = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The same cart: same user, location and slot. */
export const sameDraft = (a: Pick<PosDraft, "userId" | "locationId" | "slot">, b: Pick<PosDraft, "userId" | "locationId" | "slot">) =>
  a.userId === b.userId && a.locationId === b.locationId && (a.slot ?? "") === (b.slot ?? "");

/**
 * Nothing worth keeping: no item. Payments typed into an empty cart are not a sale to come back to (they
 * were for the items taken out), so such a cart is never kept nor offered as "0 ligne".
 */
export function draftEmpty(d: Pick<PosDraft, "lines">): boolean {
  return d.lines.length === 0;
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
  if (d.slot !== undefined && (!str(d.slot) || !/^[a-z0-9]{1,24}$/.test(d.slot))) return null;
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
    if (draftEmpty(draft)) s?.removeItem(draftKey(draft.userId, draft.locationId, draft.slot));
    else s?.setItem(draftKey(draft.userId, draft.locationId, draft.slot), JSON.stringify(draft));
  } catch {
    /* full or blocked: the till still works, only without the draft */
  }
}

/** Hours after which a sale left unfinished is no longer announced in full, only from "Vente mise de côté". */
export const DRAFT_NAG_HOURS = 4;

const saleKey = (userId: number) => `hk.pos.lastSale.${userId}`;

/** Notes that the user completed a sale now: the sales left unfinished before it step back (see draftNags). */
export function noteSale(userId: number, at = Date.now()): void {
  try {
    storage()?.setItem(saleKey(userId), String(at));
  } catch {
    /* blocked storage: the draft is announced as before */
  }
}

/** When the user last completed a sale in this tab (ms), or null. */
export function lastSaleAt(userId: number): number | null {
  try {
    const v = Number(storage()?.getItem(saleKey(userId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Whether a sale left unfinished is announced in full (the amber banner) rather than from a small link: while
 * it is less than DRAFT_NAG_HOURS old and no sale has been completed since it was last saved. Nothing is lost
 * either way; an old draft only stops nagging through the day's work.
 */
export function draftNags(draft: Pick<PosDraft, "savedAt">, lastSale: number | null, now = Date.now()): boolean {
  if (now - draft.savedAt > DRAFT_NAG_HOURS * 3600_000) return false;
  return lastSale === null || draft.savedAt > lastSale;
}

export function removeDraft(userId: number, locationId: number, slot?: string | null): void {
  try {
    storage()?.removeItem(draftKey(userId, locationId, slot));
  } catch {
    /* blocked storage: nothing was kept */
  }
}

/**
 * Every sale the user left unfinished, those at that location first, then the latest first; `except` leaves
 * out the till's own cart (the one being rung). Only drafts stored under their own key count.
 */
export function listDrafts(userId: number, locationId: number | null, except?: Pick<PosDraft, "userId" | "locationId" | "slot"> | null): PosDraft[] {
  const s = storage();
  if (!s) return [];
  try {
    const out: PosDraft[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(`${PREFIX}.${userId}.`)) continue;
      const d = parseDraft(s.getItem(k), userId);
      if (!d || draftEmpty(d) || k !== draftKey(d.userId, d.locationId, d.slot) || (except && sameDraft(d, except))) continue;
      out.push(d);
    }
    return out.sort((a, b) => Number(b.locationId === locationId) - Number(a.locationId === locationId) || b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** The user's draft at that location, else the latest one they left at another location. */
export function findDraft(userId: number, locationId: number | null): PosDraft | null {
  return listDrafts(userId, locationId)[0] ?? null;
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
