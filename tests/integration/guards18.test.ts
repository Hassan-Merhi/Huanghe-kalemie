import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, auditLog, users } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phase A23: what the eighteenth accounting audit found after A22. */
describe.skipIf(!hasDb)("Guards found by the eighteenth audit", async () => {
  const { createApp } = await import("../../server/index");
  const { pool } = await import("../../server/db");
  const ledger = await import("../../server/services/ledger");
  const backup = await import("../../server/services/backup");
  const vouchers = await import("../../server/services/vouchers");
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
  let ownerId: number, cashUsd: number, cashCdf: number, openingEquity: number, payables: number, rentId: number, locationId: number;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  async function item(name: string) {
    const p = await call("POST", "/api/products", { name: `${name} ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "20" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return p.body.variants[0].id as number;
  }
  async function supplier(name: string) {
    const r = await call("POST", "/api/parties", { type: "supplier", name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** An arrived container of ten pieces: 710 CNY or 280 800 FC, 100 $ either way. */
  async function container(supplierId: number, currency: "CNY" | "CDF") {
    const c = await call("POST", "/api/containers", {
      number: `A23-${currency}-${uniq()}`,
      supplierId,
      locationId,
      currency,
      rateToUsd: currency === "CNY" ? "0.140845" : String(1 / 2808),
      status: "arrived",
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const lines = [{ variantId: await item(`Pièce ${currency}`), quantity: "10", unitPrice: currency === "CNY" ? "71" : "28080" }];
    expect((await call("PUT", `/api/containers/${c.body.id}/lines`, { lines })).status).toBe(200);
    return c.body.id as number;
  }
  /** A contact's payables balance in one currency: native and USD, positive when paid ahead. */
  async function balance(partyId: number, currency: string) {
    const r = await pool.query(
      "select coalesce(sum(native_amount), 0)::numeric(20,2)::text as native, coalesce(sum(debit - credit), 0)::numeric(20,2)::text as usd from journal_lines where account_id = $1 and party_id = $2 and currency = $3",
      [payables, partyId, currency],
    );
    return r.rows[0] as { native: string; usd: string };
  }
  /** Waits until `count` sessions wait on an advisory lock. */
  async function untilWaiting(count = 1, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await pool.query("select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where d.datname = current_database() and l.locktype = 'advisory' and not l.granted");
      if (r.rows[0].n >= count) return;
      await sleep(20);
    }
    throw new Error(`fewer than ${count} sessions waited on a lock`);
  }
  /**
   * Runs the requests together: another session holds the periods lock alone (as a month close does)
   * until each of them waits on it, then lets them all go at once.
   */
  async function together<T>(requests: (() => Promise<T>)[], waiters = requests.length): Promise<T[]> {
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtext('periods:close'))");
      const running = requests.map((r) => r());
      await untilWaiting(waiters);
      await other.query("rollback");
      return await Promise.all(running);
    } finally {
      other.release();
    }
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
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    rentId = accs.find((a) => a.type === "expense")!.id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    expect(
      (
        await call("POST", "/api/journals", {
          date: dayOffset(-1),
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "20000" },
            { accountId: cashCdf, debit: "20000", nativeAmount: "56160000", rate: "2808" },
            { accountId: openingEquity, credit: "40000" },
          ],
        })
      ).status,
    ).toBeLessThan(300);
  });

  afterAll(() => {
    server?.close();
  });

  it("F1: every bill that applies a deposit, and every payment, waits for the contact's balance", async () => {
    // Each takes the supplier's balance before reading it; another posting holds it here.
    const postings: [string, (sup: number) => Promise<() => Promise<{ status: number }>>][] = [
      ["yuan offload", async (sup) => {
        const id = await container(sup, "CNY");
        return () => call("POST", `/api/containers/${id}/finalize`, { offloadDate: today }, "gerant");
      }],
      ["franc offload", async (sup) => {
        const id = await container(sup, "CDF");
        return () => call("POST", `/api/containers/${id}/finalize`, { offloadDate: today }, "gerant");
      }],
      ["franc expense", async (sup) => () => call("POST", "/api/expenses", { date: today, accountId: rentId, description: "Loyer A23", amount: "280800", currency: "CDF", payablePartyId: sup }, "gerant")],
      ["franc container cost", async (sup) => {
        const id = await container(sup, "CDF");
        return () => call("POST", `/api/containers/${id}/expenses`, { date: today, type: "transport", amount: "280800", currency: "CDF", method: "value", payablePartyId: sup }, "gerant");
      }],
      ["payment", async (sup) => () => call("POST", "/api/money/party-payment", { date: today, partyId: sup, accountId: cashUsd, amount: "10" }, "gerant")],
    ];
    for (const [label, prepare] of postings) {
      const sup = await supplier(`Fournisseur verrou ${label}`);
      expect((await call("POST", "/api/money/party-payment", { date: today, partyId: sup, accountId: cashUsd, amount: "150" })).status).toBe(201);
      const post = await prepare(sup);
      const other = await pool.connect();
      try {
        await other.query("begin");
        await other.query("select pg_advisory_xact_lock(hashtext($1))", [`party:${sup}`]);
        const done = post();
        await untilWaiting().catch(() => {
          throw new Error(`${label} did not wait for the supplier's balance`);
        });
        await other.query("rollback");
        expect((await done).status, label).toBeLessThan(300);
      } finally {
        other.release();
      }
    }
  });

  it("F1: a 150 $ deposit is applied once when a yuan bill and a franc bill post together", async () => {
    // The franc bill: an offload, an expense owed in francs, a container cost owed in francs.
    const francBills: [string, (sup: number) => Promise<() => Promise<{ status: number }>>][] = [
      ["offload", async (sup) => {
        const id = await container(sup, "CDF");
        return () => call("POST", `/api/containers/${id}/finalize`, { offloadDate: today }, "gerant");
      }],
      ["expense", async (sup) => () => call("POST", "/api/expenses", { date: today, accountId: rentId, description: "Loyer A23", amount: "280800", currency: "CDF", payablePartyId: sup }, "gerant")],
      ["container cost", async (sup) => {
        const id = await container(sup, "CDF");
        return () => call("POST", `/api/containers/${id}/expenses`, { date: today, type: "transport", amount: "280800", currency: "CDF", method: "value", payablePartyId: sup }, "gerant");
      }],
    ];
    for (const [label, francBill] of francBills) {
      for (let round = 0; round < 3; round++) {
        const sup = await supplier(`Fournisseur ${label}`);
        expect((await call("POST", "/api/money/party-payment", { date: today, partyId: sup, accountId: cashUsd, amount: "150" })).status).toBe(201);
        const cny = await container(sup, "CNY");
        const franc = await francBill(sup);
        const results = await together([() => call("POST", `/api/containers/${cny}/finalize`, { offloadDate: today }), franc]);
        expect(results.map((r) => r.status < 300), `${label} ${JSON.stringify(results)}`).toEqual([true, true]);
        // 150 $ taken once: none of it left, and no dollars owed that nobody billed.
        const applied = await pool.query(
          "select coalesce(sum(l.credit), 0)::numeric(20,2)::text as usd from journals j join journal_lines l on l.journal_id = j.id where j.source_type like 'advance_%' and l.party_id = $1 and l.currency = 'USD'",
          [sup],
        );
        expect(applied.rows[0].usd, label).toBe("150.00");
        expect((await balance(sup, "USD")).usd, label).toBe("0.00");
        // What is still owed: 50 $ of one bill, in its own currency.
        const left = [await balance(sup, "CNY"), await balance(sup, "CDF")].map((b) => b.usd).sort();
        expect(left, label).toEqual(["-50.00", "0.00"]);
      }
    }
  });

  it("F3: two 80 $ payments against 710 CNY settle the yuan once and leave a 60 $ advance", async () => {
    for (let round = 0; round < 3; round++) {
      const sup = await supplier("Fournisseur F3");
      const cny = await container(sup, "CNY");
      expect((await call("POST", `/api/containers/${cny}/finalize`, { offloadDate: today })).status).toBe(200);
      const pay = (who: string) => () => call("POST", "/api/money/party-payment", { date: today, partyId: sup, accountId: cashUsd, amount: "80" }, who);
      const results = await together([pay("admin"), pay("gerant")]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect((await balance(sup, "CNY")).native).toBe("0.00");
      expect((await balance(sup, "CNY")).usd).toBe("0.00");
      expect((await balance(sup, "USD")).usd).toBe("60.00");
    }
  });

  it("F2: a restore that fails leaves the journal numbers (and ids) where they were", async () => {
    // A few postings, so the sequence is past what the backup holds.
    const file = backup.parseBackup(await backup.takeSnapshot());
    for (let i = 0; i < 3; i++) expect((await call("POST", "/api/money/party-payment", { date: today, partyId: await supplier("F2"), accountId: cashUsd, amount: "1" })).status).toBe(201);
    const seqs = async () =>
      (
        await pool.query(
          "select (select last_value from journal_number_seq) as journal, (select last_value from journals_id_seq) as journals, (select last_value from audit_log_id_seq) as audit",
        )
      ).rows[0];
    const before = await seqs();
    // A tampered file: one line's amount changed, the totals kept.
    const lines = file.tables.journal_lines as { debit: string }[];
    const tampered = lines.find((l) => Number(l.debit) > 0)!;
    tampered.debit = (Number(tampered.debit) + 1).toFixed(2);
    for (const replace of [true, false]) {
      await expect(db.transaction((tx) => backup.restore(tx, file, { replace }))).rejects.toThrow(/does not match|has data/);
    }
    expect(await seqs()).toEqual(before);
    // The next postings get new numbers, not ones already given.
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/api/money/party-payment", { date: today, partyId: await supplier("F2 après"), accountId: cashUsd, amount: "1" }, "gerant");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const next = await db.transaction((tx) => ledger.nextNumber(tx, "journal", "J-"));
    expect(Number(next.slice(2))).toBeGreaterThan(Number(before.journal));
  });

  it("F4: a validated count that changed nothing names its preparer on the count, not on another journal", async () => {
    const v = await item("Boulon F4");
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture F4", lines: [{ variantId: v, qtyChange: "10", unitCost: "5" }] })).status).toBe(201);
    const draft = await call("POST", "/api/voucher-drafts", { kind: "adjustment", date: today, payload: { date: today, locationId, kind: "count", reason: "Inventaire F4", lines: [{ variantId: v, qtyChange: "0" }] } }, "gerant");
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const fin = await call("POST", `/api/voucher-drafts/${draft.body.id}/finalize`, { updatedAt: draft.body.updatedAt });
    expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
    const adj = fin.body.result;
    expect(adj.journalId).toBeNull();
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, "prepare"), sql`${auditLog.data}->>'draftId' = ${String(draft.body.id)}`));
    expect(rows.map((r) => [r.entity, r.entityId])).toEqual([["stock_adjustment", adj.id]]);
    // The journal that happens to have the count's id is not shown as prepared by the manager.
    expect((await vouchers.preparedBy(db, [adj.id])).size).toBe(0);
  });

  it("F5: a cancelled sale's franc rounding nets to zero in the sales list", async () => {
    const v = await item("Pneu F5");
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture F5", lines: [{ variantId: v, qtyChange: "2", unitCost: "10" }] })).status).toBe(201);
    // 27 $ paid with 75 900 FC (75 816 FC due): 0,03 $ kept as rounding.
    const sale = await call("POST", "/api/sales", { date: today, locationId, lines: [{ variantId: v, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75900" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const row = async () => (await call<any[]>("GET", "/api/sales")).body.find((r) => r.id === sale.body.id);
    expect((await row()).fcRoundingUsd).toBe("0.03");
    expect((await call("POST", `/api/sales/${sale.body.id}/void`, { reason: "Erreur de saisie" })).status).toBe(200);
    expect((await row()).fcRoundingUsd).toBe("0.00");
  });

  it("keeps every service's locks in one order", async () => {
    // Each route takes contacts after items and before franc and money locks (see lockBalances). The
    // strict mode fails a lock taken out of that order; this runs the flows above under it once more.
    process.env.HK_LOCK_ORDER = "strict";
    try {
      const sup = await supplier("Fournisseur ordre");
      expect((await call("POST", "/api/money/party-payment", { date: today, partyId: sup, accountId: cashCdf, amount: "280800" })).status).toBe(201);
      expect((await call("POST", `/api/containers/${await container(sup, "CDF")}/finalize`, { offloadDate: today })).status).toBe(200);
      expect((await call("POST", `/api/containers/${await container(sup, "CNY")}/finalize`, { offloadDate: today })).status).toBe(200);
      expect((await call("POST", "/api/money/party-payment", { date: today, partyId: sup, accountId: cashCdf, amount: "140400" }, "gerant")).status).toBe(201);
      const voucher = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: sup, amount: "5" }, { partyId: await supplier("Autre"), amount: "5" }] }, "gerant");
      expect(voucher.status, JSON.stringify(voucher.body)).toBeLessThan(300);
    } finally {
      delete process.env.HK_LOCK_ORDER;
    }
  });
});
