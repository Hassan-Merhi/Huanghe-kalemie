import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/**
 * U32: a manager's franc refund goes at the day's rate. A return sent with another rate (a dialog that
 * showed one the books would not use) is refused rather than paid out at the day's rate silently; one sent
 * with the day's rate, or with none, goes through as before. The owner's typed rate is unchanged.
 */
describe.skipIf(!hasDb)("Twenty-seventh UI audit", async () => {
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
  const manager = (method: string, path: string, body?: unknown) => call("manager", method, path, body);
  const day = "2026-08-03";
  let cashCdf: number, locationId: number, variantId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await owner("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await owner("POST", "/api/users", { username: "gerant", fullName: "Gérant", role: "manager", password: "manager-pass" })).status).toBe(201);
    expect((await manager("POST", "/api/auth/login", { username: "gerant", password: "manager-pass" })).status).toBe(200);
    const accounts = (await owner("GET", "/api/accounts")).body as any[];
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    locationId = (await owner("GET", "/api/locations")).body[0].id;
    expect((await owner("POST", "/api/exchange-rates", { date: day, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const product = await owner("POST", "/api/products", { name: "Plaquettes U32", unit: "pcs", variants: [{ attributes: {}, sellPrice: "25" }] });
    variantId = product.body.variants[0].id;
    expect((await owner("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "5" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  /** A 25 $ sale paid 70 200 FC at 2 808. */
  async function francSale() {
    const sale = await owner("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "25" }], payments: [{ accountId: cashCdf, amount: "70200", rate: "2808" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    return sale.body;
  }
  const back = (sale: any, rate?: string) => ({ date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, ...(rate !== undefined ? { rate } : {}), lines: [{ saleLineId: sale.lines[0].id, qty: "1" }] });

  it("refuses a manager's franc refund at a rate other than the day's, saying which", async () => {
    const sale = await francSale();
    for (const rate of ["2900", "28500"]) {
      const res = await manager("POST", `/api/sales/${sale.id}/returns`, back(sale, rate));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.messageFr ?? res.body.message).toMatch(/taux du jour|day's rate/);
    }
    // Nothing was booked: the sale has no return yet.
    expect((await owner("GET", `/api/sales/${sale.id}`)).body.returns).toHaveLength(0);
  });

  it("takes a manager's refund sent at the day's rate, or with no rate, at the day's rate", async () => {
    for (const rate of ["2808", "2808.0000", undefined]) {
      const sale = await francSale();
      const res = await manager("POST", `/api/sales/${sale.id}/returns`, back(sale, rate));
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const ret = (await owner("GET", `/api/sales/${sale.id}`)).body.returns[0];
      expect(ret.refundNative).toBe("70200.00");
    }
  });

  it("still lets the owner refund at a rate within the tolerance", async () => {
    const sale = await francSale();
    const res = await owner("POST", `/api/sales/${sale.id}/returns`, back(sale, "2850"));
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    // 25 $ at 2 850 is 71 250 FC, rounded down to 71 200 FC.
    expect((await owner("GET", `/api/sales/${sale.id}`)).body.returns[0].refundNative).toBe("71200.00");
  });
});
