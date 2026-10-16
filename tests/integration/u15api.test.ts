import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U15: a payment split over a contact's franc and dollar debts, and container numbers typed with spaces. */
describe.skipIf(!hasDb)("Tenth UI audit", async () => {
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
  const day = "2026-08-03";
  let cashCdf: number, locationId: number, supplierId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "2800000" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("shows each part of a payment split over francs and dollars once, the exchange difference on the franc part only", async () => {
    const agent = (await call("POST", "/api/parties", { type: "agent", name: "Transit Lubumbashi" })).body;
    const container = (await call("POST", "/api/containers", { number: "HHU-15", supplierId, locationId, currency: "USD" })).body;
    // 280 800 FC owed at 2 808 (100 $), and 500 $ owed in dollars.
    expect((await call("POST", `/api/containers/${container.id}/expenses`, { date: day, type: "clearing", amount: "280800", currency: "CDF", rate: "2808", payablePartyId: agent.id })).status).toBeLessThan(300);
    expect((await call("POST", `/api/containers/${container.id}/expenses`, { date: day, type: "transport", amount: "500", currency: "USD", payablePartyId: agent.id })).status).toBeLessThan(300);
    // 1 000 000 FC at 2 800 (357,14 $): the francs owed first, the rest on the dollars.
    const pay = await call("POST", "/api/money/party-payment", { date: day, partyId: agent.id, accountId: cashCdf, amount: "1000000", rate: "2800" });
    expect(pay.status, JSON.stringify(pay.body)).toBeLessThan(300);
    const st = await call("GET", `/api/parties/${agent.id}/statement`);
    const rows = st.body.rows.filter((r: any) => r.type === "supplier_payment");
    expect(rows).toHaveLength(2);
    const francs = rows.find((r: any) => r.currency === "CDF");
    const dollars = rows.find((r: any) => r.currency === "USD");
    // The francs settled are worth 100,28 $ of the 357,14 $ paid (the rest went on the dollars); the books kept them at 100 $.
    expect(francs.debit).toBe("100.00");
    expect(francs.paid).toBe("100.28");
    expect(francs.fxDiff).toBe("-0.28");
    // The dollar part is shown as booked, with no exchange difference and not as the whole payment.
    expect(dollars.debit).toBe("256.86");
    expect(dollars.paid).toBeUndefined();
    expect(dollars.fxDiff).toBeUndefined();
    expect(st.body.balance).toBe("-243.14");
  });

  it("treats a container number typed with spaces or dots as the one already used", async () => {
    expect((await call("POST", "/api/containers", { number: "HHU-2026-010", supplierId, locationId, currency: "USD" })).status).toBe(201);
    const spaced = await call("POST", "/api/containers", { number: "HHU 2026 010", supplierId, locationId, currency: "USD" });
    expect(spaced.status).toBe(409);
    expect(spaced.body.code).toBe("DUPLICATE_NUMBER");
    expect(spaced.body.messageFr).toBe("Le numéro de conteneur HHU 2026 010 existe déjà (HHU-2026-010)");
    const same = await call("POST", "/api/containers", { number: "hhu-2026-010", supplierId, locationId, currency: "USD" });
    expect(same.body.messageFr).toBe("Le numéro de conteneur HHU-2026-010 existe déjà");
    const other = (await call("POST", "/api/containers", { number: "HHU-2026-011", supplierId, locationId, currency: "USD" })).body;
    expect((await call("PATCH", `/api/containers/${other.id}`, { number: "hhu.2026.010" })).status).toBe(409);
    // Renaming a container to its own number written differently is not a duplicate.
    expect((await call("PATCH", `/api/containers/${other.id}`, { number: "HHU 2026 011" })).status).toBe(200);
  });
});
