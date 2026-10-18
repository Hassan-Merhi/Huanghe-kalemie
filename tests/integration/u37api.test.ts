import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/**
 * U37: importing the same articles file twice must not count its opening stock twice. A quantity on an
 * item that existed before the import is refused unless the request says addToExisting; new items and
 * new variants in the same file keep their quantities.
 */
describe.skipIf(!hasDb)("Thirty-second UI audit", async () => {
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
  let locationId: number, today: string;
  const file = [
    { name: "Câble U37", unit: "pcs", sku: "CAB-U37", qty: "1500", unitCost: "1.2", sellPrice: "2" },
    { name: "Huile U37", unit: "litre", size: "1 L", qty: "2.25", unitCost: "4", sellPrice: "6" },
    { name: "Huile U37", unit: "litre", size: "5 L", qty: "1", unitCost: "18" },
  ];
  const stock = async (sku: string) => {
    const rows = (await call<any[]>("GET", `/api/variants?search=${encodeURIComponent(sku)}`)).body;
    return rows.find((r) => r.sku === sku);
  };

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
  });
  afterAll(() => server?.close());

  it("books the quantities of a first import, a second variant of a new item included", async () => {
    const res = await call("POST", "/api/import/items", { date: today, locationId, rows: file });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.stockLines).toBe(3);
    expect(Number((await stock("CAB-U37")).stockQty)).toBe(1500);
  });

  it("refuses the same file again, naming the row, and changes nothing", async () => {
    const again = await call("POST", "/api/import/items", { date: today, locationId, rows: file });
    expect(again.status).toBe(409);
    expect(again.body.messageFr).toMatch(/^Ligne 2\u00a0: CAB-U37 existe déjà\. Sa quantité s.ajouterait au stock existant\u00a0; confirmez/);
    expect(Number((await stock("CAB-U37")).stockQty)).toBe(1500);
  });

  it("imports existing rows without their quantity, and adds it only when asked", async () => {
    const plain = await call("POST", "/api/import/items", { date: today, locationId, updatePrices: true, rows: file.map((r) => ({ ...r, qty: null, unitCost: null })) });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.existing).toBe(3);
    expect(plain.body.adjustment).toBeNull();
    expect(Number((await stock("CAB-U37")).stockQty)).toBe(1500);
    const added = await call("POST", "/api/import/items", { date: today, locationId, addToExisting: true, rows: [file[0]] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.stockLines).toBe(1);
    expect(Number((await stock("CAB-U37")).stockQty)).toBe(3000);
  });
});
