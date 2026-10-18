import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { Decimal } from "@shared/money";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A31: what the twenty-sixth accounting audit found after A30. */
describe.skipIf(!hasDb)("Guards found by the twenty-sixth audit", async () => {
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
  // Last month: francs at 2 818 on the 20th and 2 798 on the 28th, yuan at 7,2; today 2 790 and 7,1.
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
      [in20, "2818", "7.2"],
      [in28, "2798", "7.2"],
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

  it("F1: a dollar receipt settles the yuan a supplier owes back after a paid yuan container is reversed", async () => {
    const product = await call("POST", "/api/products", { name: `Pièce F1 ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    /** 3 000 ¥ offloaded on the 20th at 0,140845 (422,54 $), paid on the 28th with 416,67 $ for the 3 000 ¥ (7,2), reversed today. */
    const owing = async (name: string) => {
      const s = await contact("supplier", name);
      const box = await call("POST", "/api/containers", { number: `F1-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
      expect(box.status, JSON.stringify(box.body)).toBe(201);
      expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "3", unitPrice: "1000" }] })).status).toBe(200);
      const offload = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: in20 });
      expect(offload.status, JSON.stringify(offload.body)).toBe(200);
      expect(await owed(s, "CNY", payables)).toEqual(["-3000.00", "-422.54"]);
      const paid = await call("POST", "/api/money/party-payment", { date: in28, partyId: s, accountId: cashUsd, amount: "416.67", settleNative: "3000" }, "gerant");
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
      expect((await call("POST", `/api/containers/${box.body.id}/reverse`, { date: today })).status).toBe(200);
      // A33: they come back owed at the 416,67 $ paid for them, the payment's 5,87 $ gain taken back.
      expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "416.67"]);
      return s;
    };
    const receive = (partyId: number, amount: string) => call("POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ partyId, amount }] }, "gerant");

    // The 416,67 $ paid come back (3 000 ¥ at 7,2): they settle all the yuan at their cost, which is now
    // what was paid (A33), with no write-off and nothing to exchange differences; the drawer gets what came in.
    const s = await owing("Fournisseur F1");
    const fx0 = (await drawer(fx))[1];
    const usd0 = await drawer(cashUsd);
    const back = await receive(s, "416.67");
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect((Number((await drawer(fx))[1]) - Number(fx0)).toFixed(2)).toBe("0.00");
    expect((Number((await drawer(cashUsd))[1]) - Number(usd0[1])).toFixed(2)).toBe("416.67");
    const lines = await linesOf(back.body.id);
    expect(lines.find((l) => l.accountId === cashUsd)?.credit).toBe("0.00");
    expect((await checks.selfCheck(db)).ok).toBe(true);

    // Far less than they are worth (380 $): only the yuan it covers at their cost, 2 735,97 ¥.
    const short = await owing("Fournisseur F1 partiel");
    expect((await receive(short, "380")).status).toBe(201);
    expect(await owed(short, "CNY", payables)).toEqual(["264.03", "36.67"]);
    expect(await owed(short, "USD", payables)).toEqual(["0.00", "0.00"]);
    // The rest, 36,67 $, their cost: settled too.
    expect((await receive(short, "36.67")).status).toBe(201);
    expect(await owed(short, "CNY", payables)).toEqual(["0.00", "0.00"]);

    // More than all of them: the yuan at their cost (416,67 $), the rest is theirs in dollars.
    const more = await owing("Fournisseur F1 plus");
    expect((await receive(more, "500")).status).toBe(201);
    expect(await owed(more, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(more, "USD", payables)).toEqual(["0.00", "-83.33"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F2: a reversal that leaves a franc worth under half a cent clears it with the rate's dollars, never a drawer's", async () => {
    // 10 000 000 FC in on the 20th and on the 28th, 10 000 001 FC refunded today, then the first receipt
    // reversed: 1 FC would be left carrying the rate's dollars.
    const c = await contact("customer", "Client F2");
    const first = await call("POST", "/api/money/customer-receipt", { date: in20, partyId: c, accountId: cashCdf, amount: "10000000" }, "gerant");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await call("POST", "/api/money/customer-receipt", { date: in28, partyId: c, accountId: cashCdf, amount: "10000000" }, "gerant")).status).toBe(201);
    const refund = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, lines: [{ partyId: c, amount: "10000001" }] }, "gerant");
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const drawer0 = await drawer(cashCdf);
    const rev = await call("POST", `/api/journals/${first.body.id}/reverse`, { date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    const cleared = (await linesOf(rev.body.id)).filter((l) => l.memo === ledger.REVALUED_MEMO);
    expect(cleared.map((l) => [l.accountId, l.nativeAmount])).toEqual([
      [receivables, "-1.00"],
      [fx, null],
    ]);
    // The drawer gives back exactly the francs received, at what they were received at.
    const [orig] = await db.select().from(journalLines).where(and(eq(journalLines.journalId, first.body.id), eq(journalLines.accountId, cashCdf)));
    expect((Number(drawer0[0]) - Number((await drawer(cashCdf))[0])).toFixed(2)).toBe(orig.nativeAmount);
    expect((Number(drawer0[1]) - Number((await drawer(cashCdf))[1])).toFixed(2)).toBe(orig.debit);
    expect((await foreignCheck()).ok).toBe(true);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F3: closing and reopening a month again and again does not widen what revaluations explain", async () => {
    // 280 000 FC held at 100 $; three revaluations of 5 $ each undone (a month reopened), and one of
    // 0,71 $ that stands. A reversal giving the francs back at 97 $ leaves 3,71 $: more than the 0,71 $
    // the revaluations explain, so they stay for a person; at 100 $, the 0,71 $ go.
    const c = await contact("customer", "Client F3");
    const outcome = async (back: string) => {
      const rollback = new Error("rollback");
      let lines: Awaited<ReturnType<typeof ledger.revaluedDollarLines>> = [];
      await db
        .transaction(async (tx) => {
          const post = (type: "manual" | "revaluation", usd: number, native: string | null, reversesJournalId?: number | null) =>
            ledger.postJournal(tx, {
              date: today,
              type,
              memo: "F3",
              exactValues: true,
              reversesJournalId,
              lines: [
                { accountId: receivables, partyId: c, ...(usd > 0 ? { debit: usd.toFixed(2) } : { credit: (-usd).toFixed(2) }), currency: "CDF", nativeAmount: native ?? "0", rate: "2800" },
                { accountId: native ? openingEquity : fx, ...(usd > 0 ? { credit: usd.toFixed(2) } : { debit: (-usd).toFixed(2) }) },
              ],
            });
          await post("manual", -100, "280000");
          for (let i = 0; i < 3; i++) {
            const r = await post("revaluation", -5, null);
            await post("revaluation", 5, null, r);
          }
          await post("revaluation", -0.71, null);
          lines = await ledger.revaluedDollarLines(tx, [{ accountId: receivables, partyId: c, currency: "CDF" }], today, [
            { accountId: receivables, partyId: c, debit: new Decimal(back), credit: new Decimal(0), currency: "CDF", nativeAmount: "280000.00", rate: "2800.0000", memo: null },
          ]);
          throw rollback;
        })
        .catch((e) => {
          if (e !== rollback) throw e;
        });
      return lines.map((l) => [l.accountId, l.debit.toFixed(2), l.credit.toFixed(2)]);
    };
    expect(await outcome("97")).toEqual([]);
    expect(await outcome("100")).toEqual([
      [receivables, "0.71", "0.00"],
      [fx, "0.00", "0.71"],
    ]);
  });
});
