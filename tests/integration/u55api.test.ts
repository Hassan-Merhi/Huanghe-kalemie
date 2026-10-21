import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";
import { JOURNAL_BLOCKED_KEYS, journalAccountAllowed, journalAccountBlocked } from "../../client/src/lib/labels";
import { SYSTEM_ACCOUNTS } from "../../server/services/ledger";

/**
 * U55: the Écriture account picker leaves out the accounts the server refuses on a manual entry (stock and goods
 * in transit), reading the same list; and the chassis-entry dialog marks a number already registered, as the
 * server's 409 says it.
 */
describe("fiftieth UI audit: the Écriture picker's rule", () => {
  it("blocks exactly the accounts manualJournal refuses", () => {
    expect([...JOURNAL_BLOCKED_KEYS].sort()).toEqual([SYSTEM_ACCOUNTS.goodsInTransit, SYSTEM_ACCOUNTS.inventory].sort());
    expect(journalAccountAllowed({ systemKey: "inventory" })).toBe(false);
    expect(journalAccountAllowed({ systemKey: "opening_equity" })).toBe(true);
    expect(journalAccountAllowed({ systemKey: null })).toBe(true);
    const fr = (_en: string, f: string) => f;
    expect(journalAccountBlocked({ name: "Stock de marchandises", systemKey: "inventory" }, fr)).toBe(
      "Stock de marchandises est tenu par le stock et les conteneurs. Utilisez un ajustement de stock ou l'écran des conteneurs.",
    );
    expect(journalAccountBlocked({ name: "Soldes d'ouverture", systemKey: "opening_equity" }, fr)).toBeNull();
    expect(journalAccountBlocked(undefined, fr)).toBeNull();
  });
});

describe.skipIf(!hasDb)("fiftieth UI audit: against the server", async () => {
  const { createApp } = await import("../../server/index");
  let server: Server;
  let base = "";
  let cookie = "";
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses every account the picker leaves out, and saves an entry the picker allows", async () => {
    const accounts = (await call<{ id: number; name: string; systemKey: string | null }[]>("GET", "/api/accounts")).body;
    const opening = accounts.find((a) => a.systemKey === "opening_equity")!;
    const other = accounts.find((a) => a.systemKey === "other_income")!;
    const blocked = accounts.filter((a) => !journalAccountAllowed(a));
    expect(blocked.map((a) => a.systemKey).sort()).toEqual(["goods_in_transit", "inventory"]);
    for (const a of blocked) {
      const r = await call("POST", "/api/journals", { date: today, memo: "Test", lines: [{ accountId: a.id, debit: "10" }, { accountId: opening.id, credit: "10" }] });
      expect(r.status).toBe(400);
      expect(r.body.messageFr).toBe(journalAccountBlocked(a, (_en, fr) => fr));
    }
    const ok = await call("POST", "/api/journals", { date: today, memo: "Test", lines: [{ accountId: opening.id, debit: "10" }, { accountId: other.id, credit: "10" }] });
    expect(ok.status).toBe(201);
  });
});
