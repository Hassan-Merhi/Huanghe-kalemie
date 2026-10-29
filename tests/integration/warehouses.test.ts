import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { locations, stockLevels } from "@shared/schema";
import { db } from "../../server/db";
import { hasDb, resetDatabase } from "./helpers";

describe.skipIf(!hasDb)("Location warehouses", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const { transferStock } = await import("../../server/services/stock");
  const insights = await import("../../server/services/insights");
  let server: Server;
  let base: string;
  let cookie = "";
  let siteId: number;
  let warehouseId: number;

  async function request(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, body: await res.json() as any };
  }

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    expect((await request("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const sites = await db.select().from(locations);
    siteId = sites[0].id;
  });

  afterAll(() => server?.close());

  it("creates several warehouses under locations, with names unique only among siblings", async () => {
    const site = await request("POST", "/api/locations", { name: "Goma" });
    expect(site.status).toBe(201);
    expect(site.body.parentId).toBeNull();

    const first = await request("POST", "/api/locations", { name: "Main Warehouse", parentId: siteId });
    expect(first.status).toBe(201);
    warehouseId = first.body.id;
    expect(first.body.parentId).toBe(siteId);

    const other = await request("POST", "/api/locations", { name: "Main Warehouse", parentId: site.body.id });
    expect(other.status).toBe(201);
    expect(other.body.parentId).toBe(site.body.id);

    expect((await request("POST", "/api/locations", { name: "Main Warehouse", parentId: siteId })).status).toBe(409);
    expect((await request("POST", "/api/locations", { name: "Nested", parentId: warehouseId })).status).toBe(400);
    expect((await request("PATCH", "/api/locations/" + siteId, { active: false })).status).toBe(400);

    const listed = await request("GET", "/api/locations");
    expect(listed.body.find((row: any) => row.id === warehouseId).parentId).toBe(siteId);
  });

  it("keeps old site stock intact and values warehouse stock after an actual transfer", async () => {
    const item = await db.transaction((tx) => catalog.createProduct(tx, {
      name: "Warehouse test part",
      unit: "pcs",
      variants: [{ attributes: { Colour: "Blue" }, sellPrice: "180" }],
    }));
    const variantId = item.variants[0].id;
    await db.transaction((tx) => ops.adjustStock(tx, {
      date: "2026-08-01", locationId: siteId, kind: "opening", reason: "Warehouse fixture",
      lines: [{ variantId, qtyChange: "5", unitCost: "120" }],
    }, 1));
    await db.transaction((tx) => transferStock(tx, {
      date: "2026-08-02", type: "transfer_out", variantId,
      fromLocationId: siteId, toLocationId: warehouseId, qty: "2", userId: 1,
    }));

    const levels = await db.select().from(stockLevels).where(eq(stockLevels.variantId, variantId));
    expect(levels.find((l) => l.locationId === siteId)?.qty).toBe("3.000");
    expect(levels.find((l) => l.locationId === warehouseId)?.qty).toBe("2.000");

    const positions = await insights.inventoryByLocation(db);
    const site = positions.find((row) => row.variantId === variantId && row.locationId === siteId)!;
    const warehouse = positions.find((row) => row.variantId === variantId && row.locationId === warehouseId)!;
    expect(site.value).toBe("360.00");
    expect(warehouse.avgCost).toBe("120.000000");
    expect(warehouse.value).toBe("240.00");
    expect((await request("PATCH", "/api/locations/" + warehouseId, { active: false })).status).toBe(400);
  });
});
