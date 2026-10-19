import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, sales } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U48: a sale keeps the franc rate it was validated at, so its reprinted receipt reads the rate it was printed
 * with after the day's rate is corrected. Sales made before keep none; an older backup restores without it.
 */
describe.skipIf(!hasDb)("Forty-third UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const backup = await import("../../server/services/backup");
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
  let cashUsd: number, cashCdf: number, locationId: number, tyre: number, customerId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" }, "caisse")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    const p = await call("POST", "/api/products", { name: "Pneu U48", unit: "pcs", variants: [{ attributes: {}, sellPrice: "54" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    tyre = p.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: tyre, qtyChange: "20", unitCost: "30" }] })).status).toBe(201);
    customerId = (await call("POST", "/api/parties", { type: "customer", name: "Garage Lac U48" })).body.id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
  });
  afterAll(() => server?.close());

  it("keeps the day's rate on a dollar-only sale, whatever the rate is corrected to after", async () => {
    // The audit's S-000029: 54 $ on credit at 2 808, "≈ 151 632 FC · Taux : 1 $ = 2 808 FC".
    const credit = await call("POST", "/api/sales", { locationId, customerId, lines: [{ variantId: tyre, qty: "1", unitPrice: "54" }], payments: [] });
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    const dollars = await call("POST", "/api/sales", { locationId, lines: [{ variantId: tyre, qty: "1", unitPrice: "54" }], payments: [{ accountId: cashUsd, amount: "54" }], tillRate: "2808" }, "caisse");
    expect(dollars.status, JSON.stringify(dollars.body)).toBe(201);
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2850" })).status).toBeLessThan(300);
    for (const id of [credit.body.id, dollars.body.id]) {
      const sale = await call("GET", `/api/sales/${id}`);
      expect(sale.status).toBe(200);
      expect(Number(sale.body.cdfRate)).toBe(2808);
    }
    // A sale made now is at the corrected rate.
    const later = await call("POST", "/api/sales", { locationId, customerId, lines: [{ variantId: tyre, qty: "1", unitPrice: "54" }], payments: [] });
    expect(Number((await call("GET", `/api/sales/${later.body.id}`)).body.cdfRate)).toBe(2850);
  });

  it("keeps the rate the francs were taken at, the owner's typed one included", async () => {
    // 2 830 is within the tolerance of the day's 2 850: 54 $ are 152 820 FC.
    const owner = await call("POST", "/api/sales", { locationId, lines: [{ variantId: tyre, qty: "1", unitPrice: "54" }], payments: [{ accountId: cashCdf, amount: "152800", rate: "2830" }] });
    expect(owner.status, JSON.stringify(owner.body)).toBe(201);
    expect(Number((await call("GET", `/api/sales/${owner.body.id}`)).body.cdfRate)).toBe(2830);
    const staff = await call("POST", "/api/sales", { locationId, lines: [{ variantId: tyre, qty: "1", unitPrice: "54" }], payments: [{ accountId: cashCdf, amount: "153900" }], tillRate: "2850" }, "caisse");
    expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    expect(Number((await call("GET", `/api/sales/${staff.body.id}`)).body.cdfRate)).toBe(2850);
  });

  it("restores a backup made before sales kept their rate, those sales keeping none", async () => {
    const file = JSON.parse(await db.transaction((tx) => backup.snapshot(tx)));
    const count = file.tables.sales.length;
    for (const row of file.tables.sales) delete row.cdf_rate;
    const result = await db.transaction((tx) => backup.restore(tx, file, { replace: true }));
    expect(result.checks.every((c) => c.ok)).toBe(true);
    const rows = await db.select().from(sales);
    expect(rows).toHaveLength(count);
    // The sale page sends none, so the receipt falls back to the francs' rate, else the day's, as before.
    expect(rows.every((r) => r.cdfRate === null)).toBe(true);
  });
});
