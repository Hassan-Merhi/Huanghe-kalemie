import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals, stockMovements } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A37: what the thirty-second accounting audit found after A36 (the yuan date-order guard, memos, a cost shown). */
describe.skipIf(!hasDb)("Guards found by the thirty-second audit", async () => {
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
  // Last month: yuan at 7,2 (the containers are billed at 0,140845, about 7,1), so its close revalues them.
  const [ty, tm] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  let cashUsd: number, cashCdf: number, openingEquity: number, payables: number, rent: number, locationId: number;
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
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Paul Caisse", role: "cashier", password: "caisse12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "caisse12345" }, "caisse")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    rent = accs.find((a) => a.type === "expense" && !a.systemKey)!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of [
      [`${prev}-01`, "2800", "7.1"],
      [`${prev}-28`, "2800", "7.2"],
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

  async function contact(name: string) {
    const r = await call("POST", "/api/parties", { type: "supplier", name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** A contact's balance on payables in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CNY") {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  /** A supplier's container of 3 000 ¥ at 0,140845, not offloaded yet. */
  async function container(s: number) {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const box = await call("POST", "/api/containers", { number: `A37-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "3", unitPrice: "1000" }] })).status).toBe(200);
    return box.body.id as number;
  }
  const offload = async (box: number, offloadDate: string) => {
    const r = await call("POST", `/api/containers/${box}/finalize`, { offloadDate });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const pay = (s: number, amount: string, date: string, settleNative?: string, who = "gerant") =>
    call("POST", "/api/money/party-payment", { date, partyId: s, accountId: cashUsd, amount, ...(settleNative ? { settleNative } : {}) }, who);
  /** No supplier left with no yuan but some dollars on their yuan. */
  const noResidue = async () =>
    (
      await db.execute(sql`select party_id from journal_lines where account_id = ${payables} and currency = 'CNY' group by party_id having sum(native_amount) = 0 and sum(debit - credit) <> 0`)
    ).rows;

  it("N2: a deposit taken by a bill dated before it is applied on the deposit's own day, not today", async () => {
    const s = await contact("Fournisseur N2");
    const [c1, c2] = [await container(s), await container(s)];
    const deposit = await pay(s, "200", `${prev}-08`);
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(201);
    await offload(c1, `${prev}-05`);
    const [applied] = await db.select({ date: journals.date }).from(journals).where(and(eq(journals.sourceType, "advance_container"), eq(journals.sourceId, c1)));
    expect(applied.date).toBe(`${prev}-08`);
    expect(await owed(s, "USD")).toEqual(["0.00", "0.00"]);
    // Yuan work dated after the deposit, before today, is no longer refused for the date the books chose.
    await offload(c2, `${prev}-09`);
    for (const d of ["11", "12"]) {
      const r = await pay(s, "140.85", `${prev}-${d}`, "1000");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const back = await call("POST", `/api/containers/${c1}/reverse`, { date: `${prev}-15` });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // The deposit given back with the bill that took it, on its own day.
    expect((await owed(s, "USD"))[1]).toBe("200.00");
    // What the guard is for still holds: before a real yuan movement, refused.
    const early = await pay(s, "140.85", `${prev}-13`, "1000");
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("YUAN_DATE_ORDER");
    expect(await noResidue()).toEqual([]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("N3: a books' own memo is refused however it is typed: no apostrophe, punctuation, an invisible space", async () => {
    for (const memo of [
      "Ecart de change a lannulation",
      "Écart de change à l'annulation.",
      "Écart de change​ à l'annulation",
      "  ÉCART-DE-CHANGE (coût moyen des devises) !",
      "Ecart de change cout moyen des devises",
      "Reste de moins d'un demi­centime soldé en écart de change",
      "Écart de change du règlement repris à l’annulation…",
    ]) {
      expect(() => ledger.assertMemoNotReserved(memo, 1), memo).toThrow(/books make themselves/);
    }
    for (const memo of ["Écart de change du mois", "Change à l'annulation", "Loyer"]) expect(() => ledger.assertMemoNotReserved(memo, 1)).not.toThrow();
    const r = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ accountId: rent, amount: "5", memo: "Ecart de change a lannulation." }] }, "gerant");
    expect(r.status).toBe(400);
    expect(r.body.messageFr).toContain("libellé d'une écriture");
  });

  it("N4: 1 L imported at 0,125 $ shows 0,125 $, its value and the journal staying to the cent", async () => {
    const tag = uniq().toUpperCase();
    const r = await call("POST", "/api/import/items", {
      date: today,
      locationId,
      rows: [
        { name: `Huile A37 ${tag}`, unit: "litre", size: "1 L", sku: `OIL1-${tag}`, sellPrice: "1", qty: "1", unitCost: "0.125" },
        { name: `Huile A37 ${tag}`, unit: "litre", size: "2,25 L", sku: `OIL2-${tag}`, sellPrice: "1", qty: "2.25", unitCost: "0.125" },
        { name: `Câble A37 ${tag}`, unit: "m", sku: `CAB-${tag}`, sellPrice: "1", qty: "3", unitCost: "0.333333" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const stock = await call<any>("GET", "/api/stock");
    const item = (sku: string) => stock.body.items.find((i: any) => i.sku === sku);
    expect([item(`OIL1-${tag}`).value, item(`OIL1-${tag}`).avgCost]).toEqual(["0.13", "0.125000"]);
    expect([item(`OIL2-${tag}`).value, item(`OIL2-${tag}`).avgCost]).toEqual(["0.28", "0.125000"]);
    // What no rounder figure tells apart is kept as entered too.
    expect([item(`CAB-${tag}`).value, item(`CAB-${tag}`).avgCost]).toEqual(["1.00", "0.333333"]);
    expect(stock.body.reconciled).toBe(true);
    // The movement keeps the cost per unit; the journal the value to the cent.
    const moved = await db.select({ value: stockMovements.value, unitCost: stockMovements.unitCost }).from(stockMovements).where(eq(stockMovements.variantId, item(`OIL1-${tag}`).variantId));
    expect(moved).toEqual([{ value: "0.13", unitCost: "0.125000" }]);
    const [journal] = await db.select({ debit: sql<string>`sum(${journalLines.debit})::text` }).from(journalLines).where(eq(journalLines.journalId, r.body.adjustment.journalId));
    expect(journal.debit).toBe("1.41");
    // The item's page and search show it by the same rule; never to a cashier.
    const product = await call<any>("GET", `/api/products/${item(`OIL1-${tag}`).productId}`);
    expect(product.body.variants.find((v: any) => v.sku === `OIL1-${tag}`).keptUnitCost).toBe("0.125000");
    const found = await call<any[]>("GET", `/api/variants?search=OIL1-${tag}`, undefined, "caisse");
    expect(found.body[0]).not.toHaveProperty("keptUnitCost");
    expect(found.body[0]).not.toHaveProperty("avgCost");
    // Parts taken out at the average: still 0,125 $ while that gives the value to the cent.
    const leak = async (qtyChange: string) => {
      const out = await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "damage", reason: "Fuite", lines: [{ variantId: item(`OIL2-${tag}`).variantId, qtyChange }] });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      const now = (await call<any>("GET", "/api/stock")).body.items.find((i: any) => i.sku === `OIL2-${tag}`);
      return [now.value, now.avgCost];
    };
    expect(await leak("-0.25")).toEqual(["0.25", "0.125000"]);
    expect(await leak("-1.25")).toEqual(["0.09", "0.125000"]);
    // Stock at two costs: the latest one no longer gives the value, so the rule before (value ÷ qty, roundest).
    const more = await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "found", reason: "Retrouvé", lines: [{ variantId: item(`OIL1-${tag}`).variantId, qtyChange: "1", unitCost: "0.2" }] });
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    const mixed = (await call<any>("GET", "/api/stock")).body.items.find((i: any) => i.sku === `OIL1-${tag}`);
    expect([mixed.value, mixed.avgCost]).toEqual(["0.33", "0.165000"]);
  });

  it("N1: a reopened month takes yuan work dated before its end; closed again, nothing is left on no yuan", async () => {
    const s = await contact("Fournisseur N1");
    const box = await container(s);
    await offload(box, `${prev}-10`);
    expect((await pay(s, "211.27", `${prev}-15`, "1500")).status).toBe(201);
    const t = await contact("Fournisseur N1 bis");
    const kept = await container(t);
    await offload(kept, `${prev}-10`);
    expect((await pay(t, "140.85", `${prev}-15`, "1000")).status).toBe(201);
    const close = await call("POST", `/api/periods/${prev}/close`, {});
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect((await call("POST", `/api/periods/${prev}/reopen`, {})).status).toBe(200);
    // The month's revaluation and its reversal are dated its last day, and move no yuan.
    const dates = await db.execute<{ date: string; type: string }>(sql`select j.date::text, j.type from journal_lines l join journals j on j.id = l.journal_id where l.party_id = ${s} and l.currency = 'CNY' and j.type = 'revaluation'`);
    expect(dates.rows.length).toBe(2);
    for (const who of ["gerant", "admin"]) {
      const r = await pay(t, "70.43", `${prev}-20`, "500", who);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const back = await call("POST", `/api/containers/${box}/reverse`, { date: `${prev}-25` });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // Still refused before a real yuan movement, the owner's too.
    const early = await pay(t, "70.43", `${prev}-18`, "500", "admin");
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("YUAN_DATE_ORDER");
    const again = await call("POST", `/api/periods/${prev}/close`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await owed(s, "CNY"))[0]).toBe("1500.00");
    expect((await owed(t, "CNY"))[0]).toBe("-1000.00");
    expect(await noResidue()).toEqual([]);
    // The rest paid after: no yuan and no dollars left.
    const rest = await pay(t, "138.89", today, "1000");
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(await owed(t, "CNY")).toEqual(["0.00", "0.00"]);
    expect(await noResidue()).toEqual([]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });
});
