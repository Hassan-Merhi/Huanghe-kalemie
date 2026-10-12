import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** HTTP-level checks: login, roles, validation and a sale through the API. */
describe.skipIf(!hasDb)("API", async () => {
  const { createApp } = await import("../../server/index");
  let server: Server;
  let base = "";

  function client() {
    let cookie = "";
    return async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  }

  const owner = client();
  const cashier = client();
  const partner = client();

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("requires sign-in", async () => {
    const anon = client();
    expect((await anon("GET", "/api/products")).status).toBe(401);
    expect((await anon("POST", "/api/auth/login", { username: "admin", password: "wrong" })).status).toBe(401);
  });

  it("lets the owner sign in and create staff", async () => {
    const login = await owner("POST", "/api/auth/login", { username: "admin", password: "test-password-123" });
    expect(login.status).toBe(200);
    expect(login.body.role).toBe("owner");
    const partners = await owner("GET", "/api/partners");
    expect(partners.body.map((p: any) => p.sharePct)).toEqual(["75.00", "25.00"]);
    expect((await owner("POST", "/api/users", { username: "cashier1", fullName: "Cashier", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await owner("POST", "/api/users", { username: "partnerb", fullName: "Partner B", role: "partner", partnerId: partners.body[1].id, password: "partner-pass" })).status).toBe(201);
    expect((await cashier("POST", "/api/auth/login", { username: "cashier1", password: "cashier-pass" })).status).toBe(200);
    expect((await partner("POST", "/api/auth/login", { username: "partnerb", password: "partner-pass" })).status).toBe(200);
  });

  it("validates input with readable messages", async () => {
    const r = await owner("POST", "/api/products", { name: "", variants: [] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/name|variants/i);
  });

  it("enforces roles", async () => {
    expect((await cashier("GET", "/api/reports/dashboard")).status).toBe(403);
    expect((await cashier("POST", "/api/expenses", {})).status).toBe(403);
    expect((await partner("POST", "/api/sales", {})).status).toBe(403);
    expect((await partner("GET", "/api/reports/dashboard")).status).toBe(200);
    // A partner only sees their own partner record.
    const mine = await partner("GET", "/api/partners");
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].sharePct).toBe("25.00");
    // Cashiers get money accounts without balances.
    const accs = await cashier("GET", "/api/accounts");
    expect(accs.body.every((a: any) => a.isMoney && a.balance === undefined)).toBe(true);
  });

  it("sells through the API after opening stock, hiding cost from cashiers", async () => {
    const product = await owner("POST", "/api/products", {
      name: "Tyre",
      variants: [{ attributes: { Size: "2.75-17" }, sellPrice: "25", barcode: "TYRE275" }],
    });
    expect(product.status).toBe(201);
    const variantId = product.body.variants[0].id;
    const locations = await owner("GET", "/api/locations");
    const locationId = locations.body[0].id;
    const today = (await owner("GET", "/api/settings")).body.today;
    const adj = await owner("POST", "/api/stock/adjustments", {
      date: today,
      locationId,
      kind: "opening",
      reason: "Opening count",
      lines: [{ variantId, qtyChange: "10", unitCost: "15" }],
    });
    expect(adj.status).toBe(201);

    const cash = (await cashier("GET", "/api/accounts")).body.find((a: any) => a.systemKey === "cash_usd");
    const sale = await cashier("POST", "/api/sales", {
      locationId,
      lines: [{ variantId, qty: "2", unitPrice: "25" }],
      payments: [{ accountId: cash.id, amount: "50" }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.total).toBe("50.00");

    const asCashier = await cashier("GET", `/api/sales/${sale.body.id}`);
    expect(asCashier.body.cogs).toBeUndefined();
    expect(asCashier.body.lines[0].cogs).toBeUndefined();
    const asOwner = await owner("GET", `/api/sales/${sale.body.id}`);
    expect(asOwner.body.cogs).toBe("30.00");

    // Cashiers cannot cancel sales.
    expect((await cashier("POST", `/api/sales/${sale.body.id}/void`, { reason: "x" })).status).toBe(403);

    const tb = await owner("GET", "/api/reports/trial-balance");
    expect(tb.body.balanced).toBe(true);
  });

  it("does not let a month be closed before it ends", async () => {
    const today = (await owner("GET", "/api/settings")).body.today as string;
    const r = await owner("POST", `/api/periods/${today.slice(0, 7)}/close`);
    expect(r.status).toBe(400);
  });
});
