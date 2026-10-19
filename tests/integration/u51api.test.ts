import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U51: the till asks the server, before "Valider", which lines a cashier's sale would be refused as below cost
 * (price-check), so a price typed on a 0 $ item is said too low on the line and not as a 403 after. A yes or
 * no per item: the cost itself is never given.
 */
describe.skipIf(!hasDb)("Forty-sixth UI audit", async () => {
  const { createApp } = await import("../../server/index");
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
  let locationId: number, mirror: number, tyre: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Gérant", role: "manager", password: "manager-pass" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" }, "caisse")).status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "manager-pass" }, "gerant")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    // The audit's Rétroviseur: 0 $ in the catalogue, 3 at 35 $ (11,67 $ each); and a tyre at 54 $ costing 30 $.
    const m = await call("POST", "/api/products", { name: "Rétroviseur U51", unit: "pcs", variants: [{ attributes: {}, sellPrice: "0" }] });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    mirror = m.body.variants[0].id;
    const p = await call("POST", "/api/products", { name: "Pneu U51", unit: "pcs", variants: [{ attributes: {}, sellPrice: "54" }] });
    tyre = p.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: mirror, qtyChange: "3", unitCost: "11.666667" }, { variantId: tyre, qtyChange: "20", unitCost: "30" }] })).status).toBe(201);
  });
  afterAll(() => server?.close());

  it("says which lines a cashier's sale would refuse, as the sale itself judges them", async () => {
    const check = (lines: unknown[], who = "caisse") => call<{ refused: number[] }>("POST", "/api/sales/price-check", { lines }, who);
    // 5 $ on a piece costing 11,67 $: refused; 12 $: not.
    let r = await check([{ variantId: mirror, qty: "1", amount: "5.00" }, { variantId: tyre, qty: "1", amount: "54.00" }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ refused: [mirror] });
    expect((await check([{ variantId: mirror, qty: "1", amount: "12.00" }])).body).toEqual({ refused: [] });
    // Judged on the value the sale would book: all 3 pieces are the whole 35 $, so 34,99 $ is refused and 35 $ not.
    expect((await check([{ variantId: mirror, qty: "3", amount: "34.99" }])).body).toEqual({ refused: [mirror] });
    expect((await check([{ variantId: mirror, qty: "3", amount: "35.00" }])).body).toEqual({ refused: [] });
    // Two pieces at the average to the cent (23,33 $): 23,33 $ passes, 23,32 $ not.
    expect((await check([{ variantId: mirror, qty: "2", amount: "23.33" }])).body).toEqual({ refused: [] });
    expect((await check([{ variantId: mirror, qty: "2", amount: "23.32" }])).body).toEqual({ refused: [mirror] });
    // The same line twice is said once; an unknown item is left to the sale.
    expect((await check([{ variantId: mirror, qty: "1", amount: "1" }, { variantId: mirror, qty: "1", amount: "2" }, { variantId: 999999, qty: "1", amount: "0" }])).body).toEqual({ refused: [mirror] });
    // And the sale is refused on the same line, cost unsaid, exactly where the check said so.
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId: mirror, qty: "1", unitPrice: "5" }], payments: [{ accountId: (await call<any[]>("GET", "/api/accounts")).body.find((a: any) => a.systemKey === "cash_usd").id, amount: "5" }] }, "caisse");
    expect(sale.status).toBe(403);
    expect(sale.body.message).toBe("Rétroviseur U51: this price is too low. Ask the owner.");
    // The answer gives only ids: no cost, no value.
    expect(Object.keys(r.body)).toEqual(["refused"]);
  });

  it("refuses nothing for a manager allowed below cost, nor for the owner", async () => {
    const check = (lines: unknown[], who: string) => call<{ refused: number[] }>("POST", "/api/sales/price-check", { lines }, who);
    expect((await check([{ variantId: mirror, qty: "1", amount: "5.00" }], "gerant")).body).toEqual({ refused: [mirror] });
    expect((await call("PATCH", "/api/settings", { managerBelowCost: true })).status).toBe(200);
    expect((await check([{ variantId: mirror, qty: "1", amount: "5.00" }], "gerant")).body).toEqual({ refused: [] });
    expect((await check([{ variantId: mirror, qty: "1", amount: "5.00" }], "admin")).status).toBe(200);
    // A quantity of nothing, or a bad one, is refused as a request, not as a price.
    expect((await check([{ variantId: mirror, qty: "0", amount: "5.00" }], "caisse")).status).toBe(400);
    expect((await check([{ variantId: mirror, qty: "1", amount: "1.200" }], "caisse")).status).toBe(200);
  });
});
