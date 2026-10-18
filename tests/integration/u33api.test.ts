import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/**
 * U33: the Sales list says the francs a sale kept net of its refunds, so a refund at a higher rate than the
 * sale's (more francs back than were paid) reads in francs, not as the rounding's cents kept. Read only.
 */
describe.skipIf(!hasDb)("Twenty-eighth UI audit", async () => {
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
  const day = "2026-08-03";
  let cashCdf: number, cashUsd: number, locationId: number, variantId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: day, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: day, accountId: cashCdf, rate: "2808", lines: [{ accountId: otherIncome, amount: "1000000" }] })).status).toBe(201);
    const product = await call("POST", "/api/products", { name: "Plaquettes U33", unit: "pcs", variants: [{ attributes: {}, sellPrice: "25" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: day, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "5" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("lists the francs kept net of refunds, below zero when a refund at a higher rate gave back more", async () => {
    // 25 $ paid 70 200 FC at 2 808, refunded by the owner at 2 850: 71 200 FC back, 1 000 FC more than paid.
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "25" }], payments: [{ accountId: cashCdf, amount: "70200", rate: "2808" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    let rows = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body;
    expect(rows.find((r) => r.id === sale.body.id).fcNetNative).toBe("70200.00");
    const ret = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: day, reason: "Mauvaise référence", refundAccountId: cashCdf, rate: "2850", lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(300);
    expect(ret.body.returns[0].refundNative).toBe("71200.00");
    rows = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body;
    const row = rows.find((r) => r.id === sale.body.id);
    expect(row.fcNetNative).toBe("-1000.00");
    // The books are unchanged: at the refund's rate the shop kept 2 cents of rounding.
    expect(row.fcRoundingUsd).toBe("0.02");
  });

  it("says nothing for a sale that took dollars, even with its change in francs", async () => {
    // 25 $ paid 30 $, 14 000 FC back as change.
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "25" }], payments: [{ accountId: cashUsd, amount: "30" }], change: { accountId: cashCdf, amount: "14000", rate: "2808" } });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const usdOnly = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "25" }], payments: [{ accountId: cashUsd, amount: "25" }] });
    expect(usdOnly.status).toBe(201);
    const rows = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body;
    expect(rows.find((r) => r.id === sale.body.id).fcNetNative).toBeNull();
    expect(rows.find((r) => r.id === usdOnly.body.id).fcNetNative).toBeNull();
    // Dollars and francs, all handed back in francs: more francs out than in, but no rate gap.
    const mixed = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "25" }], payments: [{ accountId: cashUsd, amount: "10" }, { accountId: cashCdf, amount: "42200", rate: "2808" }] });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
    expect((await call("POST", `/api/sales/${mixed.body.id}/returns`, { date: day, reason: "Mauvaise référence", refundAccountId: cashCdf, lines: [{ saleLineId: mixed.body.lines[0].id, qty: "1" }] })).status).toBeLessThan(300);
    const after = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body;
    expect(after.find((r) => r.id === mixed.body.id).fcNetNative).toBeNull();
  });
});
