import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A28: what the twenty-third accounting audit found after A27. */
describe.skipIf(!hasDb)("Guards found by the twenty-third audit", async () => {
  const { createApp } = await import("../../server/index");
  const ledger = await import("../../server/services/ledger");
  const checks = await import("../../server/services/checks");
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  let cashUsd: number, cashCdf: number, openingEquity: number, fx: number, payables: number, receivables: number;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    fx = accs.find((a) => a.systemKey === "fx")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    receivables = accs.find((a) => a.systemKey === "receivables")!.id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    const opening = await call("POST", "/api/journals", {
      date: today,
      memo: "Ouverture",
      type: "opening",
      lines: [
        { accountId: cashUsd, debit: "1000" },
        { accountId: cashCdf, debit: "1000", nativeAmount: "2808000", rate: "2808" },
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
  async function owed(partyId: number, currency: "USD" | "CDF" | "CNY", accountId: number) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, accountId), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  async function usdOf(accountId: number) {
    const [r] = await db.select({ usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` }).from(journalLines).where(eq(journalLines.accountId, accountId));
    return r.usd;
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
  const residueLines = async () => (await db.select().from(journalLines).where(eq(journalLines.memo, ledger.RESIDUE_MEMO))).length;

  it("H1: francs or yuan under half a cent that carry dollars are left for a person to correct, and the self-check shows them", async () => {
    expect((await checks.selfCheck(db)).ok).toBe(true);
    // The manual journal screen books a contact's line in dollars, whatever francs are typed on it.
    const c0 = await contact("customer", "Client H1 écran");
    const typed = await call("POST", "/api/journals", {
      date: today,
      memo: "Avance",
      lines: [
        { accountId: receivables, partyId: c0, credit: "5", nativeAmount: "10", rate: "2808" },
        { accountId: cashUsd, debit: "5" },
      ],
    });
    expect(typed.status, JSON.stringify(typed.body)).toBe(201);
    expect([await owed(c0, "CDF", receivables), await owed(c0, "USD", receivables)]).toEqual([["0.00", "0.00"], ["0.00", "-5.00"]]);

    // 10 FC (0,36 cent) booked at 5 $, and 0,03 ¥ (0,4 cent) booked at 2 $: the next postings on those
    // contacts do not move the dollars to exchange differences.
    const c1 = await contact("customer", "Client H1");
    await byHand(receivables, c1, "CDF", "10", "5.00", "2808");
    const s1 = await contact("supplier", "Fournisseur H1");
    await byHand(payables, s1, "CNY", "0.03", "2.00", "7.1");
    const [fx0, residues0] = [await usdOf(fx), await residueLines()];
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c1, accountId: cashUsd, amount: "3" })).status).toBe(201);
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: c1, accountId: cashCdf, amount: "2808" })).status).toBe(201);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s1, accountId: cashUsd, amount: "1" })).status).toBe(201);
    expect([await usdOf(fx), await residueLines()]).toEqual([fx0, residues0]);
    expect(await owed(c1, "CDF", receivables)).toEqual(["-2818.00", "-6.00"]);
    expect(await owed(s1, "CNY", payables)).toEqual(["-0.03", "-2.00"]);

    // The self-check points at the yuan (the francs are now worth more than half a cent).
    const check = await foreignCheck();
    expect([check.ok, check.actual]).toEqual([false, "1"]);
    expect(check.details?.[0].value).toBe("-0.03 ¥ ≠ -2.00 $");
    expect(check.details?.[0].label).toMatch(/^Fournisseur H1 .* · ¥$/);

    // Once the 2 $ are corrected by hand, the next posting clears the yuan with no money, and all agrees.
    await db.transaction((tx) =>
      ledger.postJournal(tx, {
        date: today,
        type: "manual",
        memo: "Correction",
        exactValues: true,
        lines: [
          { accountId: payables, partyId: s1, debit: "2.00", currency: "CNY", nativeAmount: "0", rate: "7.1" },
          { accountId: openingEquity, credit: "2.00" },
        ],
      }),
    );
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: s1, accountId: cashUsd, amount: "1" })).status).toBe(201);
    expect(await owed(s1, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect([await usdOf(fx), await residueLines()]).toEqual([fx0, residues0 + 1]);
    expect((await foreignCheck()).ok).toBe(true);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });
});
