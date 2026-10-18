import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, sales } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U28: a till still on an older franc rate is refused rather than booked partly on credit; a quantity
 * "2,250" L typed as text in an import is 2,25. (U29: a price or cost typed "4,125" is asked about, not read.)
 */
describe.skipIf(!hasDb)("Twenty-third UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const { parseTypedAmount, ambiguousTypedAmount } = await import("@shared/money");
  const NB = " ";
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
  let cashUsd: number, cashCdf: number, locationId: number, tyre: number, customerId: number;
  const saleCount = async () => (await db.select({ id: sales.id }).from(sales)).length;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" }, "caisse")).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    const p = await call("POST", "/api/products", { name: "Pneu U28", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    tyre = p.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: tyre, qtyChange: "20", unitCost: "12" }] })).status).toBe(201);
    customerId = (await call("POST", "/api/parties", { type: "customer", name: "Atelier Lac" })).body.id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
  });
  afterAll(() => server?.close());

  const francSale = (tillRate?: string, extra: Record<string, unknown> = {}) => ({
    locationId,
    lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }],
    payments: [{ accountId: cashCdf, amount: "61800", rate: tillRate ?? "2808" }],
    ...(tillRate ? { tillRate } : {}),
    ...extra,
  });

  it("refuses a staff franc sale rung up at a rate the day no longer has, saying which", async () => {
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2900" })).status).toBeLessThan(300);
    const before = await saleCount();
    for (const who of ["caisse", "gerant"]) {
      // Walk-in or on account, the message is about the rate, not about credit.
      for (const extra of [{}, { customerId }]) {
        const stale = await call("POST", "/api/sales", francSale("2808", extra), who);
        expect(stale.status, who).toBe(409);
        expect(stale.body.messageFr).toBe(`Le taux du jour a changé (2${NB}808 → 2${NB}900${NB}FC)${NB}: vérifiez le paiement`);
      }
    }
    expect(await saleCount()).toBe(before);
    // At the rate the till now shows, 63 800 FC pay the 22 $ in full.
    const fresh = await call("POST", "/api/sales", francSale("2900", { payments: [{ accountId: cashCdf, amount: "63800" }] }), "caisse");
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(Number(fresh.body.creditUsd)).toBe(0);
  });

  it("keeps the rate optional, and checks it only when francs change hands", async () => {
    // An API caller that sends no rate is valued at the day's rate as before.
    const plain = await call("POST", "/api/sales", { locationId, customerId, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }], payments: [{ accountId: cashCdf, amount: "63800" }] }, "caisse");
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    // A dollar sale does not depend on the rate.
    const dollars = await call("POST", "/api/sales", { locationId, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }], payments: [{ accountId: cashUsd, amount: "22" }], tillRate: "2808" }, "caisse");
    expect(dollars.status, JSON.stringify(dollars.body)).toBe(201);
    // The owner's francs go at the rate typed on the sale (within the tolerance): nothing to check against.
    const owner = await call("POST", "/api/sales", { locationId, customerId, lines: [{ variantId: tyre, qty: "1", unitPrice: "22" }], payments: [{ accountId: cashCdf, amount: "62700", rate: "2850" }], tillRate: "2850" });
    expect(owner.status, JSON.stringify(owner.body)).toBe(201);
  });

  it("reads a quantity typed \"2,250\" L as 2,25 and asks about a cost typed \"4,125\", \"4.125\" or \"1,000\"", async () => {
    expect(parseTypedAmount("1 250,125")).toBe("1250.125");
    expect(parseTypedAmount("12,50")).toBe("12.50");
    expect(parseTypedAmount("1,415.51")).toBe("1415.51");
    expect(parseTypedAmount(4.125)).toBe("4.125");
    // U29: "4,125" is 4,125 in a French sheet and 4 125 in an English one: asked, like "4.125".
    expect(ambiguousTypedAmount("4,125")).toEqual(["4125", "4.125"]);
    expect(ambiguousTypedAmount("4.125")).toEqual(["4125", "4.125"]);
    expect(ambiguousTypedAmount("1,000")).toEqual(["1000", "1"]);

    // The audit's file: quantity "2,250" L as text, cost 4,125 $ and price 6,5 $ as number cells.
    const ok = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Huile U28", unit: "litre", qty: "2,250", unitCost: 4.125, sellPrice: 6.5 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const [v] = await db.transaction((tx) => catalog.searchVariants(tx, { search: "Huile U28" }));
    expect(Number(v.stockQty)).toBe(2.25);
    expect(Number(v.stockValue)).toBe(9.28);
    expect(Number(v.sellPrice)).toBe(6.5);

    const dot = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Huile U28b", unit: "litre", qty: "2", unitCost: "4.125" }] });
    expect(dot.status).toBe(422);
    expect(dot.body.messageFr).toBe(`«${NB}4.125${NB}»${NB}: 4${NB}125 ou 4,125${NB}? Pour 4${NB}125, écrivez 4125 sans séparateur${NB}; pour 4,125, écrivez-le comme nombre dans Excel.`);
    expect((await call("POST", "/api/import/prices", { rows: [{ sku: "X", sellPrice: "1,000" }] })).status).toBe(422);
  });
});
