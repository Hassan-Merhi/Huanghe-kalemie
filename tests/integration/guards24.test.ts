import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, parties } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A29: what the twenty-fourth accounting audit found after A28. */
describe.skipIf(!hasDb)("Guards found by the twenty-fourth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const checks = await import("../../server/services/checks");
  const payroll = await import("../../server/services/payroll");
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
  const yesterday = dayOffset(-1);
  // The month before this one, closed in N2 (nothing is dated before it).
  const [ty, tm] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  let cashUsd: number, cashCdf: number, openingEquity: number, fx: number, payables: number, receivables: number, transport: number, locationId: number;
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
    transport = accs.find((a) => a.type === "expense" && !a.systemKey && a.code !== "6010")!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of [
      [`${prev}-01`, "2800", "7.1"],
      [`${prev}-20`, "2900", "7.3"],
      [yesterday, "2790", "7.1"],
      [today, "2808", "7.1"],
    ]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd, cnyPerUsd })).status).toBeLessThan(300);
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
  /** A contact's balance on an account (all accounts when none is given) in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CDF" | "CNY", accountId?: number) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(accountId ? eq(journalLines.accountId, accountId) : sql`true`, eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  async function usdOf(accountId: number) {
    const [r] = await db.select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` }).from(journalLines).where(eq(journalLines.accountId, accountId));
    return r.usd;
  }
  async function journalSums(journalId: number) {
    const rows = await db.select().from(journalLines).where(eq(journalLines.journalId, journalId));
    const net = (accountId: number) => rows.filter((l) => l.accountId === accountId).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0).toFixed(2);
    return { rows, net };
  }
  /** A journal posted by hand, exactly as given: `native` owed to the contact, booked at `usd` against opening equity. */
  async function byHand(accountId: number, partyId: number, currency: "CDF" | "CNY", native: string, usd: string, rate: string) {
    await db.transaction((tx) =>
      ledger.postJournal(tx, {
        date: today,
        type: "manual",
        memo: "Saisie à la main",
        exactValues: true,
        lines: [
          { accountId, partyId, credit: usd, currency, nativeAmount: native, rate },
          { accountId: openingEquity, debit: usd },
        ],
      }),
    );
  }
  const foreignCheck = async () => (await checks.selfCheck(db)).checks.find((c) => c.key === "foreign_balances")!;
  const refund = (partyId: number, amount: string, accountId = cashCdf) =>
    call("POST", "/api/vouchers/payment", { date: today, accountId, lines: [{ partyId, amount }] }, "gerant");

  it("N1: francs worth under half a cent left at a cent by ordinary postings are cleared, and no cent leaves a drawer", async () => {
    expect((await checks.selfCheck(db)).ok).toBe(true);
    // 28 014 FC paid in yesterday (2 790) are 10,04 $; 28 000 FC given back today at their average cost are
    // 10,03 $. The 14 FC left (0,4985 cent at 2 808) were booked at 0,01 $: the refund clears both.
    const c = await contact("customer", "Client N1");
    const usd0 = await usdOf(cashUsd);
    for (let i = 0; i < 3; i++) {
      expect((await call("POST", "/api/money/customer-receipt", { date: yesterday, partyId: c, accountId: cashCdf, amount: "28014" }, "gerant")).status).toBe(201);
      expect(await owed(c, "CDF", receivables)).toEqual(["-28014.00", "-10.04"]);
      const back = await refund(c, "28000");
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      const j = await journalSums(back.body.id);
      const line = j.rows.find((l) => l.memo === ledger.RESIDUE_MEMO);
      expect([line?.nativeAmount, line?.debit, line?.credit]).toEqual(["14.00", "0.01", "0.00"]);
      // The drawer gives the 28 000 FC (at its own average cost), nothing more; the cent goes to exchange differences.
      const out = j.rows.filter((l) => l.accountId === cashCdf).reduce((t, l) => t + Number(l.nativeAmount), 0);
      expect([out.toFixed(2), j.net(cashUsd), j.net(receivables)]).toEqual(["-28000.00", "0.00", "10.04"]);
      expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
      // Nothing is left to refund, in francs or in dollars, cycle after cycle (A27).
      expect((await refund(c, "100")).status).toBe(403);
      expect((await refund(c, "0.01", cashUsd)).status).toBe(403);
    }
    expect(await usdOf(cashUsd)).toBe(usd0);
    expect((await foreignCheck()).ok).toBe(true);

    // The same on a supplier: a franc expense on credit yesterday, 28 000 FC paid today.
    const s = await contact("supplier", "Fournisseur N1");
    const bill = await call("POST", "/api/expenses", { date: yesterday, accountId: transport, description: "Transport", amount: "28014", currency: "CDF", payablePartyId: s }, "gerant");
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect(await owed(s, "CDF", payables)).toEqual(["-28014.00", "-10.04"]);
    const paid = await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashCdf, amount: "28000" }, "gerant");
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await owed(s, "CDF", payables)).toEqual(["0.00", "0.00"]);
    expect((await journalSums(paid.body.id)).net(payables)).toBe("10.04");

    // The self-check takes a cent on such francs as a rounding (an older one waits for the next posting
    // on the contact), and still shows more than a cent on them.
    const c2 = await contact("customer", "Client N1b");
    await byHand(receivables, c2, "CDF", "14", "0.01", "2808");
    const c3 = await contact("customer", "Client N1c");
    await byHand(receivables, c3, "CDF", "14", "0.02", "2808");
    const check = await foreignCheck();
    expect([check.ok, check.actual, check.details?.[0].value]).toEqual([false, "1", "-14.00 FC ≠ -0.02 $"]);
    expect(check.details?.[0].label).toMatch(/^Client N1c /);
    for (const p of [c2, c3]) expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: p, accountId: cashUsd, amount: "1" }, "gerant")).status).toBe(201);
    expect(await owed(c2, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect(await owed(c3, "CDF", receivables)).toEqual(["-14.00", "-0.02"]);
    // Corrected by hand, the next posting clears it and all agrees.
    await db.transaction((tx) =>
      ledger.postJournal(tx, {
        date: today,
        type: "manual",
        memo: "Correction",
        exactValues: true,
        lines: [
          { accountId: receivables, partyId: c3, debit: "0.02", currency: "CDF", nativeAmount: "0", rate: "2808" },
          { accountId: openingEquity, credit: "0.02" },
        ],
      }),
    );
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c3, accountId: cashUsd, amount: "1" }, "gerant")).status).toBe(201);
    expect(await owed(c3, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N2: a reversal after a month close takes the revaluation's dollars off the balance it empties", async () => {
    // 1 000 001 FC received, a yuan bill and franc salaries, all last month, which is then closed: the
    // revaluation restates them at the month's last rate.
    const c = await contact("customer", "Client N2");
    const receipt = await call("POST", "/api/money/customer-receipt", { date: `${prev}-05`, partyId: c, accountId: cashCdf, amount: "1000001" });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const s = await contact("supplier", "Fournisseur N2");
    const product = await call("POST", "/api/products", { name: `Pièce N2 ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "300" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const box = await call("POST", "/api/containers", { number: `N2-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "3", unitPrice: "1001.01" }] })).status).toBe(200);
    const offload = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: `${prev}-05` });
    expect(offload.status, JSON.stringify(offload.body)).toBe(200);
    const [emp] = await db.insert(parties).values({ type: "employee", name: `Employé N2 ${uniq()}`, monthlySalary: "1" }).returning();
    const run = await call("POST", "/api/payroll/runs", { month: prev, date: `${prev}-15`, accountId: (await payroll.salaryAccountId(db))!, currency: "CDF", lines: [{ partyId: emp.id, salary: "700001" }] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const close = await call("POST", `/api/periods/${prev}/close`, {});
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect((await checks.selfCheck(db)).ok).toBe(true);
    const revalued = async (partyId: number, currency: "CDF" | "CNY") => {
      const [r] = await db.execute<{ usd: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as usd from journal_lines l join journals j on j.id = l.journal_id
        where j.type = 'revaluation' and l.party_id = ${partyId} and l.currency = ${currency}`).then((x) => x.rows);
      return r.usd;
    };
    const [onCustomer, onSupplier, onEmployee] = [await revalued(c, "CDF"), await revalued(s, "CNY"), await revalued(emp.id, "CDF")];
    for (const v of [onCustomer, onSupplier, onEmployee]) expect(v).not.toBe("0.00");

    // The receipt reversed today: the francs go back at what they were received at, and the
    // revaluation's dollars go to exchange differences in the same journal. The drawer is exact.
    const fx0 = await usdOf(fx);
    const rev = await call("POST", `/api/journals/${receipt.body.id}/reverse`, { date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(await owed(c, "CDF", receivables)).toEqual(["0.00", "0.00"]);
    const j = await journalSums(rev.body.id);
    const cleared = j.rows.filter((l) => l.memo === ledger.REVALUED_MEMO && l.accountId === receivables);
    expect(cleared.map((l) => [l.nativeAmount, (Number(l.debit) - Number(l.credit)).toFixed(2)])).toEqual([["0.00", (-Number(onCustomer)).toFixed(2)]]);
    expect(j.net(fx)).toBe(onCustomer);
    const [orig] = await db.select({ usd: sql<string>`sum(${journalLines.debit})::numeric(20,2)::text` }).from(journalLines).where(and(eq(journalLines.journalId, receipt.body.id), eq(journalLines.accountId, cashCdf)));
    expect(j.net(cashCdf)).toBe((-Number(orig.usd)).toFixed(2));

    // The container reversed: the yuan owed go back, and so do the revaluation's dollars on them.
    const back = await call("POST", `/api/containers/${box.body.id}/reverse`, { date: today });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);

    // The salaries cancelled: the employee's francs and their revaluation go too.
    expect((await call("POST", `/api/payroll/runs/${prev}/cancel`, { date: today })).status).toBe(200);
    expect(await owed(emp.id, "CDF")).toEqual(["0.00", "0.00"]);
    expect((Number(await usdOf(fx)) - Number(fx0)).toFixed(2)).toBe((Number(onCustomer) + Number(onSupplier) + Number(onEmployee)).toFixed(2));
    expect((await checks.selfCheck(db)).ok).toBe(true);

    // Dollars that no revaluation put there (a journal posted by hand) are not an exchange difference:
    // a reversal that empties the francs leaves them, for the self-check to show.
    const c2 = await contact("customer", "Client N2b");
    await byHand(receivables, c2, "CDF", "0", "5.00", "2808");
    const r2 = await call("POST", "/api/money/customer-receipt", { date: today, partyId: c2, accountId: cashCdf, amount: "28080" });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect((await call("POST", `/api/journals/${r2.body.id}/reverse`, { date: today })).status).toBe(200);
    expect(await owed(c2, "CDF", receivables)).toEqual(["0.00", "-5.00"]);
    const check = await foreignCheck();
    expect([check.ok, check.details?.[0].value]).toEqual([false, "0.00 FC ≠ -5.00 $"]);
  });
});
