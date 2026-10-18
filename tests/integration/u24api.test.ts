import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

const NB = " ";

/** U24: the dashboard's purchases on the way, container by container, and the till's "not enough stock" in plain French. */
describe.skipIf(!hasDb)("Nineteenth UI audit", async () => {
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
  const day = "2026-10-18";
  let locationId: number, supplierId: number, variantId: number, cashUsd: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    cashUsd = (await call<any[]>("GET", "/api/accounts")).body.find((a) => a.systemKey === "cash_usd").id;
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group (Chongqing)" })).body.id;
    const product = await call("POST", "/api/products", { name: "Pneu 3.00-18", unit: "pcs", variants: [{ attributes: {}, sellPrice: "27" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: day, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "77", unitCost: "12" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("sums each open container's own lines on the dashboard, whatever the line ids", async () => {
    // Container 1 holds three lines (ids 1 to 3), container 2 one line (id 4) and container 3 none:
    // reading line N for container N would give 1 000, 2 000 and 3 000 $.
    const a = await call("POST", "/api/containers", { number: "HHU-2026-001", supplierId, locationId, currency: "USD" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const lines = [{ variantId, quantity: "100", unitPrice: "10" }, { variantId, quantity: "100", unitPrice: "20" }, { variantId, quantity: "100", unitPrice: "30" }];
    expect((await call("PUT", `/api/containers/${a.body.id}/lines`, { lines })).status).toBeLessThan(300);
    const b = await call("POST", "/api/containers", { number: "HHU-2026-002", supplierId, locationId, currency: "CNY", rateToUsd: "0.14" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${b.body.id}/lines`, { lines: [{ variantId, quantity: "50", unitPrice: "100" }] })).status).toBeLessThan(300);
    const c = await call("POST", "/api/containers", { number: "HHU-2026-003", supplierId, locationId, currency: "USD" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);

    const dash = await call("GET", "/api/reports/dashboard");
    expect(dash.status).toBe(200);
    const usd = Object.fromEntries(dash.body.openContainers.map((x: any) => [x.number, x.purchaseUsd]));
    expect(usd).toEqual({ "HHU-2026-001": "6000.00", "HHU-2026-002": "700.00", "HHU-2026-003": "0" });
  });

  it("says how much is short with French plurals", async () => {
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "100", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "2700" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(409);
    expect(sale.body.messageFr).toMatch(new RegExp(`^Stock insuffisant de Pneu 3\\.00-18 .*${NB}: 77 disponibles, 100 nécessaires$`));
    // Below two, the word stays singular.
    const one = await call("POST", "/api/stock/adjustments", { date: day, locationId, kind: "damage", reason: "Casse", lines: [{ variantId, qtyChange: "-76" }] });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const short = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "2", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "54" }] });
    expect(short.status, JSON.stringify(short.body)).toBe(409);
    expect(short.body.messageFr).toMatch(new RegExp(`${NB}: 1 disponible, 2 nécessaires$`));
  });
});
