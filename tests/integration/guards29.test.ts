import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { Decimal } from "@shared/money";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A34: what the twenty-ninth accounting audit found after A33. */
describe.skipIf(!hasDb)("Guards found by the twenty-ninth audit", async () => {
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
    const box = await call("POST", "/api/containers", { number: `A34-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
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

  it("M1: a reversal after the old payment was undone and the yuan paid again at cost takes nothing back", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const { s, box, payment } = await container("Fournisseur M1", "403.00");
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.00"]);
    // Offloaded again: the bill meets the claim, booking the discount once more.
    expect((await call("POST", `/api/containers/${box}/finalize`, { offloadDate: today })).status).toBe(200);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // The old payment undone (its discount with it), and the yuan paid again at their cost.
    expect((await call("POST", `/api/journals/${payment}/reverse`, { date: today })).status).toBe(200);
    expect(await owed(s, "CNY", payables)).toEqual(["-3000.00", "-422.54"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    const paid = await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashUsd, amount: "422.54", settleNative: "3000" }, "gerant");
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    // Reversed again: no exchange difference is left on these yuan, so none is taken back.
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    const taken = await db.select().from(journalLines).where(and(eq(journalLines.partyId, s), eq(journalLines.memo, ledger.SETTLED_FX_MEMO)));
    expect(taken.map((l) => l.credit)).toEqual(["19.54"]);
    // Refunding what was paid closes it: no dollars left "owed" to the supplier, nothing paid out.
    expect((await receive(s, "422.54")).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect(Number((await drawer(cashUsd))[1]) - cash0).toBeCloseTo(0, 2);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("M2: settling named yuan compares the dollars with their exact cost, not the cost rounded to the cent", async () => {
    const { s, box } = await container("Fournisseur M2");
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    // 0,10 ¥ cost 0,0141 $: a cent is 29 % short, for staff and the owner alike.
    const short = await receive(s, "0.01", { settleNative: "0.10" });
    expect(short.status).toBe(400);
    expect(short.body.message).toContain("0.0141 $");
    expect((await receive(s, "0.01", { settleNative: "0.10", who: "admin" })).status).toBe(400);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    // 0,07 ¥ cost 0,0099 $: a cent covers them.
    expect((await receive(s, "0.01", { settleNative: "0.07" })).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["2999.93", "422.53"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("M3: the owner can settle yuan owed back for up to 5 % less than their cost; staff stay at 1 %", async () => {
    const fx0 = await fxNow();
    const { s, box } = await container("Fournisseur M3");
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    // 403 $ is 4,62 % short of 422,54 $ (as a month-end revaluation can leave a claim the reversal brought to 403 $).
    expect((await receive(s, "403.00", { settleNative: "3000" })).status).toBe(400);
    expect((await receive(s, "400.00", { settleNative: "3000", who: "admin" })).status).toBe(400);
    const back = await receive(s, "403.00", { settleNative: "3000", who: "admin" });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    // The gap is a visible exchange loss.
    expect((await fxNow()) - fx0).toBeCloseTo(19.54, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("M3: a reversal dated back before the discounted payment still takes its discount back", async () => {
    const { s, box } = await container("Fournisseur M3 antidaté", "403.00");
    await reverse(box, `${prev}-24`);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.00"]);
    expect((await receive(s, "403.00")).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });
});
