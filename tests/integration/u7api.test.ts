import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U7: what the daybook, the daily cash report, a return and the rate lookup show. */
describe.skipIf(!hasDb)("Document amounts and change in the reports", async () => {
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
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Bougie", unit: "pcs", variants: [{ attributes: {}, sellPrice: "12.50" }] });
    expect(product.status).toBe(201);
    variantId = product.body.variants[0].id;
    const adj = await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "4" }] });
    expect(adj.status).toBeLessThan(300);
  });

  afterAll(() => {
    server?.close();
  });

  it("gives the yuan rate on file with the day's rate, and the first day of the books", async () => {
    const r = await call("GET", `/api/exchange-rates/for/${day}`);
    expect(r.body.cnyPerUsd).toBe("7.1");
    const first = await call("GET", "/api/books/first-date");
    expect(first.body.date).toBe("2026-08-01");
  });

  it("shows a sale at its total, with what was handed over and the change apart", async () => {
    // 3 × 12.50 $ paid with 150 000 FC; 45 000 FC back.
    const sale = await call("POST", "/api/sales", {
      date: day,
      locationId,
      lines: [{ variantId, qty: "3", unitPrice: "12.50" }],
      payments: [{ accountId: cashCdf, amount: "150000", rate: "2800" }],
      change: { accountId: cashCdf, amount: "45000", rate: "2800" },
    });
    expect(sale.status).toBe(201);
    saleId = sale.body.id;
    const book = await call("GET", `/api/daybook?from=${day}&to=${day}`);
    const row = book.body.rows.find((r: any) => r.type === "sale");
    expect(row.amount).toBe("37.50");
    expect(row.received).toBe("53.57");
    expect(row.changeGiven).toBe("16.07");
    const daily = await call("GET", `/api/reports/daily?date=${day}`);
    const fc = daily.body.byAccount.find((a: any) => a.account_id === cashCdf);
    expect(Number(fc.received_native)).toBe(150000);
    expect(Number(fc.change_native)).toBe(45000);
    expect(Number(fc.native)).toBe(105000);
  });

  it("puts the francs handed back on a return", async () => {
    const sale = (await call("GET", `/api/sales/${saleId}`)).body;
    const ret = await call("POST", `/api/sales/${saleId}/returns`, { date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, rate: "2800", lines: [{ saleLineId: sale.lines[0].id, qty: "1" }] });
    expect(ret.status).toBeLessThan(300);
    const r = ret.body.returns[0];
    expect(r.refundCurrency).toBe("CDF");
    expect(r.refundNative).toBe("35000.00");
    expect(r.refundToBalanceUsd).toBe("0.00");
  });

  it("names both boxes of a transfer and shows the amount sent", async () => {
    const tr = await call("POST", "/api/money/transfer", { date: day, fromAccountId: cashCdf, fromAmount: "2800", toAccountId: cashUsd, toAmount: "1" });
    expect(tr.status).toBeLessThan(300);
    const book = await call("GET", `/api/daybook?from=${day}&to=${day}&type=transfer`);
    const row = book.body.rows[0];
    expect(row.amount).toBe("1.00");
    expect(row.transfer).toEqual({ from: "Caisse FC", to: "Caisse USD" });
  });
});
