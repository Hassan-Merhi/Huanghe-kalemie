import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/**
 * U35: a yuan payment dated before the supplier's yuan debt starts is refused with that date and the day the
 * debt starts, not as if nothing were owed at all. The message only: what is refused is unchanged.
 */
describe.skipIf(!hasDb)("Thirtieth UI audit", async () => {
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
  const [before, offload] = ["2026-08-15", "2026-08-18"];
  let cashUsd: number, supplier: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    const locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    for (const date of ["2026-08-01", before, offload]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    }
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "5000" }] })).status).toBe(201);
    supplier = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group U35" })).body.id;
    const product = await call("POST", "/api/products", { name: "Pneu U35", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] });
    const box = await call("POST", "/api/containers", { number: "U35-1", supplierId: supplier, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "7", unitPrice: "1000" }] })).status).toBe(200);
    const off = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: offload });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
  });

  afterAll(() => {
    server?.close();
  });

  it("names the payment's date and the day the yuan debt starts", async () => {
    const back = await call("POST", "/api/money/party-payment", { date: before, partyId: supplier, accountId: cashUsd, amount: "140", settleNative: "1000" });
    expect(back.status).toBe(400);
    expect(back.body.messageFr).toBe("Huanghe Group U35 n'a rien à recevoir en yuans au 15/08/2026 (sa dette en yuans commence le 18/08/2026)");
    expect(back.body.message).toBe("Huanghe Group U35 is not owed anything in yuan on 2026-08-15 (their yuan debt starts on 2026-08-18)");
    // On the offload's day it goes through, and once all is paid nothing starts later.
    expect((await call("POST", "/api/money/party-payment", { date: offload, partyId: supplier, accountId: cashUsd, amount: "985.92", settleNative: "7000" })).status).toBe(201);
    const after = await call("POST", "/api/money/party-payment", { date: offload, partyId: supplier, accountId: cashUsd, amount: "14", settleNative: "100" });
    expect(after.status).toBe(400);
    expect(after.body.messageFr).toBe("Huanghe Group U35 n'a rien à recevoir en yuans au 18/08/2026");
  });
});
