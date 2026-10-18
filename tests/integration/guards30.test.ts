import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { Decimal } from "@shared/money";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A35: what the thirtieth accounting audit found after A34. */
describe.skipIf(!hasDb)("Guards found by the thirtieth audit", async () => {
  const { createApp } = await import("../../server/index");
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

  /** A supplier's yuan container of `yuan` ¥ at 0,140845, offloaded on `offload`. */
  async function container(s: number, yuan: number, offload = in20) {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const box = await call("POST", "/api/containers", { number: `A35-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: String(yuan / 1000), unitPrice: "1000" }] })).status).toBe(200);
    const off = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: offload });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    return box.body.id as number;
  }
  const pay = async (s: number, amount: string, settleNative: string, date = in28) => {
    const r = await call("POST", "/api/money/party-payment", { date, partyId: s, accountId: cashUsd, amount, settleNative }, "gerant");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const reverse = async (box: number, date = today) => {
    const r = await call("POST", `/api/containers/${box}/reverse`, { date });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const undo = async (journal: number, date = today) => {
    const r = await call("POST", `/api/journals/${journal}/reverse`, { date });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const receive = (partyId: number, amount: string, opts: { date?: string; settleNative?: string; who?: string } = {}) =>
    call("POST", "/api/vouchers/receipt", { date: opts.date ?? today, accountId: cashUsd, lines: [{ partyId, amount, ...(opts.settleNative ? { settleNative: opts.settleNative } : {}) }] }, opts.who ?? "gerant");
  const fxNow = async () => Number((await drawer(fx))[1]);
  /** Refunding exactly `paid` closes the supplier: no yuan, no dollars, no exchange difference left. */
  async function refundCloses(s: number, paid: string, fx0: number, cash0: number) {
    const back = await receive(s, paid);
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect(Number((await drawer(cashUsd))[1]) - cash0).toBeCloseTo(0, 2);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  }

  it("N1: undoing a payment after a reversal took its discount back gives that share back", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur N1");
    const box = await container(s, 3000);
    await pay(s, "201.76", "1500");
    const twice = await pay(s, "201.76", "1500");
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    // The second payment was entered by mistake: undone, the claim is what the first paid.
    await undo(twice);
    expect(await owed(s, "CNY", payables)).toEqual(["1500.00", "201.76"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    await refundCloses(s, "201.76", fx0, cash0);
  });

  it("N2: two containers of one supplier reversed in date order take the discount back", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur N2");
    const first = await container(s, 2000);
    await pay(s, "290.14", "2000");
    const second = await container(s, 3000, in28);
    // The first one's yuan, once it is undone, pay the second one's.
    await reverse(first);
    expect(await owed(s, "CNY", payables)).toEqual(["-1000.00", "-140.85"]);
    await reverse(second);
    expect(await owed(s, "CNY", payables)).toEqual(["2000.00", "290.14"]);
    await refundCloses(s, "290.14", fx0, cash0);
  });

  it("N3: another container's advance, undone by its own reversal, does not cut the takeback", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur N3");
    const advance = await call("POST", "/api/money/party-payment", { date: `${prev}-19`, partyId: s, accountId: cashUsd, amount: "1000" }, "gerant");
    expect(advance.status, JSON.stringify(advance.body)).toBe(201);
    // The advance pays 7 200 ¥ at the day's 7,2 (cost 1 014,08 $); 22 800 ¥ are left, paid at 7,2 too.
    const first = await container(s, 20000);
    const second = await container(s, 10000);
    expect(await owed(s, "CNY", payables)).toEqual(["-22800.00", "-3211.27"]);
    await pay(s, "3166.67", "22800");
    await reverse(first);
    await reverse(second);
    expect(await owed(s, "CNY", payables)).toEqual(["22800.00", "3166.67"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "1000.00"]);
    await refundCloses(s, "4166.67", fx0, cash0);
  });

  it("N4: a reversal dated before the payment is refused (A36); on its day, then the payment undone, it leaves no dollars on no yuan", async () => {
    const fx0 = await fxNow();
    const s = await contact("supplier", "Fournisseur N4");
    const box = await container(s, 3000);
    const payment = await pay(s, "403.52", "3000");
    const back = await call("POST", `/api/containers/${box}/reverse`, { date: `${prev}-24` });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe("YUAN_DATE_ORDER");
    await reverse(box, in28);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    await undo(payment);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await foreignCheck()).ok).toBe(true);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N1: a payment undone while another container's yuan are claimed books what they settle at their cost", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur N1 bis");
    const first = await container(s, 3000);
    const firstPaid = await pay(s, "403.52", "3000");
    const second = await container(s, 3000, in28);
    await pay(s, "403.52", "3000");
    await reverse(second);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    // The first payment undone: the second one's yuan, claimed, now settle the first container at a discount.
    await undo(firstPaid);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // A gain: credited to exchange differences.
    expect((await fxNow()) - fx0).toBeCloseTo(-19.02, 2);
    await reverse(first);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    await refundCloses(s, "403.52", fx0, cash0);
  });

  it("N1: a payment whose claimed yuan the supplier refunded since cannot be undone before that refund", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur N1 remboursé");
    const box = await container(s, 3000);
    const payment = await pay(s, "403.52", "3000");
    await reverse(box);
    const back = await receive(s, "403.52");
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // Undone now, the refund would be yuan the shop owes the supplier, at a rate no payment explains.
    const refused = await call("POST", `/api/journals/${payment}/reverse`, { date: today });
    expect(refused.status).toBe(409);
    expect(refused.body.messageFr).toContain("Annulez d'abord ce remboursement");
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // The refund undone first, the payment can go: nothing is left, as if neither happened.
    await undo(back.body.id);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    await undo(payment);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect(Number((await drawer(cashUsd))[1]) - cash0).toBeCloseTo(0, 2);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  // Closes last month: keep it last.
  it("N4: a claim a month-end close revalued, its reversal on the payment's day, then the payment undone, leaves nothing", async () => {
    const s = await contact("supplier", "Fournisseur N4 clôture");
    const box = await container(s, 3000);
    const payment = await pay(s, "403.52", "3000");
    // Dated before the payment it is refused (A36, see assertYuanInOrder).
    expect((await call("POST", `/api/containers/${box}/reverse`, { date: `${prev}-24` })).status).toBe(409);
    await reverse(box, in28);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    const close = await call("POST", `/api/periods/${prev}/close`, {});
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    // Restated at the month-end 7,2.
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "416.67"]);
    const fx0 = await fxNow();
    await undo(payment);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // The revaluation's gain goes back with the yuan, and the discount the reversal took back is the payment's own.
    expect((await fxNow()) - fx0).toBeCloseTo(13.15, 2);
    expect((await foreignCheck()).ok).toBe(true);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });
});
