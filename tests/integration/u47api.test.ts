import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { containerLines, journals } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U47: a container's invoice currency changed with its lines converted at the rates (draft lines only, nothing
 * posted), and goods on the way leaving drafts out. No posting changes.
 */
describe.skipIf(!hasDb)("Forty-second UI audit", async () => {
  const { createApp } = await import("../../server/index");
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
  let locationId: number, supplierId: number, tyre: number, oil: number;
  const linesOf = async (id: number) => (await db.select().from(containerLines).where(eq(containerLines.containerId, id))).sort((a, b) => a.id - b.id);
  const journalCount = async () => (await db.select({ id: journals.id }).from(journals)).length;

  async function container(currency: string, rateToUsd: string | undefined, status = "draft") {
    const c = await call("POST", "/api/containers", { number: `U47-${Math.random().toString(36).slice(2, 8)}`, supplierId, locationId, currency, status, ...(rateToUsd ? { rateToUsd } : {}) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    return c.body.id as number;
  }

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe U47" })).body.id;
    const p = await call("POST", "/api/products", { name: "Pneu U47", unit: "pcs", variants: [{ attributes: {}, sellPrice: "25" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    tyre = p.body.variants[0].id;
    oil = (await call("POST", "/api/products", { name: "Huile U47", unit: "L", variants: [{ attributes: {}, sellPrice: "5" }] })).body.variants[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
  });
  afterAll(() => server?.close());

  it("converts a draft's line prices from francs to dollars at the container's rate, keeping the lines' ids", async () => {
    const id = await container("CDF", (1 / 2808).toFixed(12));
    expect((await call("PUT", `/api/containers/${id}/lines`, { lines: [{ variantId: tyre, quantity: "10", unitPrice: "45000" }, { variantId: oil, quantity: "2.5", unitPrice: "100" }] })).status).toBe(200);
    const before = await linesOf(id);
    const posted = await journalCount();
    const r = await call("PATCH", `/api/containers/${id}`, { currency: "USD", rateToUsd: "1", convertLinePrices: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await linesOf(id);
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
    // 45 000 FC at 2 808 are 16,025641 $ (10 of them 160,26 $, the oil 0,09 $), not 45 000 $; 100 FC a litre to six decimals.
    expect(after.map((l) => l.unitPrice)).toEqual(["16.025641", "0.035613"]);
    const c = (await call("GET", `/api/containers/${id}`)).body;
    expect(c.currency).toBe("USD");
    expect(c.preview.fobTotalUsd).toBe("160.35"); // 160,26 $ + 0,09 $ of oil
    expect(await journalCount()).toBe(posted);
  });

  it("converts dollars to yuan at the new rate, and keeps the amounts as typed when not asked", async () => {
    const id = await container("USD", undefined);
    expect((await call("PUT", `/api/containers/${id}/lines`, { lines: [{ variantId: tyre, quantity: "1", unitPrice: "14025" }] })).status).toBe(200);
    const r = await call("PATCH", `/api/containers/${id}`, { currency: "CNY", rateToUsd: (1 / 7.1).toFixed(12), convertLinePrices: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await linesOf(id))[0].unitPrice).toBe("99577.500000");
    // Back to francs, typed again: the prices stay as they are.
    expect((await call("PATCH", `/api/containers/${id}`, { currency: "CDF", rateToUsd: (1 / 2808).toFixed(12) })).status).toBe(200);
    expect((await linesOf(id))[0].unitPrice).toBe("99577.500000");
    // Francs come out whole.
    expect((await call("PATCH", `/api/containers/${id}`, { currency: "USD", rateToUsd: "1", convertLinePrices: true })).status).toBe(200);
    expect((await call("PATCH", `/api/containers/${id}`, { currency: "CDF", rateToUsd: (1 / 2808).toFixed(12), convertLinePrices: true })).status).toBe(200);
    expect((await linesOf(id))[0].unitPrice).toBe("99578.000000");
  });

  it("never converts an offloaded container's lines", async () => {
    const id = await container("USD", undefined, "arrived");
    expect((await call("PUT", `/api/containers/${id}/lines`, { lines: [{ variantId: tyre, quantity: "4", unitPrice: "10" }] })).status).toBe(200);
    expect((await call("POST", `/api/containers/${id}/finalize`, { offloadDate: today })).status).toBe(200);
    const r = await call("PATCH", `/api/containers/${id}`, { convertLinePrices: true });
    expect(r.status).toBe(409);
    expect((await linesOf(id))[0].unitPrice).toBe("10.000000");
  });

  it("leaves drafts out of the goods on the way, still listing them", async () => {
    const dash = (await call("GET", "/api/reports/dashboard")).body;
    const open = dash.openContainers as { status: string; purchaseUsd: string }[];
    expect(open.some((c) => c.status === "draft")).toBe(true);
    const analytics = (await call("GET", `/api/reports/analytics?from=${today}&to=${today}`)).body;
    // Every open container here is a draft: nothing is on the way.
    expect(open.every((c) => c.status === "draft")).toBe(true);
    expect(analytics.goodsOnTheWayUsd).toBe("0.00");
    const arrived = await container("USD", undefined, "in_transit");
    expect((await call("PUT", `/api/containers/${arrived}/lines`, { lines: [{ variantId: tyre, quantity: "2", unitPrice: "7.5" }] })).status).toBe(200);
    expect((await call("GET", `/api/reports/analytics?from=${today}&to=${today}`)).body.goodsOnTheWayUsd).toBe("15.00");
  });
});
