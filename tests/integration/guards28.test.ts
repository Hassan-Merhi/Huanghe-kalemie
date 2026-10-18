import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { Decimal } from "@shared/money";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A33: what the twenty-eighth accounting audit found after A32. */
describe.skipIf(!hasDb)("Guards found by the twenty-eighth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const checks = await import("../../server/services/checks");
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
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  // Last month: francs at 2 800 on the 20th and 2 900 on the 28th, yuan at 7,2; today 2 790 and 7,1.
  const [ty, tm] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  const [in20, in28] = [`${prev}-20`, `${prev}-28`];
  let cashUsd: number, cashCdf: number, openingEquity: number, fx: number, payables: number, receivables: number, locationId: number;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    fx = accs.find((a) => a.systemKey === "fx")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    receivables = accs.find((a) => a.systemKey === "receivables")!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of [
      [`${prev}-01`, "2800", "7.2"],
      [in20, "2800", "7.2"],
      [in28, "2900", "7.2"],
      [today, "2790", "7.1"],
    ]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd, cnyPerUsd })).status).toBeLessThan(300);
    }
    const opening = await call("POST", "/api/journals", {
      date: `${prev}-01`,
      memo: "Ouverture",
      type: "opening",
      lines: [
        { accountId: cashUsd, debit: "10000" },
        { accountId: cashCdf, debit: "1000", nativeAmount: "2800000", rate: "2800" },
        { accountId: openingEquity, credit: "11000" },
      ],
    });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  async function contact(type: "customer" | "supplier", name: string) {
    const r = await call("POST", "/api/parties", { type, name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** A contact's balance on an account in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CDF" | "CNY", accountId: number) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, accountId), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  async function drawer(accountId: number) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId));
    return [r.native, r.usd];
  }
  const linesOf = (journalId: number) => db.select().from(journalLines).where(eq(journalLines.journalId, journalId));
  const foreignCheck = async () => (await checks.selfCheck(db)).checks.find((c) => c.key === "foreign_balances")!;

  /** 3 000 ¥ offloaded on the 20th at 0,140845 (422,54 $), paid on the 28th with `paid` $ for the 3 000 ¥ (none when null). */
  async function container(name: string, paid: string | null = "422.54") {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const s = await contact("supplier", name);
    const box = await call("POST", "/api/containers", { number: `A33-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "3", unitPrice: "1000" }] })).status).toBe(200);
    expect((await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: in20 })).status).toBe(200);
    let payment: number | null = null;
    if (paid) {
      const r = await call("POST", "/api/money/party-payment", { date: in28, partyId: s, accountId: cashUsd, amount: paid, settleNative: "3000" }, "gerant");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      payment = r.body.id;
    }
    return { s, box: box.body.id as number, payment };
  }
  const reverse = async (box: number, date = today) => {
    const r = await call("POST", `/api/containers/${box}/reverse`, { date });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const receive = (partyId: number, amount: string, opts: { date?: string; settleNative?: string; who?: string } = {}) =>
    call("POST", "/api/vouchers/receipt", { date: opts.date ?? today, accountId: cashUsd, lines: [{ partyId, amount, ...(opts.settleNative ? { settleNative: opts.settleNative } : {}) }] }, opts.who ?? "gerant");
  const fxNow = async () => Number((await drawer(fx))[1]);

  it("L1: cent receipts never settle yuan worth more than their dollars, so together they recover the full cost", async () => {
    const { s, box } = await container("Fournisseur L1");
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    const n = 40;
    for (let i = 0; i < n; i++) expect((await receive(s, "0.01")).status).toBe(201);
    // 0,07 ¥ each (0,0099 $ at their cost), not 0,10 ¥ (0,0141 $) as the cost rounded half up let through.
    const [left, carried] = await owed(s, "CNY", payables);
    const settled = new Decimal(3000).minus(left);
    expect(settled.toFixed(2)).toBe("2.80");
    expect(carried).toBe((422.54 - n * 0.01).toFixed(2));
    expect(settled.times("422.54").dividedBy(3000).lte(n * 0.01)).toBe(true);
    // The yuan left are worth, at their cost, no less than the dollars they are carried at: the rest of the cost
    // clears them, and the cent receipts with it recover the full 422,54 $.
    expect(new Decimal(left).times("422.54").dividedBy(3000).gte(carried)).toBe(true);
    expect((await receive(s, carried)).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("L2: a container whose yuan were paid at a discount comes back owed at what was paid, and refunding that closes it", async () => {
    for (const paid of ["416.67", "403.00"]) {
      const fx0 = await fxNow();
      const { s, box } = await container(`Fournisseur L2 ${paid}`, paid);
      // The discount went to gains when paid…
      expect((await fxNow()) - fx0).toBeCloseTo(-(422.54 - Number(paid)), 2);
      await reverse(box);
      // …and the reversal takes it back: the supplier owes the yuan at the dollars paid for them.
      expect(await owed(s, "CNY", payables)).toEqual(["3000.00", paid]);
      expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
      const back = await receive(s, paid);
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
      expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
      expect((await linesOf(back.body.id)).some((l) => l.accountId === fx)).toBe(false);
      expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    }
    // Paid in full at cost: the reversal is exact, as before.
    const exact = await container("Fournisseur L2 exact");
    await reverse(exact.box);
    expect(await owed(exact.s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("L2: the exchange difference is taken back once, whatever is undone or offloaded again", async () => {
    // Half the yuan paid at a discount: only those come back owed, at what was paid.
    const half = await container("Fournisseur L2 moitié", null);
    expect((await call("POST", "/api/money/party-payment", { date: in28, partyId: half.s, accountId: cashUsd, amount: "208.00", settleNative: "1500" }, "gerant")).status).toBe(201);
    await reverse(half.box);
    expect(await owed(half.s, "CNY", payables)).toEqual(["1500.00", "208.00"]);
    // The payment undone too: nothing left owed either way, and no gain or loss left from it.
    const fx0 = await fxNow();
    const undone = await container("Fournisseur L2 paiement annulé", "403.00");
    await reverse(undone.box);
    expect((await call("POST", `/api/journals/${undone.payment}/reverse`, { date: today })).status).toBe(200);
    expect(await owed(undone.s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(undone.s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    // Offloaded again (the old payment settles it, at its discount once more) and reversed again.
    const again = await container("Fournisseur L2 de nouveau", "403.00");
    await reverse(again.box);
    expect((await call("POST", `/api/containers/${again.box}/finalize`, { offloadDate: today })).status).toBe(200);
    expect(await owed(again.s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    await reverse(again.box);
    expect(await owed(again.s, "CNY", payables)).toEqual(["3000.00", "403.00"]);
    const taken = await db.select().from(journalLines).where(and(eq(journalLines.partyId, again.s), eq(journalLines.memo, ledger.SETTLED_FX_MEMO)));
    expect(taken.map((l) => l.credit)).toEqual(["19.54", "19.54"]);
    expect((await receive(again.s, "403.00")).status).toBe(201);
    expect(await owed(again.s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // A refund still settles only what it covers: staff write-offs stay within 1 %.
    const short = await container("Fournisseur L2 court", "403.00");
    await reverse(short.box);
    expect((await receive(short.s, "395.00", { settleNative: "3000" })).status).toBe(400);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("INFO: a negative number of yuan to settle is refused, not ignored", async () => {
    const { s, box } = await container("Fournisseur négatif");
    await reverse(box);
    expect((await receive(s, "5", { settleNative: "-10" })).status).toBe(400);
    const owing = await container("Fournisseur négatif paiement", null);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: owing.s, accountId: cashUsd, amount: "5", settleNative: "-10" }, "gerant")).status).toBe(400);
    expect(await owed(owing.s, "CNY", payables)).toEqual(["-3000.00", "-422.54"]);
    expect(await owed(owing.s, "USD", payables)).toEqual(["0.00", "0.00"]);
  });
});
