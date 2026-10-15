import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U9: the Sales list, the day's summary and the dashboard net of returns; the till's franc rounding named in the daybook. */
describe.skipIf(!hasDb)("Sales net of returns", async () => {
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
  // Kalemie's day (UTC+2), as the server counts "today".
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let cashUsd: number, cashCdf: number, locationId: number, variantId: number, saleId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2800" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Bougie", unit: "pcs", variants: [{ attributes: {}, sellPrice: "5.01" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "2" }] })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "280000" }] })).status).toBe(201);
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "2", unitPrice: "5.01" }], payments: [{ accountId: cashUsd, amount: "10.02" }] });
    expect(sale.status).toBe(201);
    saleId = sale.body.id;
    // 5,01 $ at 2 800 is 14 028 FC: 14 000 FC go back, 28 FC are the rounding.
    const ret = await call("POST", `/api/sales/${saleId}/returns`, { reason: "Mauvaise taille", refundAccountId: cashCdf, rate: "2800", lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status).toBeLessThan(300);
  });

  afterAll(() => {
    server?.close();
  });

  it("lists each sale with the amount and cost of what came back", async () => {
    const list = await call<any[]>("GET", "/api/sales");
    const row = list.body.find((s) => s.id === saleId);
    expect(row.total).toBe("10.02");
    expect(row.returnedTotal).toBe("5.01");
    expect(row.returnedCogs).toBe("2.00");
    expect(row.returnedQty).toBe("1.000");
  });

  it("counts refunds in the day's summary, per drawer", async () => {
    const daily = await call("GET", `/api/reports/daily?date=${today}`);
    expect(daily.body.returnsTotal).toBe("5.01");
    const fc = daily.body.byAccount.find((a: any) => a.account_id === cashCdf);
    expect(Number(fc.refund_native)).toBe(14000);
    expect(Number(fc.native)).toBe(-14000);
    expect(Number(fc.received_native)).toBe(0);
    const usd = daily.body.byAccount.find((a: any) => a.account_id === cashUsd);
    expect(Number(usd.received_usd)).toBe(10.02);
    expect(Number(usd.refund_usd)).toBe(0);
  });

  it("shows today's sales on the dashboard net of today's returns", async () => {
    const dash = await call("GET", "/api/reports/dashboard");
    expect(dash.body.todaySales).toMatchObject({ count: 1, total: "5.01", returns: "5.01" });
  });

  it("names the franc rounding of a refund apart from any exchange difference in the daybook", async () => {
    const book = await call("GET", `/api/daybook?from=${today}&to=${today}&type=sale_return`);
    expect(book.body.rows[0].fxRounding).toBe("-0.01");
  });
});
