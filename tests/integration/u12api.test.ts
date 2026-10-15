import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U12: franc rounding counted in francs, a sale line's unit for returns, an expense memo said once. */
describe.skipIf(!hasDb)("Seventh UI audit", async () => {
  const { createApp } = await import("../../server/index");
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
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let accounts: any[] = [];
  let cashUsd: number, cashCdf: number, locationId: number, variantId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Pneu 2.75-17", unit: "pcs", variants: [{ attributes: {}, sellPrice: "27" }] });
    variantId = product.body.variants[0].id;
    const adj = await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "15" }] });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    // Francs in the drawer, so change and refunds can be paid in francs.
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, rate: "2808", lines: [{ accountId: otherIncome, amount: "280800" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("does not take 116 FC short as rounding, though 0,04 $ would let it through; 100 FC short still is", async () => {
    // 27,00 $ at 2 808 = 75 816 FC. 75 700 FC are worth 26,96 $: 0,04 $ short, but 116 FC.
    const short = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75700" }] });
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body)).toMatch(/crédit|credit/);
    const ok = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75716" }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.creditUsd).toBe("0.00");
    // Mixed: 20 $ and 19 600 FC on 27 $ (7 $ = 19 656 FC) is 56 FC short: rounding.
    const mixed = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "20" }, { accountId: cashCdf, amount: "19600" }] });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
    expect(mixed.body.creditUsd).toBe("0.00");
  });

  it("gives each sale line its unit, so a return can ask about \"1.000\" pieces", async () => {
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "2", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "54" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.lines[0].unit).toBe("pcs");
    expect((await call("GET", `/api/sales/${sale.body.id}`)).body.lines[0].unit).toBe("pcs");
  });

  it("does not repeat an expense's category when the description is its name", async () => {
    const fuel = accounts.find((a) => a.code === "6070");
    const same = await call("POST", "/api/expenses", { date: today, accountId: fuel.id, description: "carburant du groupe electrogene", amount: "10", paidFromAccountId: cashUsd });
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    expect((await call("GET", `/api/vouchers/${same.body.journalId}`)).body.memo).toBe(fuel.name);
    const other = await call("POST", "/api/expenses", { date: today, accountId: fuel.id, description: "Gasoil du 12", amount: "10", paidFromAccountId: cashUsd });
    expect((await call("GET", `/api/vouchers/${other.body.journalId}`)).body.memo).toBe(`${fuel.name} : Gasoil du 12`);
  });
});
