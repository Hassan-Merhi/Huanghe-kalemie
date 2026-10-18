import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U29: a price or cost typed as text "1,350" or "4,125" may be 1 350 or 1,35: the server refuses it, as it
 * refuses "1.350", and books the same price typed as a number, as "1 350" or as "4,13".
 */
describe.skipIf(!hasDb)("Twenty-fourth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const NB = " ";
  let db: Db;
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
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  let locationId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const p = await call("POST", "/api/products", { name: "Moto U29", unit: "pcs", variants: [{ attributes: {}, sellPrice: "1450", sku: "MOTO-U29" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
  });
  afterAll(() => server?.close());

  const price = async (search: string) => Number((await db.transaction((tx) => catalog.searchVariants(tx, { search })))[0].sellPrice);

  it("refuses a price typed \"1,650\" and keeps the 1 450 $ list price", async () => {
    const res = await call("POST", "/api/import/prices", { rows: [{ sku: "MOTO-U29", sellPrice: "1,650" }] });
    expect(res.status).toBe(422);
    expect(res.body.messageFr).toBe(`«${NB}1,650${NB}»${NB}: 1${NB}650 ou 1,65${NB}? Pour 1${NB}650, écrivez 1650 sans séparateur${NB}; pour 1,65, écrivez-le comme nombre dans Excel.`);
    expect(await price("MOTO-U29")).toBe(1450);
    for (const typed of ["1 650", "1650", 1650]) {
      const ok = await call("POST", "/api/import/prices", { rows: [{ sku: "MOTO-U29", sellPrice: typed }] });
      expect(ok.status, String(typed)).toBe(200);
      expect(await price("MOTO-U29")).toBe(1650);
    }
  });

  it("refuses an opening cost typed \"1,350\" and books \"4,13\" and number cells", async () => {
    const bad = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Moto U29b", unit: "pcs", qty: "2", unitCost: "1,350" }] });
    expect(bad.status).toBe(422);
    expect(bad.body.messageFr).toContain(`1${NB}350 ou 1,35${NB}?`);
    const ok = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Moto U29b", unit: "pcs", qty: "2", unitCost: 1350, sellPrice: "4,13" }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const [v] = await db.transaction((tx) => catalog.searchVariants(tx, { search: "Moto U29b" }));
    expect(Number(v.stockValue)).toBe(2700);
    expect(Number(v.sellPrice)).toBe(4.13);
  });

  it("does not book \"12,000\" or \"1,500\" pieces of opening stock sent as text", async () => {
    for (const qty of ["12,000", "1,500"]) {
      const res = await call("POST", "/api/import/items", { date: today, locationId, rows: [{ name: "Pneu U29", unit: "pcs", qty, unitCost: 10 }] });
      expect(res.status, qty).toBeGreaterThanOrEqual(400);
    }
    expect(await db.transaction((tx) => catalog.searchVariants(tx, { search: "Pneu U29" }))).toHaveLength(0);
  });
});
