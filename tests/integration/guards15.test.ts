import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals, users } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

const NB = " ";

/** Phase A20: what the fifteenth accounting audit found after A19 and U14. */
describe.skipIf(!hasDb)("Guards found by the fifteenth audit", async () => {
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
  let ownerId: number, cashUsd: number, cashCdf: number, inventory: number, expenseId: number, locationId: number;

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
    inventory = accs.find((a) => a.systemKey === "inventory")!.id;
    expenseId = accs.find((a) => a.code === "6090")!.id;
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800" })).status).toBeLessThan(300);
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
            { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "23600" },
          ],
        },
        ownerId,
      ),
    );
  });

  afterAll(() => {
    server?.close();
  });

  const usdOn = async (accountId: number) => {
    const [r] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` }).from(journalLines).where(eq(journalLines.accountId, accountId));
    return r.v;
  };

  it("N1: a close waits for the postings and rates under way in its month, and later ones find it closed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    // A manager's expense and the owner's month-end rate, both under way when the owner closes August.
    const inFlight = db.transaction(async (tx) => {
      await ledger.setExchangeRate(tx, { date: "2026-08-31", cdfPerUsd: "2900" }, ownerId);
      await ledger.postJournal(tx, { date: "2026-08-31", type: "expense", memo: "Clous", userId: ownerId, lines: [{ accountId: expenseId, debit: "1.11" }, { accountId: cashUsd, credit: "1.11" }] });
      started();
      await gate;
    });
    await begun;
    const close = db.transaction((tx) => periods.closePeriod(tx, "2026-08", ownerId));
    await new Promise((r) => setTimeout(r, 300));
    // Started while the close is under way: it waits, then finds August closed.
    const late = db
      .transaction((tx) => ledger.postJournal(tx, { date: "2026-08-30", type: "expense", memo: "Vis", userId: ownerId, lines: [{ accountId: expenseId, debit: "1.11" }, { accountId: cashUsd, credit: "1.11" }] }))
      .then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));
    release();
    await inFlight;
    const result = await close;
    // The expense is in the close, split on the partner who bears running costs.
    expect(result.totals.operatingExpenses).toBe("1.11");
    // And the francs were revalued at the month-end rate saved during the close: 10 080 000 FC / 2900.
    expect(await usdOn(cashCdf)).toBe("3475.86");
    expect(await late).toMatchObject({ status: 409, code: "PERIOD_CLOSED" });
    // Nothing dated in August is left outside the close.
    const outside = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journals)
      .where(and(sql`${journals.date} between '2026-08-01' and '2026-08-31'`, sql`${journals.createdAt} > (select closed_at from periods where month = '2026-08')`));
    expect(outside[0].n).toBe(0);
  });

  it("N2: imports book unit prices and costs as the preview showed them, and refuse what could be thousands", async () => {
    // "0.125" (a bolt at 0,125 $) is never a thousands group: 100 bolts are 12,50 $ of opening stock, not 12 500 $.
    const before = Number(await usdOn(inventory));
    const bolts = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Boulon M6", unit: "pcs", qty: "100", unitCost: "0.125" }] });
    expect(bolts.status, JSON.stringify(bolts.body)).toBe(201);
    expect(Number(await usdOn(inventory)) - before).toBeCloseTo(12.5, 2);
    // More decimals than a thousands group can have are decimals too.
    const washers = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Rondelle", unit: "pcs", qty: "1000", unitCost: "0.0049" }] });
    expect(washers.status, JSON.stringify(washers.body)).toBe(201);
    expect(Number(await usdOn(inventory)) - before).toBeCloseTo(17.4, 2);

    const supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
    const c = await call("POST", "/api/containers", { number: "HHU-15", supplierId, locationId, currency: "USD" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    // A number cell comes from the browser as a JSON number: 4.125 stays 4,125.
    const exact = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Écrou M8", unit: "pcs", quantity: "200", unitPrice: 4.125 }] });
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    expect(Number(exact.body.container.lines[0].unitPrice)).toBe(4.125);
    // Typed text that could be 4 125 or 4,125 is refused, not guessed (U29: "4,125" too).
    for (const typed of ["4.125", "4,125"]) {
      const unsure = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Écrou M8", unit: "pcs", quantity: "200", unitPrice: typed }] });
      expect(unsure.status, typed).toBe(422);
      // Both readings say what to do: 4125 without the separator, or 4,125 as a number cell.
      expect(unsure.body.messageFr).toBe(`«${NB}${typed}${NB}»${NB}: 4${NB}125 ou 4,125${NB}? Pour 4${NB}125, écrivez 4125 sans séparateur${NB}; pour 4,125, écrivez-le comme nombre dans Excel.`);
    }
    expect((await call("POST", "/api/import/prices", { rows: [{ sku: "X", sellPrice: "1.200" }] })).status).toBe(422);
    // "1,000" kilos or pieces sent as it is (1 000 or 1?) is refused like "1.000".
    const kilos = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Écrou M8", unit: "pcs", quantity: "2", unitPrice: "1", weightKg: "1,000" }] });
    expect(kilos.status).toBe(422);
    expect(kilos.body.messageFr).toBe(`«${NB}1,000${NB}»${NB}: 1${NB}000 ou 1${NB}? Écrivez-le sans la virgule.`);
    expect((await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Écrou M8", unit: "pcs", quantity: "1,000", unitPrice: "1" }] })).status).toBe(422);
    // The container still holds only the exact line.
    expect((await call("GET", `/api/containers/${c.body.id}`)).body.lines).toHaveLength(1);
  });

  it("N2: the browser sends number cells as JSON numbers and asks about ambiguous text", async () => {
    const { amountCellUnsure, readNumberCell, toWire } = await import("../../client/src/lib/sheets");
    expect(toWire({ name: "Boulon", unitCost: "0.125", unitPrice: "4.125", qty: "100", sku: "0.125" })).toEqual({ name: "Boulon", unitCost: 0.125, unitPrice: 4.125, qty: 100, sku: "0.125" });
    expect(amountCellUnsure("4.125")).toEqual(["4125", "4.125"]);
    expect(amountCellUnsure("1,000")).toEqual(["1000", "1"]);
    expect(amountCellUnsure("4,125")).toEqual(["4125", "4.125"]);
    for (const clear of [4.125, "0,125", "0.125", "1 250,125", "12,50", "4,13", "1.250,00", "12500"]) expect(amountCellUnsure(clear), String(clear)).toBeNull();
    expect(readNumberCell("1,000", true).unsure).toEqual(["1000", "1"]);
    expect(readNumberCell("2,250", true)).toEqual({ value: "2.25", unsure: null });
  });

  it("N3: a back-dated refund cannot pay a customer more francs than they deposited", async () => {
    const before = dayOffset(-3);
    expect((await call("POST", "/api/exchange-rates", { date: before, cdfPerUsd: "2820" })).status).toBeLessThan(300);
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const customer = (await call("POST", "/api/parties", { type: "customer", name: "Client acompte" })).body.id;
    const deposit = await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, lines: [{ partyId: customer, amount: "2808000" }] }, "gerant");
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(201);
    // Today, one franc too many is refused.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: [{ partyId: customer, amount: "2808100" }] }, "gerant")).status).toBe(403);
    // Dated three days earlier at 2820, 2 820 000 FC would be 12 000 FC more than the customer paid in.
    const early = await call("POST", "/api/vouchers/payment", { date: before, accountId: cashCdf, lines: [{ partyId: customer, amount: "2820000" }] }, "gerant");
    expect(early.status, JSON.stringify(early.body)).toBe(403);
    // Nothing was held for them three days ago, so not even their own francs go out on that date.
    expect((await call("POST", "/api/vouchers/payment", { date: before, accountId: cashCdf, lines: [{ partyId: customer, amount: "2808000" }] }, "gerant")).status).toBe(403);
    expect((await call("POST", "/api/vouchers/payment", { date: before, accountId: cashUsd, lines: [{ partyId: customer, amount: "100" }] }, "gerant")).status).toBe(403);
    // Dated today, their francs go back in full and nothing is left on either side.
    const back = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: [{ partyId: customer, amount: "2808000" }] }, "gerant");
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const statement = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
      .from(journalLines)
      .where(eq(journalLines.partyId, customer));
    expect(Number(statement[0].native)).toBe(0);
    expect(Number(statement[0].usd)).toBe(0);
  });

  it("N4: a date in year 0000 or a day the calendar lacks is a 400, not a 500", async () => {
    const D = "0000-01-01";
    const party = (await call("POST", "/api/parties", { type: "customer", name: "Client dates" })).body.id;
    const gets = [
      `/api/exchange-rates/for/${D}`, `/api/daybook?from=${D}&to=2026-10-31`, `/api/reports/profit-loss?from=${D}&to=2026-10-31`,
      `/api/reports/balance-sheet?asOf=${D}`, `/api/reports/trial-balance?asOf=${D}`, `/api/reports/daily?date=${D}`, `/api/accounts/${cashUsd}/ledger?from=${D}&to=2026-10-31`,
      `/api/sales?from=${D}`, `/api/expenses?from=${D}`, `/api/stock/transfers?from=${D}`, `/api/journals?from=${D}`, `/api/reports/analytics?from=${D}&to=2026-10-31`,
      `/api/reports/ageing?asOf=${D}`, "/api/periods/0000-01", "/api/exchange-rates/for/2026-02-30",
    ];
    for (const path of gets) expect((await call("GET", path)).status, path).toBe(400);
    const expense = await call("POST", "/api/expenses", { date: D, description: "x", accountId: expenseId, amount: "1", paidFromAccountId: cashUsd });
    expect(expense.status).toBe(400);
    expect(expense.body.code).toBe("VALIDATION");
    expect((await call("POST", "/api/vouchers/receipt", { date: D, accountId: cashUsd, lines: [{ partyId: party, amount: "1" }] })).status).toBe(400);
    expect((await call("POST", "/api/expenses", { date: "2026-02-30", description: "x", accountId: expenseId, amount: "1", paidFromAccountId: cashUsd })).status).toBe(400);
    // A real date still works.
    expect((await call("GET", `/api/daybook?from=${today}&to=${today}`)).status).toBe(200);
  });
});
