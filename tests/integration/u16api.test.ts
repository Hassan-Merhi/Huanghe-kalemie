import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U16: the francs handed over for the dollar part of a payment, on the contact's statement. */
describe.skipIf(!hasDb)("Eleventh UI audit", async () => {
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
  let cashCdf: number, cashUsd: number, locationId: number, supplierId: number, expenseId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    expenseId = accounts.find((a) => a.type === "expense" && !a.systemKey)?.id ?? accounts.find((a) => a.type === "expense").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "5600000" }] })).status).toBe(201);
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "2000" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  async function agentOwing(name: string, francs: string | null, dollars: string) {
    const agent = (await call("POST", "/api/parties", { type: "agent", name })).body;
    const container = (await call("POST", "/api/containers", { number: `HHU-${name.length}-${Date.now() % 100000}`, supplierId, locationId, currency: "USD" })).body;
    if (francs) expect((await call("POST", `/api/containers/${container.id}/expenses`, { date: day, type: "clearing", amount: francs, currency: "CDF", rate: "2808", payablePartyId: agent.id })).status).toBeLessThan(300);
    expect((await call("POST", `/api/containers/${container.id}/expenses`, { date: day, type: "transport", amount: dollars, currency: "USD", payablePartyId: agent.id })).status).toBeLessThan(300);
    return agent;
  }

  it("shows the francs handed over for the dollar part of a split franc payment", async () => {
    const agent = await agentOwing("Transit Lubumbashi", "280800", "500");
    // 1 000 000 FC at 2 800: 280 800 FC settle the francs owed, the other 719 200 FC (256,86 $) the dollars.
    expect((await call("POST", "/api/money/party-payment", { date: day, partyId: agent.id, accountId: cashCdf, amount: "1000000", rate: "2800" })).status).toBeLessThan(300);
    const rows = (await call(`GET`, `/api/parties/${agent.id}/statement`)).body.rows.filter((r: any) => r.type === "supplier_payment");
    const dollars = rows.find((r: any) => r.currency === "USD");
    const francs = rows.find((r: any) => r.currency === "CDF");
    expect(dollars.debit).toBe("256.86");
    expect(dollars.tendered).toBe("719200.00");
    // The franc part already shows its own francs.
    expect(francs.tendered).toBeUndefined();
    expect(francs.nativeAmount).toBe("280800.00");
  });

  it("shows the francs of a dollar debt paid wholly in francs, and none for dollars paid in dollars", async () => {
    const agent = await agentOwing("Transit Kalemie", null, "400");
    expect((await call("POST", "/api/money/party-payment", { date: day, partyId: agent.id, accountId: cashCdf, amount: "560000", rate: "2800" })).status).toBeLessThan(300);
    expect((await call("POST", "/api/money/party-payment", { date: day, partyId: agent.id, accountId: cashUsd, amount: "100" })).status).toBeLessThan(300);
    const rows = (await call(`GET`, `/api/parties/${agent.id}/statement`)).body.rows.filter((r: any) => r.type === "supplier_payment");
    expect(rows).toHaveLength(2);
    const inFrancs = rows.find((r: any) => r.debit === "200.00");
    const inDollars = rows.find((r: any) => r.debit === "100.00");
    expect(inFrancs.currency).toBe("USD");
    expect(inFrancs.tendered).toBe("560000.00");
    expect(inDollars.tendered).toBeUndefined();
  });

  it("does not give a contact the francs of another line of the same voucher", async () => {
    const agent = await agentOwing("Transit Uvira", null, "300");
    // 280 000 FC for the agent and 140 000 FC of expense, out of one franc box.
    const v = await call("POST", "/api/vouchers/payment", { date: day, accountId: cashCdf, rate: "2800", lines: [{ partyId: agent.id, amount: "280000" }, { accountId: expenseId, amount: "140000" }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const row = (await call(`GET`, `/api/parties/${agent.id}/statement`)).body.rows.find((r: any) => r.type === "payment");
    expect(row.debit).toBe("100.00");
    expect(row.tendered).toBeUndefined();
  });
});
