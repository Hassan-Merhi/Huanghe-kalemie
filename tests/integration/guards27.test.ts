import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { Decimal } from "@shared/money";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A32: what the twenty-seventh accounting audit found after A31. */
describe.skipIf(!hasDb)("Guards found by the twenty-seventh audit", async () => {
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

  /** 3 000 ¥ offloaded on the 20th at 0,140845 (422,54 $), paid on the 28th with 422,54 $ for the 3 000 ¥, reversed on `undone`. */
  async function owing(name: string, undone = today) {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const s = await contact("supplier", name);
    const box = await call("POST", "/api/containers", { number: `N1-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "3", unitPrice: "1000" }] })).status).toBe(200);
    expect((await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: in20 })).status).toBe(200);
    const paid = await call("POST", "/api/money/party-payment", { date: in28, partyId: s, accountId: cashUsd, amount: "422.54", settleNative: "3000" }, "gerant");
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect((await call("POST", `/api/containers/${box.body.id}/reverse`, { date: undone })).status).toBe(200);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    return s;
  }
  const receive = (partyId: number, amount: string, opts: { date?: string; settleNative?: string; who?: string } = {}) =>
    call("POST", "/api/vouchers/receipt", { date: opts.date ?? today, accountId: cashUsd, lines: [{ partyId, amount, ...(opts.settleNative ? { settleNative: opts.settleNative } : {}) }] }, opts.who ?? "gerant");
  const fxNow = async () => Number((await drawer(fx))[1]);

  it("N1 A: instalments settle the yuan at their cost, so the last one clears them and nothing is left owed back", async () => {
    const s = await owing("Fournisseur N1 A");
    const fx0 = await fxNow();
    expect((await receive(s, "410")).status).toBe(201);
    // 410 $ of 422,54 $: the yuan they cover at their cost, 2 911 ¥; 89 ¥ left at 12,54 $.
    expect(await owed(s, "CNY", payables)).toEqual(["89.00", "12.54"]);
    expect((await receive(s, "12.54")).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N1 C/B: the yuan rate entered for the day changes nothing: 422,54 $ clear exactly the 3 000 ¥, less clears less", async () => {
    const full = await owing("Fournisseur N1 C");
    const short = await owing("Fournisseur N1 B");
    // A manager nudges today's yuan rate by 5 %.
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2790", cnyPerUsd: "7.455" }, "gerant")).status).toBeLessThan(300);
    try {
      const fx0 = await fxNow();
      const back = await receive(full, "422.54");
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      expect(await owed(full, "CNY", payables)).toEqual(["0.00", "0.00"]);
      expect(await owed(full, "USD", payables)).toEqual(["0.00", "0.00"]);
      expect((await linesOf(back.body.id)).some((l) => l.accountId === fx)).toBe(false);
      // 383,26 $ (all 3 000 ¥ at 7,455): only the yuan they cover at their cost; 39,28 $ of them still owed.
      expect((await receive(short, "383.26")).status).toBe(201);
      expect((await owed(short, "CNY", payables))[1]).toBe("39.28");
      expect(await owed(short, "USD", payables)).toEqual(["0.00", "0.00"]);
      expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    } finally {
      expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2790", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    }
  });

  it("N1 F: a receipt dated back cannot settle yuan a later receipt already settled", async () => {
    const s = await owing("Fournisseur N1 F", in28);
    expect((await receive(s, "422.54")).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    // On the 28th they still owed the 3 000 ¥, today they owe none: the 410 $ are theirs, no yuan go out.
    expect((await receive(s, "410", { date: in28 })).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "-410.00"]);
    expect((await receive(s, "422.54", { date: in28, settleNative: "3000" })).status).toBe(400);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N1: settling all the yuan for less than their cost is an explicit request, within 1 % for staff", async () => {
    const s = await owing("Fournisseur N1 solde");
    const fx0 = await fxNow();
    // 419 $ for 422,54 $ (0,84 % short): settled on request, the 3,54 $ to exchange differences.
    expect((await receive(s, "419", { settleNative: "3000.01" })).status).toBe(400);
    expect((await receive(s, "419", { settleNative: "3000" })).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect(((await fxNow()) - fx0).toFixed(2)).toBe("3.54");
    // More than their cost: the rest is theirs in dollars, as before.
    const more = await owing("Fournisseur N1 solde plus");
    expect((await receive(more, "430", { settleNative: "3000" })).status).toBe(201);
    expect(await owed(more, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(more, "USD", payables)).toEqual(["0.00", "-7.46"]);
    // Only on money received from a supplier, into dollars.
    const c = await contact("customer", "Client N1");
    expect((await receive(c, "10", { settleNative: "10" })).status).toBe(400);
    const other = await owing("Fournisseur N1 solde francs");
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, lines: [{ partyId: other, amount: "1200000", settleNative: "3000" }] }, "gerant")).status).toBe(400);
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: other, amount: "10", settleNative: "10" }] }, "gerant")).status).toBe(400);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("I1: a reversal that leaves francs whose dollars say the other way restates them at the day's rate", async () => {
    // 10 000 000 FC in on the 20th (2 800) and on the 28th (2 900), 10 000 015 FC refunded today at their
    // average cost, then the receipt of the 28th reversed: 15 FC the customer owes would show the shop
    // owing 61,57 $.
    const c = await contact("customer", "Client I1");
    expect((await call("POST", "/api/money/customer-receipt", { date: in20, partyId: c, accountId: cashCdf, amount: "10000000" }, "gerant")).status).toBe(201);
    const first = await call("POST", "/api/money/customer-receipt", { date: in28, partyId: c, accountId: cashCdf, amount: "10000000" }, "gerant");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const refund = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: [{ partyId: c, amount: "10000015" }] }, "gerant");
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const drawer0 = await drawer(cashCdf);
    const rev = await call("POST", `/api/journals/${first.body.id}/reverse`, { date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    // 15 FC at 2 790: 0,01 $ owed by the customer. No franc moves, and the drawer gives back what came in.
    expect(await owed(c, "CDF", receivables)).toEqual(["15.00", "0.01"]);
    const restated = (await linesOf(rev.body.id)).filter((l) => l.memo === ledger.REVALUED_MEMO);
    expect(restated.map((l) => [l.accountId, l.nativeAmount, l.debit, l.credit])).toEqual([
      [receivables, "0.00", "61.58", "0.00"],
      [fx, null, "0.00", "61.58"],
    ]);
    const [orig] = await db.select().from(journalLines).where(and(eq(journalLines.journalId, first.body.id), eq(journalLines.accountId, cashCdf)));
    expect((Number(drawer0[0]) - Number((await drawer(cashCdf))[0])).toFixed(2)).toBe(orig.nativeAmount);
    // Nothing for staff to pay out.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: c, amount: "0.01" }] }, "gerant")).status).toBe(403);
    expect((await foreignCheck()).ok).toBe(true);
    expect((await checks.selfCheck(db)).ok).toBe(true);

    // Dollars of the francs' own sign are left to the next revaluation: the receipt of the 20th reversed instead.
    const kept = await contact("customer", "Client I1 bis");
    const r1 = await call("POST", "/api/money/customer-receipt", { date: in20, partyId: kept, accountId: cashCdf, amount: "10000000" }, "gerant");
    expect((await call("POST", "/api/money/customer-receipt", { date: in28, partyId: kept, accountId: cashCdf, amount: "10000000" }, "gerant")).status).toBe(201);
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: [{ partyId: kept, amount: "10000015" }] }, "gerant")).status).toBe(201);
    const rev2 = await call("POST", `/api/journals/${r1.body.id}/reverse`, { date: today });
    expect(rev2.status).toBe(200);
    expect((await linesOf(rev2.body.id)).some((l) => l.memo === ledger.REVALUED_MEMO)).toBe(false);
    expect(await owed(kept, "CDF", receivables)).toEqual(["15.00", "61.58"]);
  });

  it("I1: the restatement moves no more than the rates of the postings explain", async () => {
    const c = await contact("customer", "Client I1 borne");
    const outcome = async (back: string, rate: string) => {
      const rollback = new Error("rollback");
      let lines: Awaited<ReturnType<typeof ledger.revaluedDollarLines>> = [];
      await db
        .transaction(async (tx) => {
          await ledger.postJournal(tx, {
            date: today,
            type: "manual",
            memo: "I1",
            exactValues: true,
            lines: [
              { accountId: receivables, partyId: c, credit: "100.00", currency: "CDF", nativeAmount: "-280000", rate: "2800" },
              { accountId: openingEquity, debit: "100.00" },
            ],
          });
          lines = await ledger.revaluedDollarLines(tx, [{ accountId: receivables, partyId: c, currency: "CDF" }], today, [
            { accountId: receivables, partyId: c, debit: new Decimal(back), credit: new Decimal(0), currency: "CDF", nativeAmount: "280015.00", rate, memo: null },
          ]);
          throw rollback;
        })
        .catch((e) => {
          if (e !== rollback) throw e;
        });
      return lines.map((l) => [l.accountId, l.nativeAmount, l.debit.toFixed(2), l.credit.toFixed(2)]);
    };
    // 280 015 FC back at 2 900 (96,56 $): 3,44 $ the rates explain, restated to 0,01 $.
    expect(await outcome("96.56", "2900.0000")).toEqual([
      [receivables, "0.00", "3.45", "0.00"],
      [fx, null, "0.00", "3.45"],
    ]);
    // The same francs back at 99 $ booked at 2 800: no rate explains the dollar, so it stays.
    expect(await outcome("99.00", "2800.0000")).toEqual([]);
  });
});
