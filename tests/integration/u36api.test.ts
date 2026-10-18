import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/**
 * U36: the till learns before "Valider" that a list price is below cost. The variants list says so for
 * each item (listBelowCost) without giving a cashier the cost; the sale's guard is unchanged.
 */
describe.skipIf(!hasDb)("Thirty-first UI audit", async () => {
  const { createApp } = await import("../../server/index");
  let server: Server;
  let base = "";
  const cookies: Record<string, string> = {};
  async function call<T = any>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookies[who] ? { cookie: cookies[who] } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookies[who] = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const owner = (method: string, path: string, body?: unknown) => call("owner", method, path, body);
  const cashier = (method: string, path: string, body?: unknown) => call("cashier", method, path, body);
  let locationId: number, cashUsd: number, moto: number, low: number, fine: number, today: string;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await owner("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await owner("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await cashier("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" })).status).toBe(200);
    today = (await owner("GET", "/api/settings")).body.today;
    cashUsd = ((await owner("GET", "/api/accounts")).body as any[]).find((a) => a.systemKey === "cash_usd").id;
    locationId = (await owner("GET", "/api/locations")).body[0].id;
    moto = (await owner("POST", "/api/products", { name: "Moto U36", unit: "pcs", variants: [{ attributes: {}, sellPrice: "1450" }] })).body.variants[0].id;
    low = (await owner("POST", "/api/products", { name: "Huile U36", unit: "pcs", variants: [{ attributes: {}, sellPrice: "10" }] })).body.variants[0].id;
    fine = (await owner("POST", "/api/products", { name: "Pneu U36", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] })).body.variants[0].id;
    const stock = await owner("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: moto, qtyChange: "2", unitCost: "1567.53" }, { variantId: low, qtyChange: "3", unitCost: "10.004" }, { variantId: fine, qtyChange: "5", unitCost: "8" }] });
    expect(stock.status, JSON.stringify(stock.body)).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("says which list prices are below cost, to a cashier without the cost", async () => {
    const rows = (await cashier("GET", `/api/variants?ids=${moto},${fine}&locationId=${locationId}`)).body as any[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(moto).listBelowCost).toBe(true);
    expect(byId.get(fine).listBelowCost).toBe(false);
    expect(byId.get(moto).avgCost).toBeUndefined();
    expect(byId.get(moto).stockValue).toBeUndefined();
  });

  it("goes by the cost to the cent a sale books: 10,00 $ against 10,004 $ is not below it", async () => {
    // 3 at 10,004 $ are worth 30,01 $: one piece costs 10,00 $ to the cent, so a 10 $ sale passes.
    const rows = (await owner("GET", `/api/variants?ids=${low}`)).body as any[];
    expect(rows[0].stockValue).toBe("30.01");
    expect(rows[0].listBelowCost).toBe(false);
  });

  it("keeps the sale's guard: a cashier selling below cost is still refused", async () => {
    expect((await owner("PATCH", `/api/variants/${low}`, { sellPrice: "9.99" })).status).toBe(200);
    expect(((await cashier("GET", `/api/variants?ids=${low}`)).body as any[])[0].listBelowCost).toBe(true);
    const sale = await cashier("POST", "/api/sales", { date: today, locationId, lines: [{ variantId: low, qty: "1", unitPrice: "9.99" }], payments: [{ accountId: cashUsd, amount: "9.99" }] });
    expect(sale.status).toBe(403);
    expect(sale.body.message ?? JSON.stringify(sale.body)).toMatch(/too low|trop bas/);
  });
});
