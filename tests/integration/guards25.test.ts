import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A30: what the twenty-fifth accounting audit found after A29. */
describe.skipIf(!hasDb)("Guards found by the twenty-fifth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const checks = await import("../../server/services/checks");
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
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  // Last month, closed in N3b (nothing is dated before it): francs come in on the 20th at 2 818, the
  // month ends at 2 798, and today they go back at 2 790.
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
    for (const [date, cdfPerUsd] of [
      [`${prev}-01`, "2800"],
      [in20, "2818"],
      [in28, "2798"],
      [today, "2790"],
    ]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd, cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    }
    const opening = await call("POST", "/api/journals", {
      date: `${prev}-01`,
      memo: "Ouverture",
      type: "opening",
      lines: [
        { accountId: cashUsd, debit: "1000" },
        { accountId: cashCdf, debit: "1000", nativeAmount: "2800000", rate: "2800" },
        { accountId: openingEquity, credit: "2000" },
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
  async function owed(partyId: number, currency: "USD" | "CDF", accountId: number) {
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
  /** Dollars posted by hand on a contact's francs, exactly as given (debit when positive), against opening equity. */
  async function byHand(partyId: number, native: string, usd: string) {
    const amount = Number(usd);
    await db.transaction((tx) =>
      ledger.postJournal(tx, {
        date: today,
        type: "manual",
        memo: "Saisie à la main",
        exactValues: true,
        lines: [
          { accountId: receivables, partyId, ...(amount > 0 ? { debit: usd } : { credit: String(-amount) }), currency: "CDF", nativeAmount: native, rate: "2790" },
          { accountId: openingEquity, ...(amount > 0 ? { credit: usd } : { debit: String(-amount) }) },
        ],
      }),
    );
  }
  const foreignCheck = async () => (await checks.selfCheck(db)).checks.find((c) => c.key === "foreign_balances")!;
  const receipt = (partyId: number, amount: string, date: string, accountId = cashCdf) =>
    call("POST", "/api/money/customer-receipt", { date, partyId, accountId, amount }, "gerant");
  const refund = (partyId: number, amount: string, accountId = cashCdf, date = today) =>
    call("POST", "/api/vouchers/payment", { date, accountId, lines: [{ partyId, amount }] }, "gerant");
  const linesOf = (journalId: number) => db.select().from(journalLines).where(eq(journalLines.journalId, journalId));

  it("N4: a reversal that empties francs after the rate moved takes the rate's dollars off, never a drawer's francs", async () => {
    expect((await checks.selfCheck(db)).ok).toBe(true);
    // 280 000 FC in on the 20th (2 818: 99,36 $), all back on the 28th, 280 000 FC in today (2 790: 100,36 $),
    // then the first receipt reversed: the francs go back at 99,36 $, and the 1,00 $ the rate explains
    // goes to exchange differences in the same journal.
    const c = await contact("customer", "Client N4");
    const first = await receipt(c, "280000", in20);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await refund(c, "280000", cashCdf, in28)).status).toBe(201);
    expect((await receipt(c, "280000", today)).status).toBe(201);
    expect(await owed(c, "CDF", receivables)).toEqual(["-280000.00", "-100.36"]);
    const drawer0 = await drawer(cashCdf);
    const rev = await call("POST", `/api/journals/${first.body.id}/reverse`, { date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    const lines = await linesOf(rev.body.id);
    const cleared = lines.filter((l) => l.memo === ledger.REVALUED_MEMO);
    expect(cleared.map((l) => [l.accountId, l.nativeAmount, l.debit, l.credit])).toEqual([
      [receivables, "0.00", "1.00", "0.00"],
      [fx, null, "0.00", "1.00"],
    ]);
    // The drawer gives back exactly the francs received, at what they were received at.
    const [orig] = await db.select().from(journalLines).where(and(eq(journalLines.journalId, first.body.id), eq(journalLines.accountId, cashCdf)));
    expect((Number(drawer0[0]) - Number((await drawer(cashCdf))[0])).toFixed(2)).toBe(orig.nativeAmount);
    expect((Number(drawer0[1]) - Number((await drawer(cashCdf))[1])).toFixed(2)).toBe(orig.debit);
    expect((await foreignCheck()).ok).toBe(true);

    // The same on a supplier, with a franc container offloaded on the 20th, paid in full on the 28th, a
    // second one today, and the first reversed.
    const s = await contact("supplier", "Fournisseur N4");
    const product = await call("POST", "/api/products", { name: `Pièce N4 ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "300" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const container = async (date: string, rate: number) => {
      const box = await call("POST", "/api/containers", { number: `N4-${uniq()}`, supplierId: s, locationId, currency: "CDF", rateToUsd: (1 / rate).toFixed(8), status: "arrived" });
      expect(box.status, JSON.stringify(box.body)).toBe(201);
      expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "2", unitPrice: "140000" }] })).status).toBe(200);
      const offload = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: date });
      expect(offload.status, JSON.stringify(offload.body)).toBe(200);
      return box.body.id as number;
    };
    const a = await container(in20, 2818);
    expect((await call("POST", "/api/money/party-payment", { date: in28, partyId: s, accountId: cashCdf, amount: "280000" })).status).toBe(201);
    await container(today, 2790);
    expect(await owed(s, "CDF", payables)).toEqual(["-280000.00", "-100.36"]);
    expect((await call("POST", `/api/containers/${a}/reverse`, { date: today })).status).toBe(200);
    expect(await owed(s, "CDF", payables)).toEqual(["0.00", "0.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);

    // Dollars posted by hand while the francs were held are not the rate's: the reversal that empties the
    // francs leaves them, for the self-check to show.
    const c2 = await contact("customer", "Client N4b");
    const r2 = await receipt(c2, "280000", today);
    expect(r2.status).toBe(201);
    await byHand(c2, "0", "-3.00");
    expect((await call("POST", `/api/journals/${r2.body.id}/reverse`, { date: today })).status).toBe(200);
    expect(await owed(c2, "CDF", receivables)).toEqual(["0.00", "-3.00"]);
    const check = await foreignCheck();
    expect([check.ok, check.details?.[0].value]).toEqual([false, "0.00 FC ≠ -3.00 $"]);
    await byHand(c2, "0", "3.00");
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N3b: closing a month whose francs were settled since takes the revaluation off them, from that day", async () => {
    // 28 000 000 FC paid ahead on the 20th and refunded today; a franc bill on the 20th paid today; and a
    // customer who still holds their francs. Then last month is closed.
    const c = await contact("customer", "Client N3b");
    expect((await receipt(c, "28000000", in20)).status).toBe(201);
    expect((await refund(c, "28000000")).status).toBe(201);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    const s = await contact("supplier", "Fournisseur N3b");
    const transport = (await db.select().from(accounts)).find((x) => x.type === "expense" && !x.systemKey && x.code !== "6010")!.id;
    const bill = await call("POST", "/api/expenses", { date: in20, accountId: transport, description: "Transport", amount: "280000", currency: "CDF", payablePartyId: s }, "gerant");
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashCdf, amount: "280000" }, "gerant")).status).toBe(201);
    const keeps = await contact("customer", "Client N3b garde");
    expect((await receipt(keeps, "280000", in20)).status).toBe(201);
    const fx0 = (await drawer(fx))[1];
    const cdf0 = await drawer(cashCdf);

    const close = await call("POST", `/api/periods/${prev}/close`, {});
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    // Last month's revaluation stands (its profit is split as shown); today, the francs since settled lose it.
    const [period] = await db.execute<{ id: number; revaluation_journal_id: number }>(sql`select id, revaluation_journal_id from periods where month = ${prev}`).then((r) => r.rows);
    const reval = await linesOf(period.revaluation_journal_id);
    const on = (partyId: number) => reval.find((l) => l.partyId === partyId);
    expect(on(c)?.credit).toBe("71.03");
    expect(on(s)?.credit).toBe("0.71");
    expect(on(keeps)?.credit).toBe("0.71");
    const settled = await db.select().from(journals).where(and(eq(journals.sourceType, "period_settled"), eq(journals.sourceId, period.id)));
    expect(settled.map((j) => [j.date, j.type])).toEqual([[today, "revaluation"]]);
    const settledLines = await linesOf(settled[0].id);
    expect(settledLines.every((l) => l.memo === periods.REVALUATION_SETTLED_MEMO)).toBe(true);
    expect(settledLines.map((l) => [l.accountId, l.partyId, l.nativeAmount, l.debit, l.credit])).toEqual(
      expect.arrayContaining([
        [receivables, c, "0.00", "71.03", "0.00"],
        [payables, s, "0.00", "0.71", "0.00"],
        [fx, null, null, "0.00", "71.74"],
      ]),
    );
    expect(settledLines.find((l) => l.partyId === keeps)).toBeUndefined();
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "CDF", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(keeps, "CDF", receivables)).toEqual(["-280000.00", "-100.07"]);
    // No drawer moves for it (the drawer's own revaluation is last month's).
    expect(settledLines.some((l) => l.accountId === cashCdf)).toBe(false);
    expect((await drawer(cashCdf))[0]).toBe(cdf0[0]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
    // N3a's repro: nothing is left to refund, in dollars or in francs.
    expect((await refund(c, "0.01", cashUsd)).status).toBe(403);
    expect((await refund(c, "100")).status).toBe(403);

    // Reopened, the month's revaluation and what took it off go together; closed again, both come back.
    expect((await call("POST", `/api/periods/${prev}/reopen`, {})).status).toBe(200);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect((await drawer(fx))[1]).toBe(fx0);
    expect((await call("POST", `/api/periods/${prev}/close`, {})).status).toBe(200);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "CDF", payables)).toEqual(["0.00", "0.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N3a: dollars on a franc balance with no francs are never paid out, and still count when owed", async () => {
    // A franc balance with no francs but 71,03 $ held (as a close left one before N3b): staff cannot pay them out.
    const c = await contact("customer", "Client N3a");
    await byHand(c, "0", "-71.03");
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "-71.03"]);
    const paid = await refund(c, "71.03", cashUsd);
    expect(paid.status, JSON.stringify(paid.body)).toBe(403);
    expect(paid.body.message).toMatch(/has only 0\.00 \$ to get back/);
    expect((await refund(c, "0.01", cashUsd)).status).toBe(403);
    expect((await refund(c, "100")).status).toBe(403);
    // Dollars paid ahead are still refunded, and no more.
    expect((await receipt(c, "10", today, cashUsd)).status).toBe(201);
    expect((await refund(c, "10.01", cashUsd)).status).toBe(403);
    expect((await refund(c, "10", cashUsd)).status).toBe(201);
    expect(await owed(c, "USD", receivables)).toEqual(["0.00", "0.00"]);

    // The other way, 5 $ owed on a franc balance with no francs still come off a dollar credit: the cap is
    // never looser than before.
    const d = await contact("customer", "Client N3a dette");
    await byHand(d, "0", "5.00");
    expect((await receipt(d, "10", today, cashUsd)).status).toBe(201);
    expect((await refund(d, "5.01", cashUsd)).status).toBe(403);
    expect((await refund(d, "5", cashUsd)).status).toBe(201);
    await byHand(c, "0", "71.03");
    await byHand(d, "0", "-5.00");
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N3a: a return never pays out in cash the dollars on a franc balance with no francs", async () => {
    const product = await call("POST", "/api/products", { name: `Pièce N3a ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "100" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const v = product.body.variants[0].id;
    const stock = await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: v, qtyChange: "2", unitCost: "40" }] });
    expect(stock.status, JSON.stringify(stock.body)).toBeLessThan(300);
    // 100 $ sold on credit, then 0 FC / -71,03 $ on the customer's francs (as a close left one before N3b).
    const c = await contact("customer", "Client N3a retour");
    const sale = await call("POST", "/api/sales", { date: today, locationId, customerId: c, lines: [{ variantId: v, qty: "1", unitPrice: "100" }], payments: [] }, "gerant");
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    await byHand(c, "0", "-71.03");
    // Brought back: never paid for, it all comes off the 100 $ owed, and no cash goes back.
    const usd0 = await drawer(cashUsd);
    const back = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: today, lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }], refundAccountId: cashUsd, reason: "Retour" }, "gerant");
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.returns[0].refundToBalanceUsd).toBe("100.00");
    expect(await drawer(cashUsd)).toEqual(usd0);
    expect(await owed(c, "USD", receivables)).toEqual(["0.00", "0.00"]);
    await byHand(c, "0", "71.03");
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });
});
