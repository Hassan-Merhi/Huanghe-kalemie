import { readFileSync } from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, counters, journals, stockLevels, users } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phase A22: what the seventeenth accounting audit found after A21. */
describe.skipIf(!hasDb)("Guards found by the seventeenth audit", async () => {
  const { createApp } = await import("../../server/index");
  const { pool, transactionRetries, TRANSACTION_RETRIES } = await import("../../server/db");
  const ledger = await import("../../server/services/ledger");
  const ops = await import("../../server/services/operations");
  const backup = await import("../../server/services/backup");
  let db: Db;
  let server: Server;
  let base = "";
  const jar: Record<string, string> = {};
  async function call<T = any>(method: string, path: string, body?: unknown, who = "admin", key?: string): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(jar[who] ? { cookie: jar[who] } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) jar[who] = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const dayOffset = (n: number) => new Date(Date.now() + 2 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const today = dayOffset(0);
  let ownerId: number, cashUsd: number, cashCdf: number, openingEquity: number, payables: number, locationId: number, supplierId: number;

  async function item(name: string, unit = "pcs") {
    const p = await call("POST", "/api/products", { name, unit, variants: [{ attributes: {}, sellPrice: "20" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return p.body.variants[0].id as number;
  }
  /** Waits until some session waits on an advisory lock (the posting under test is blocked there). */
  async function untilWaiting(ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await pool.query("select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where d.datname = current_database() and l.locktype = 'advisory' and not l.granted");
      if (r.rows[0].n > 0) return;
      await sleep(20);
    }
    throw new Error("nothing waited on a lock");
  }
  const depositFc = { date: today, partyId: 0, accountId: 0, amount: "2808" };

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
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    await db.transaction((tx) =>
      ops.manualJournal(
        tx,
        {
          date: dayOffset(-1),
          memo: "Ouverture",
          type: "opening",
          lines: [
            { accountId: cashUsd, debit: "20000" },
            { accountId: cashCdf, debit: "20000", nativeAmount: "56160000", rate: "2808" },
            { accountId: openingEquity, credit: "40000" },
          ],
        },
        ownerId,
      ),
    );
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
    Object.assign(depositFc, { partyId: supplierId, accountId: cashCdf });
    // A franc deposit the supplier's next offloads use.
    expect((await call("POST", "/api/money/party-payment", { ...depositFc, amount: "2808000" })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("N1: a journal number holds no lock, so an offload applying a franc deposit and a franc deposit cannot deadlock", async () => {
    const before = transactionRetries.count;
    // The offload: its journal takes a number, then applying the deposit wants the supplier's franc balance.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let numbered!: () => void;
    const begun = new Promise<void>((r) => (numbered = r));
    let runs = 0;
    const offload = db.transaction(async (tx) => {
      runs++;
      await ledger.nextNumber(tx, "journal", "J-");
      numbered();
      await gate;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fx:${payables}|${supplierId}|CDF`}))`);
    });
    await begun;
    // A franc deposit to the same supplier: it takes the franc balance, then its number. It no longer
    // waits for the offload to commit.
    const deposit = await Promise.race([call("POST", "/api/money/party-payment", depositFc), sleep(3000).then(() => null)]);
    release();
    await offload;
    expect(deposit?.status, JSON.stringify(deposit)).toBe(201);
    expect(runs).toBe(1);
    expect(transactionRetries.count).toBe(before);

    // The routes themselves, side by side: every offload and deposit goes through at the first try.
    const v = await item("Boulon N1");
    const results = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const c = await call("POST", "/api/containers", { number: `N1-${i}`, supplierId, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
        expect((await call("PUT", `/api/containers/${c.body.id}/lines`, { lines: [{ variantId: v, quantity: "1", unitPrice: "7.1" }] })).status).toBe(200);
        const [fin, dep] = await Promise.all([call("POST", `/api/containers/${c.body.id}/finalize`, { offloadDate: today }), call("POST", "/api/money/party-payment", depositFc, "gerant")]);
        return [fin.status, dep.status];
      }),
    );
    expect(results.flat().every((s) => s < 300), JSON.stringify(results)).toBe(true);
    expect(transactionRetries.count).toBe(before);
  });

  it("N1: journal numbers keep their format and carry on after the counter the migration replaces", async () => {
    const n = await db.transaction((tx) => ledger.nextNumber(tx, "journal", "J-"));
    expect(n).toMatch(/^J-\d{6}$/);
    // The migration on books numbered by the counter (J-000040 given, J-000041 recorded by hand).
    await db.execute(sql`drop sequence journal_number_seq`);
    await db.insert(counters).values({ key: "journal", value: 40 }).onConflictDoUpdate({ target: counters.key, set: { value: 40 } });
    await db.insert(journals).values({ number: "J-000041", date: today, type: "manual", memo: "Saisie N1" });
    const file = readFileSync(path.resolve(process.cwd(), "migrations/0014_a22_journal_number_seq.sql"), "utf8");
    for (const stmt of file.split("--> statement-breakpoint")) await db.execute(sql.raw(stmt));
    expect(await db.transaction((tx) => ledger.nextNumber(tx, "journal", "J-"))).toBe("J-000042");
    expect(await db.select().from(counters).where(eq(counters.key, "journal"))).toEqual([]);
    // Other counters are untouched.
    expect(await db.transaction((tx) => ledger.nextNumber(tx, "sku", "HK-", 5))).toMatch(/^HK-\d{5}$/);
    await db.delete(journals).where(eq(journals.memo, "Saisie N1"));
  });

  it("N1: a backup made before the sequence restores with numbering carrying on after its journals", async () => {
    const text = await backup.takeSnapshot();
    const file = backup.parseBackup(text);
    // An older backup still has the counter row.
    const highest = Math.max(...(file.tables.journals as { number: string }[]).map((j) => Number(j.number.slice(2))));
    file.tables.counters = [...(file.tables.counters ?? []).filter((c) => c.key !== "journal"), { key: "journal", value: highest }];
    file.totals.rows.counters = file.tables.counters.length;
    await db.execute(sql`select setval('journal_number_seq', 1, false)`);
    await db.transaction((tx) => backup.restore(tx, file, { replace: true }));
    expect(await db.transaction((tx) => ledger.nextNumber(tx, "journal", "J-"))).toBe(`J-${String(highest + 1).padStart(6, "0")}`);
    // A posting after the restore gets a free number.
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    expect((await call("POST", "/api/money/party-payment", depositFc)).status).toBe(201);
  });

  it("N1: a deadlock or a serialization failure runs the transaction again, and an Idempotency-Key still posts once", async () => {
    const before = transactionRetries.count;
    // Another session holds the till's payment lock, then wants the till's franc balance that the
    // payment took: Postgres breaks the deadlock by failing the payment, which then runs again.
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query("set local deadlock_timeout = '10s'");
      await other.query("select pg_advisory_xact_lock(hashtext($1))", [`money:${cashCdf}`]);
      const key = `n1-retry-${Date.now()}`;
      const memo = `Dépôt N1 ${key}`;
      const pay = call("POST", "/api/money/party-payment", { ...depositFc, memo }, "gerant", key);
      await untilWaiting();
      await other.query("select pg_advisory_xact_lock(hashtext($1))", [`fx:${cashCdf}||CDF`]);
      await other.query("rollback");
      const first = await pay;
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(transactionRetries.count).toBe(before + 1);
      // The browser repeats the request: the same answer, nothing posted twice.
      const again = await call("POST", "/api/money/party-payment", { ...depositFc, memo }, "gerant", key);
      expect(again).toEqual(first);
      expect(await db.select({ id: journals.id }).from(journals).where(eq(journals.memo, memo))).toHaveLength(1);
    } finally {
      other.release();
    }

    // A serialization failure is run again too; a third retry that fails gives up; other errors are not retried.
    let tries = 0;
    await expect(
      db.transaction(async () => {
        if (++tries < 3) throw Object.assign(new Error("could not serialize access"), { code: "40001" });
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(tries).toBe(3);
    tries = 0;
    await expect(
      db.transaction(async () => {
        tries++;
        throw Object.assign(new Error("deadlock detected"), { cause: { code: "40P01" } });
      }),
    ).rejects.toThrow(/deadlock/);
    expect(tries).toBe(TRANSACTION_RETRIES + 1);
    tries = 0;
    await expect(
      db.transaction(async () => {
        tries++;
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }),
    ).rejects.toThrow(/duplicate/);
    expect(tries).toBe(1);
  });

  it("N2: a stock transfer dated after tomorrow is refused like any dated posting", async () => {
    const shop = (await call("POST", "/api/locations", { name: "Boutique N2" })).body.id;
    const v = await item("Chaîne N2");
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "x", lines: [{ variantId: v, qtyChange: "5", unitCost: "3" }] })).status).toBe(201);
    const at = async (loc: number) => {
      const [row] = await db.select({ qty: stockLevels.qty }).from(stockLevels).where(and(eq(stockLevels.variantId, v), eq(stockLevels.locationId, loc)));
      return Number(row?.qty ?? 0);
    };
    for (const date of ["2099-12-31", "2027-01-01", dayOffset(2)]) {
      for (const who of ["admin", "gerant"]) {
        const r = await call("POST", "/api/stock/transfers", { date, fromLocationId: locationId, toLocationId: shop, lines: [{ variantId: v, qty: "1" }] }, who);
        expect(r.status, `${date} ${who}`).toBe(400);
        expect(r.body.messageFr).toMatch(/dans le futur/);
      }
    }
    expect(await at(shop)).toBe(0);
    expect(await at(locationId)).toBe(5);
    // Tomorrow is the latest day allowed, as for every other posting.
    expect((await call("POST", "/api/stock/transfers", { date: dayOffset(1), fromLocationId: locationId, toLocationId: shop, lines: [{ variantId: v, qty: "1" }] }, "gerant")).status).toBe(201);
    expect((await call("POST", "/api/stock/transfers", { date: today, fromLocationId: locationId, toLocationId: shop, lines: [{ variantId: v, qty: "1" }] }, "gerant")).status).toBe(201);
    expect(await at(shop)).toBe(2);
  });

  it("N2: a pending voucher dated after tomorrow is refused when saved, not only when validated", async () => {
    const draft = (date: string, id?: number) =>
      call("POST", "/api/voucher-drafts", { ...(id ? { id } : {}), kind: "payment", date, memo: "Loyer", payload: { accountId: cashUsd, lines: [{ partyId: supplierId, amount: "1" }] } }, "gerant");
    for (const date of ["2099-12-31", "2027-01-01", dayOffset(2)]) {
      const r = await draft(date);
      expect(r.status, date).toBe(400);
      expect(r.body.messageFr).toMatch(/dans le futur/);
    }
    const saved = await draft(dayOffset(1));
    expect(saved.status).toBe(201);
    // Nor can a saved one be moved there.
    expect((await draft("2099-12-31", saved.body.id)).status).toBe(400);
    expect((await call<any[]>("GET", "/api/voucher-drafts")).body.filter((d) => d.date > dayOffset(1))).toEqual([]);
  });
});
