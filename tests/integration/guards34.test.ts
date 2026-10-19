import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A39: what the thirty-fourth accounting audit found after A38 (a month reopened after a reversal, a franc bill's deposits, memos). */
describe.skipIf(!hasDb)("Guards found by the thirty-fourth audit", async () => {
  const { createApp } = await import("../../server/index");
  const checks = await import("../../server/services/checks");
  const ledger = await import("../../server/services/ledger");
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
  // Last month: yuan at 7,1 until its last day, 6,9 on it (so its close revalues the yuan owed), 7,1 again today.
  const [ty, tm] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  const prevEnd = new Date(Date.UTC(ty, tm - 1, 0)).toISOString().slice(0, 10);
  let cashUsd: number, cashCdf: number, openingEquity: number, payables: number, fx: number, locationId: number;
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
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    fx = accs.find((a) => a.systemKey === "fx")!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of [
      [`${prev}-01`, "2800", "7.1"],
      [prevEnd, "2810", "6.9"],
      [today, "2800", "7.1"],
    ]) {
      const r = await call("POST", "/api/exchange-rates", { date, cdfPerUsd, cnyPerUsd });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
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

  async function contact(name: string) {
    const r = await call("POST", "/api/parties", { type: "supplier", name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** A contact's balance on payables in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CNY" | "CDF") {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  /** A supplier's container of 2 000 ¥ at 0,140845 (or 600 000 FC at 0,000357), not offloaded yet. */
  async function container(s: number, currency: "CNY" | "CDF", quantity = "2", unitPrice = currency === "CNY" ? "1000" : "300000") {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const box = await call("POST", "/api/containers", { number: `A39-${uniq()}`, supplierId: s, locationId, currency, rateToUsd: currency === "CNY" ? "0.140845" : "0.000357", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity, unitPrice }] })).status).toBe(200);
    return box.body.id as number;
  }
  const offload = async (box: number, offloadDate: string) => {
    const r = await call("POST", `/api/containers/${box}/finalize`, { offloadDate });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const pay = async (s: number, amount: string, date: string, accountId = cashUsd) => {
    const r = await call("POST", "/api/money/party-payment", { date, partyId: s, accountId, amount }, "gerant");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const foreignOk = async () => (await checks.selfCheck(db)).checks.find((c) => c.key === "foreign_balances")!;
  /** Exchange differences booked, the month closes' own journals aside. */
  const fxBooked = async () => {
    const [r] = await db
      .select({ v: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(eq(journalLines.accountId, fx), ne(journals.type, "period_close")));
    return r.v;
  };

  it("F2: a franc bill dated back takes the francs paid for it before a dollar deposit paid earlier", async () => {
    const s = await contact("Fournisseur F2");
    const box = await container(s, "CDF", "1", "100000");
    await pay(s, "100", `${prev}-06`);
    await pay(s, "100000", `${prev}-07`, cashCdf);
    await offload(box, `${prev}-05`);
    // The francs paid settle the francs owed (the cent between their rate and the bill's to exchange
    // differences, on the day they were paid); the dollar deposit stays whole.
    expect(await owed(s, "CDF")).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD")).toEqual(["0.00", "100.00"]);
    const applied = await db.select().from(journals).where(eq(journals.sourceType, "advance_container"));
    expect(applied.filter((j) => j.sourceId === box).map((j) => j.date)).toEqual([`${prev}-07`]);
    const [met] = await db.select().from(journalLines).where(and(eq(journalLines.journalId, applied.find((j) => j.sourceId === box)!.id), eq(journalLines.accountId, fx)));
    expect([met.kind, met.memo]).toEqual(["cost_fx", ledger.COST_FX_MEMO]);

    // Part of the francs paid: dollars take only the francs still owed, on the deposit's own day.
    const t = await contact("Fournisseur F2 part");
    const part = await container(t, "CDF", "1", "100000");
    await pay(t, "100", `${prev}-06`);
    await pay(t, "40000", `${prev}-07`, cashCdf);
    await offload(part, `${prev}-05`);
    const parts = await db
      .select({ date: journals.date, native: journalLines.nativeAmount })
      .from(journals)
      .innerJoin(journalLines, eq(journalLines.journalId, journals.id))
      .where(and(eq(journals.sourceType, "advance_container"), eq(journals.sourceId, part), eq(journalLines.currency, "CDF"), sql`${journalLines.kind} is null`));
    expect(parts).toEqual([{ date: `${prev}-06`, native: "60000.00" }]);
    expect(await owed(t, "CDF")).toEqual(["0.00", "0.00"]);
    expect(Number((await owed(t, "USD"))[1])).toBeGreaterThan(70);

    // No franc paid since: the dollar deposit settles the bill, as before.
    const u = await contact("Fournisseur F2 dollars");
    const dollars = await container(u, "CDF", "1", "100000");
    await pay(u, "100", `${prev}-06`);
    await offload(dollars, `${prev}-05`);
    expect(await owed(u, "CDF")).toEqual(["0.00", "0.00"]);
    expect(await owed(u, "USD")).toEqual(["0.00", "64.29"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
    // Undone, the bill gives back what it took: the francs paid are an advance at what they cost.
    expect((await call("POST", `/api/containers/${box}/reverse`, { date: today })).status).toBe(200);
    expect(await owed(s, "CDF")).toEqual(["100000.00", "35.71"]);
    expect(await owed(s, "USD")).toEqual(["0.00", "100.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F3: memo look-alikes of any alphabet, or a digit for a letter, are refused; notes in another alphabet pass", async () => {
    for (const memo of [
      "Écart de change (cօût moyen des devises)", // Armenian օ
      "Écart de change (c0ût moyen des devises)", // digit zero
      "ꭼcart de change (coût moyen des devises)", // Cherokee ꭼ
      "Ecart de change a l'annu1ation", // digit one
      "Réévaluatiοn sοldée : devises réglées après la fin du mοis",
    ]) {
      expect(() => ledger.assertMemoNotReserved(memo, 1), memo).toThrow(/books make themselves/);
    }
    for (const memo of ["Paiement fournisseur", "Оплата поставщику", "货款", "Réévaluation du mois", "Écart", "Facture 2024 de change (coût moyen)", "货".repeat(32), "д".repeat(32), "٣".repeat(32)]) {
      expect(() => ledger.assertMemoNotReserved(memo, 1), memo).not.toThrow();
    }
  });

  it("F1: a month reopened after a reversal emptied its revalued francs or yuan leaves them at none, and closing it again books the same", async () => {
    const cases: { s: number; box: number; currency: "CNY" | "CDF"; part: boolean }[] = [];
    for (const currency of ["CNY", "CDF"] as const) {
      for (const part of [false, true]) {
        const s = await contact(`Fournisseur F1 ${currency}${part ? " part" : ""}`);
        const box = await container(s, currency);
        await offload(box, `${prev}-25`);
        if (part) await pay(s, "100", `${prev}-27`);
        cases.push({ s, box, currency, part });
      }
    }
    expect((await call("POST", `/api/periods/${prev}/close`, {})).status).toBe(200);
    for (const c of cases) {
      const r = await call("POST", `/api/containers/${c.box}/reverse`, { date: today });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await checks.selfCheck(db)).ok).toBe(true);
    const before = await Promise.all(cases.map((c) => owed(c.s, c.currency)));
    const fxBefore = await fxBooked();
    // The yuan paid back are claimed at what was paid for them, whatever the revaluation said.
    expect(before[1]).toEqual(["710.00", "100.00"]);
    expect(before[0]).toEqual(["0.00", "0.00"]);
    expect(before[2]).toEqual(["0.00", "0.00"]);

    for (let round = 0; round < 2; round++) {
      expect((await call("POST", `/api/periods/${prev}/reopen`, {})).status).toBe(200);
      const check = await foreignOk();
      expect(check.ok, JSON.stringify(check.details)).toBe(true);
      expect((await checks.selfCheck(db)).ok).toBe(true);
      const open = await Promise.all(cases.map((c) => owed(c.s, c.currency)));
      expect(open[0]).toEqual(["0.00", "0.00"]);
      expect(open[1]).toEqual(["710.00", "100.00"]);
      expect(open[2]).toEqual(["0.00", "0.00"]);

      expect((await call("POST", `/api/periods/${prev}/close`, {})).status).toBe(200);
      expect((await checks.selfCheck(db)).ok).toBe(true);
      expect(await Promise.all(cases.map((c) => owed(c.s, c.currency)))).toEqual(before);
      expect(await fxBooked()).toBe(fxBefore);
    }
  });
});
