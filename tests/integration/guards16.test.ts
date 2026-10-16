import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, partners, users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

const NB = " ";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phase A21: what the sixteenth accounting audit found after A20 and U15. */
describe.skipIf(!hasDb)("Guards found by the sixteenth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const periods = await import("../../server/services/periods");
  let db: Db;
  let server: Server;
  let base = "";
  const jar: Record<string, string> = {};
  async function call<T = any>(method: string, path: string, body?: unknown, who = "admin"): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jar[who] ? { cookie: jar[who] } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) jar[who] = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const dayOffset = (n: number) => new Date(Date.now() + 2 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const today = dayOffset(0);
  let ownerId: number, cashUsd: number, cashCdf: number, expenseId: number, openingEquity: number, locationId: number, supplierId: number;

  async function item(name: string, unit = "pcs") {
    const p = await call("POST", "/api/products", { name, unit, variants: [{ attributes: {}, sellPrice: "20" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return p.body.variants[0].id as number;
  }
  async function container(currency = "USD", number = `C-${Math.random().toString(36).slice(2, 10)}`) {
    const c = await call("POST", "/api/containers", { number, supplierId, locationId, currency, status: "arrived", ...(currency === "CNY" ? { rateToUsd: "0.14" } : {}) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    return c.body.id as number;
  }

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    expenseId = accs.find((a) => a.code === "6090")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    await db.transaction((tx) =>
      ops.manualJournal(
        tx,
        {
          date: "2026-08-01",
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "20000" },
            { accountId: cashCdf, debit: "3600", nativeAmount: "10080000", rate: "2800" },
            { accountId: openingEquity, credit: "23600" },
          ],
        },
        ownerId,
      ),
    );
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
  });

  afterAll(() => {
    server?.close();
  });

  const francsIn = async (accountId: number) => {
    const [r] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)` }).from(journalLines).where(eq(journalLines.accountId, accountId));
    return Number(r.v);
  };

  it("F1: validating posts only the version the owner saw, and franc drafts show their dollar value", async () => {
    const x = (await call("POST", "/api/parties", { type: "customer", name: "Client X" })).body.id;
    // The manager could not pay this out directly.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: [{ partyId: x, amount: "1000000" }] }, "gerant")).status).toBe(403);
    const saved = await call("POST", "/api/voucher-drafts", { kind: "payment", date: today, memo: "Remboursement", payload: { accountId: cashCdf, lines: [{ partyId: x, amount: "2808" }] } }, "gerant");
    expect(saved.status).toBe(201);
    const seen = (await call<any[]>("GET", "/api/voucher-drafts")).body.find((d) => d.id === saved.body.id);
    // 2 808 FC at 2 800 FC for 1 $.
    expect(seen.totalUsd).toBe("1.00");
    // The manager changes it after the owner looked.
    const changed = await call("POST", "/api/voucher-drafts", { id: saved.body.id, kind: "payment", date: "2026-10-01", memo: "Remboursement", payload: { accountId: cashCdf, lines: [{ partyId: x, amount: "1000000" }] } }, "gerant");
    expect(changed.status).toBe(200);
    expect(changed.body.updatedAt).not.toBe(seen.updatedAt);
    const before = await francsIn(cashCdf);
    const stale = await call("POST", `/api/voucher-drafts/${saved.body.id}/finalize`, { updatedAt: seen.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.messageFr).toMatch(/modifiée après son ouverture/);
    // No version at all is refused the same way.
    expect((await call("POST", `/api/voucher-drafts/${saved.body.id}/finalize`)).status).toBe(409);
    expect(await francsIn(cashCdf)).toBe(before);
    // The owner reviews the new version and validates it, with the owner's rights.
    const fresh = (await call<any[]>("GET", "/api/voucher-drafts")).body.find((d) => d.id === saved.body.id);
    expect(fresh.totalUsd).toBe("357.14");
    const ok = await call("POST", `/api/voucher-drafts/${saved.body.id}/finalize`, { updatedAt: fresh.updatedAt });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await francsIn(cashCdf)).toBe(before - 1000000);
  });

  it("F2: container numbers differing only by Unicode spaces, invisible marks or dashes are one, even typed at once", async () => {
    expect((await call("POST", "/api/containers", { number: `HHN${NB}777`, supplierId, locationId, currency: "USD" })).status).toBe(201);
    for (const variant of ["HHN 777", "HHN777", "HHN​777", "hhn–777", "HHN−777", "HHN　777", "ＨＨＮ777", "HHN 7﻿77"]) {
      const r = await call("POST", "/api/containers", { number: variant, supplierId, locationId, currency: "USD" });
      expect(r.status, variant).toBe(409);
      expect(r.body.code).toBe("DUPLICATE_NUMBER");
    }
    const tries = await Promise.all(["X-1", "X 1", "X.1", "X/1", "X_1", "X1"].map((n) => call("POST", "/api/containers", { number: `HHC${n}`, supplierId, locationId, currency: "USD" })));
    expect(tries.map((t) => t.status).filter((s) => s === 201)).toHaveLength(1);
    expect(tries.filter((t) => t.status !== 201).every((t) => t.status === 409)).toBe(true);
    // A rename is checked the same way.
    const other = await container("USD", "HHR-1");
    expect((await call("PATCH", `/api/containers/${other}`, { number: `hhn${NB}–777` })).status).toBe(409);
    expect((await call("PATCH", `/api/containers/${other}`, { number: "HHR 1" })).status).toBe(200);
  });

  it("F3: import prices refuse another currency's mark, hex, exponents and prices or lines worth nothing", async () => {
    const bolt = "Boulon IMP";
    const imp = (c: number, unitPrice: unknown, quantity: unknown = 3) => call("POST", `/api/containers/${c}/import-lines`, { mode: "replace", rows: [{ name: bolt, unit: "pcs", quantity, unitPrice }] });
    const usd = await container("USD");
    const francs = await imp(usd, "28 000 FC");
    expect(francs.status).toBe(422);
    expect(francs.body.messageFr).toMatch(/en francs, mais ce conteneur est en dollars US/);
    expect((await imp(usd, "12,50 $")).status).toBe(200);
    const cny = await container("CNY");
    expect((await imp(cny, "5 USD")).status).toBe(422);
    expect((await imp(cny, "5 ¥")).status).toBe(200);
    for (const text of ["0x10", "1e3", "1.5e3", "Infinity", "12,50 €"]) {
      const r = await imp(usd, text);
      expect(r.status, text).toBe(422);
    }
    // A JSON number is taken as it is.
    expect((await imp(usd, 1000)).status).toBe(200);
    // Below a millionth, or a line worth under half a cent, would be booked as nothing.
    expect((await imp(usd, 1e-7)).status).toBe(422);
    expect((await imp(usd, "0,001", 1)).status).toBe(422);
    expect((await call("PUT", `/api/containers/${usd}/lines`, { lines: [{ variantId: (await call<any>("GET", `/api/containers/${usd}`)).body.lines[0].variantId, quantity: "1", unitPrice: "0.0000001" }] })).status).toBe(422);
    // Item prices and opening costs are in dollars.
    expect((await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Rondelle IMP", unit: "pcs", qty: "3", unitCost: "350 FC" }] })).status).toBe(422);
    const wire = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Fil IMP", unit: "m", qty: 0.333, unitCost: 0.01 }] });
    expect(wire.status).toBe(422);
    expect(wire.body.messageFr).toMatch(/moins d'un centime/);
    const v = await item("Fil direct", "m");
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "0.333", unitCost: "0.01" }] })).status).toBe(422);
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "3", unitCost: "0.0000001" }] })).status).toBe(422);
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "3", unitCost: "0.01" }] })).status).toBe(201);
  });

  it("F4: an offload or a cancelled sale locks its items before its journal, so it cannot deadlock with a sale", async () => {
    const v = await item("Pneu ST");
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "10", unitCost: "5" }] })).status).toBe(201);
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId: v, qty: "1", unitPrice: "20" }], payments: [{ accountId: cashUsd, amount: "20" }] });
    expect(sale.status).toBe(201);
    const c = await container("USD");
    expect((await call("PUT", `/api/containers/${c}/lines`, { lines: [{ variantId: v, quantity: "2", unitPrice: "10" }] })).status).toBe(200);

    // A sale of the item: it holds the item's row, then wants the journal number.
    const race = async (other: () => Promise<{ status: number; body: unknown }>) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started!: () => void;
      const begun = new Promise<void>((r) => (started = r));
      const seller = db.transaction(async (tx) => {
        await tx.execute(sql`select id from variants where id = ${v} for update`);
        started();
        await gate;
        await ledger.nextNumber(tx, "journal", "J-");
      });
      await begun;
      const second = other();
      await sleep(400);
      release();
      const [a, b] = await Promise.allSettled([seller, second]);
      expect(a.status).toBe("fulfilled");
      expect(b.status === "fulfilled" && b.value.status, JSON.stringify(b)).toBe(200);
    };
    await race(() => call("POST", `/api/containers/${c}/finalize`, { offloadDate: today }));
    await race(() => call("POST", `/api/sales/${sale.body.id}/void`, { reason: "Erreur", date: today }));
  });

  it("F5: numbers beyond what the books hold are a 400, on every route", async () => {
    const B = "999999999999999999";
    const v = await item("Grand nombre");
    const c = await container("USD");
    const partnerId = (await db.select().from(partners))[0].id;
    const customer = (await call("POST", "/api/parties", { type: "customer", name: "Client grand" })).body.id;
    const tries: [string, string, string, unknown][] = [
      ["container lines", "PUT", `/api/containers/${c}/lines`, { lines: [{ variantId: v, quantity: "1", unitPrice: B }] }],
      ["found quantity", "POST", "/api/stock/adjustments", { date: today, locationId, kind: "found", reason: "x", lines: [{ variantId: v, qtyChange: B, unitCost: "1" }] }],
      ["opening cost", "POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "1", unitCost: B }] }],
      ["rate", "POST", "/api/exchange-rates", { date: today, cdfPerUsd: B }],
      ["rate a trillion", "POST", "/api/exchange-rates", { date: today, cdfPerUsd: "999999999999" }],
      ["imported 1e15", "POST", `/api/containers/${c}/import-lines`, { mode: "replace", rows: [{ name: "Grand nombre", quantity: 1, unitPrice: 1e15 }] }],
      ["imported 1e21", "POST", `/api/containers/${c}/import-lines`, { mode: "replace", rows: [{ name: "Grand nombre", quantity: 1, unitPrice: 1e21 }] }],
      ["voucher", "POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ partyId: customer, amount: B }] }],
      ["contribution", "POST", "/api/money/partner-contribution", { date: today, partnerId, accountId: cashUsd, amount: B }],
      ["transfer", "POST", "/api/money/transfer", { date: today, fromAccountId: cashUsd, fromAmount: B, toAccountId: cashCdf, toAmount: B }],
      ["journal", "POST", "/api/journals", { date: today, memo: "x", lines: [{ accountId: expenseId, debit: B }, { accountId: openingEquity, credit: B }] }],
    ];
    for (const [what, method, path, body] of tries) {
      const r = await call(method, path, body);
      expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.code, what).toBe("VALIDATION");
    }
    // Two inputs each within bounds whose product no column holds: still a 400.
    expect((await call("PUT", `/api/containers/${c}/lines`, { lines: [{ variantId: v, quantity: "999999999999", unitPrice: "999999999999" }] })).status).toBe(200);
    const big = await call("POST", `/api/containers/${c}/finalize`, { offloadDate: today });
    expect(big.status, JSON.stringify(big.body)).toBe(400);
    expect(big.body.code).toBe("VALIDATION");
  });

  it("refuses a stock transfer dated in a closed month", async () => {
    const shop = (await call("POST", "/api/locations", { name: "Dépôt 2" })).body.id;
    const v = await item("Chaîne");
    expect((await call("POST", "/api/stock/adjustments", { date: "2026-08-02", locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "5", unitCost: "3" }] })).status).toBe(201);
    await db.transaction((tx) => periods.closePeriod(tx, "2026-08", ownerId));
    const r = await call("POST", "/api/stock/transfers", { date: "2026-08-20", fromLocationId: locationId, toLocationId: shop, lines: [{ variantId: v, qty: "1" }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("PERIOD_CLOSED");
    expect((await call("POST", "/api/stock/transfers", { date: today, fromLocationId: locationId, toLocationId: shop, lines: [{ variantId: v, qty: "1" }] })).status).toBe(201);
  });
});
