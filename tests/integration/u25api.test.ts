import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U25: the daily report's net figure (the dashboard's), and a stock import's blank brand left blank, also on edit. */
describe.skipIf(!hasDb)("Twentieth UI audit", async () => {
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
  let locationId: number, variantId: number, cashUsd: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    cashUsd = (await call<any[]>("GET", "/api/accounts")).body.find((a) => a.systemKey === "cash_usd").id;
    const product = await call("POST", "/api/products", { name: "Pneu 3.00-18", unit: "pcs", variants: [{ attributes: {}, sellPrice: "27" }] });
    variantId = product.body.variants[0].id;
  });

  afterAll(() => {
    server?.close();
  });

  it("leads the daily report with the sales still standing less returns, as the dashboard", async () => {
    const day = (await call("GET", "/api/reports/dashboard")).body.today;
    expect((await call("POST", "/api/stock/adjustments", { date: day, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "12" }] })).status).toBe(201);
    const sell = (n: string) => call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: n, unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: (Number(n) * 27).toFixed(2) }] });
    const a = await sell("3");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await sell("2");
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await call("POST", `/api/sales/${b.body.id}/void`, { reason: "Erreur", date: day })).status).toBe(200);
    const ret = await call("POST", `/api/sales/${a.body.id}/returns`, { date: day, lines: [{ saleLineId: a.body.lines[0].id, qty: "1" }], refundAccountId: cashUsd, reason: "Retour" });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);

    const daily = (await call("GET", `/api/reports/daily?date=${day}`)).body;
    // As made: both sales, 135 $; the cancelled one and the return come off the headline.
    expect(daily).toMatchObject({ count: 2, total: "135.00", voidsCount: 1, voidsTotal: "54.00", returnsTotal: "27.00", netCount: 1, netTotal: "54.00" });
    expect((await call("GET", "/api/reports/dashboard")).body.todaySales.total).toBe(daily.netTotal);
  });

  it("imports an item with no brand without calling it Huanghe; the item form still does", async () => {
    const r = await call("POST", "/api/import/items", { date: "2026-10-18", locationId, rows: [{ name: "Huile de frein U20", unit: "litre", sellPrice: "6" }, { name: "Chaîne 428", brand: "KMC", sellPrice: "9" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const products = (await call<any[]>("GET", "/api/products")).body;
    const brand = (name: string) => products.find((p) => p.name === name)?.brand;
    expect(brand("Huile de frein U20")).toBe("");
    expect(brand("Chaîne 428")).toBe("KMC");
    expect(brand("Pneu 3.00-18")).toBe("Huanghe");
    // Editing the imported item as the form sends it (blank brand as null) keeps the brand blank.
    const oil = products.find((p) => p.name === "Huile de frein U20");
    const edit = await call("PATCH", `/api/products/${oil.id}`, { name: "Huile de frein U20", brand: null, unit: "litre" });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.brand).toBe("");
    expect((await call("PATCH", `/api/products/${oil.id}`, { brand: "  " })).body.brand).toBe("");
    // A brand typed in is kept, and can be emptied again.
    expect((await call("PATCH", `/api/products/${oil.id}`, { brand: " Total " })).body.brand).toBe("Total");
    expect((await call("PATCH", `/api/products/${oil.id}`, { brand: "" })).body.brand).toBe("");
  });
});
