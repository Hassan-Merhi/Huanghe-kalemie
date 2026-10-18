import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/**
 * U31: the daily report values a franc refund at the refund's rate, as the sale page and the Sales list do, so
 * the day's figures add up to its rows; a cancelled franc sale's "Payé" is what its receipt said was kept.
 * Read only: no posting changes.
 */
describe.skipIf(!hasDb)("Twenty-sixth UI audit", async () => {
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
    // Francs bought at 2 700, sold and refunded at 2 808: their book cost is not the refund's rate.
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2700" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2700", lines: [{ accountId: otherIncome, amount: "2700000" }] })).status).toBe(201);
    expect((await call("POST", "/api/exchange-rates", { date: day, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Pneu U31", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "5" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("values a franc refund at its rate in the day's figures, so they add up to the rows", async () => {
    // 20 $ and 5 616 FC for a 22 $ tyre, brought back and refunded 61 700 FC (21,97 $ at 2 808).
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "22" }], payments: [{ accountId: cashUsd, amount: "20" }, { accountId: cashCdf, amount: "5616", rate: "2808" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const ret = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(300);
    const detail = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect(detail.returns[0].refundNative).toBe("61700.00");
    expect(detail.returns[0].refundUsd).toBe("21.97");
    const daily = (await call("GET", `/api/reports/daily?date=${day}`)).body;
    const fc = daily.byAccount.find((a: any) => a.account_id === cashCdf);
    // Not the 22,85 $ the francs cost at 2 700.
    expect(fc.refund_usd).toBe("21.97");
    expect(fc.refund_native).toBe("61700.00");
    const rows = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body;
    const kept = rows.reduce((s, r) => s + Number(r.paidKeptUsd), 0);
    const refunded = rows.reduce((s, r) => s + Number(r.refundedUsd), 0);
    const total = daily.byAccount.reduce((s: number, a: any) => s + Number(a.usd), 0);
    expect(total.toFixed(2)).toBe(kept.toFixed(2));
    expect(daily.byAccount.reduce((s: number, a: any) => s + Number(a.refund_usd), 0).toFixed(2)).toBe(refunded.toFixed(2));
  });

  it("shows a cancelled franc sale's Payé as its receipt kept it", async () => {
    // 27 $ is 75 816 FC: 75 800 FC handed over, 16 FC short, 26,99 $ kept.
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75800", rate: "2808" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.paidKeptUsd).toBe("26.99");
    expect((await call("POST", `/api/sales/${sale.body.id}/void`, { reason: "Erreur de saisie" })).status).toBeLessThan(300);
    const detail = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect(detail.status).toBe("voided");
    expect(detail.paidKeptUsd).toBe("26.99");
    // The reversal still takes the rounding back: nothing left over on the sale.
    expect(detail.fcRoundingUsd).toBe("0.00");
    const row = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body.find((r) => r.id === sale.body.id);
    expect(row.paidKeptUsd).toBe("26.99");
  });
});
