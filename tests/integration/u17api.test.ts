import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U17: who prepared a validated pending voucher, the statement order of a split payment, the sales list's franc rounding. */
describe.skipIf(!hasDb)("Twelfth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  let server: Server;
  let base = "";
  const jars: Record<string, string> = {};
  let who = "admin";
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jars[who] ? { cookie: jars[who] } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) jars[who] = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const day = "2026-08-03";
  let cashCdf: number, cashUsd: number, locationId: number, supplierId: number, expenseId: number, variantId: number;

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
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2808", lines: [{ accountId: otherIncome, amount: "20000000" }] })).status).toBe(201);
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "2000" }] })).status).toBe(201);
    const product = await call("POST", "/api/products", { name: "Pneu 2.75-17", unit: "pcs", variants: [{ attributes: {}, sellPrice: "27" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "15" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("keeps who prepared a pending voucher once someone else validates it", async () => {
    const m = await call("POST", "/api/users", { username: "jean", fullName: "Jean Gérant", password: "manager-pass-1", role: "manager" });
    expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
    who = "jean";
    expect((await call("POST", "/api/auth/login", { username: "jean", password: "manager-pass-1" })).status).toBe(200);
    const draft = await call("POST", "/api/voucher-drafts", { kind: "payment", date: day, memo: "Loyer octobre", payload: { accountId: cashUsd, lines: [{ accountId: expenseId, amount: "500" }] } });
    expect(draft.status).toBe(201);
    const edited = await call("POST", "/api/voucher-drafts", { id: draft.body.id, kind: "payment", date: day, memo: "Loyer octobre (corrigé)", payload: { accountId: cashUsd, memo: "Loyer octobre (corrigé)", lines: [{ accountId: expenseId, amount: "600" }] } });
    expect(edited.status).toBe(200);
    who = "admin";
    const done = await call("POST", `/api/voucher-drafts/${draft.body.id}/finalize`, { updatedAt: edited.body.updatedAt });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const journalId = done.body.result.id;
    const owner = (await call<any>("GET", "/api/auth/me")).body;
    const ownerName = owner.fullName ?? owner.user?.fullName;
    const v = (await call("GET", `/api/vouchers/${journalId}`)).body;
    expect(v.createdByName).toBe("Jean Gérant");
    expect(v.validatedByName).toBe(ownerName);
    const row = (await call("GET", `/api/daybook?from=${day}&to=${day}`)).body.rows.find((r: any) => r.id === journalId);
    expect(row.createdByName).toBe("Jean Gérant");
    expect(row.validatedByName).toBe(ownerName);
    // A voucher the owner posts directly, or validates from their own draft, names only them.
    const own = await call("POST", "/api/voucher-drafts", { kind: "payment", date: day, memo: "Eau", payload: { accountId: cashUsd, lines: [{ accountId: expenseId, amount: "10" }] } });
    const mine = await call("POST", `/api/voucher-drafts/${own.body.id}/finalize`, { updatedAt: own.body.updatedAt });
    const ownV = (await call("GET", `/api/vouchers/${mine.body.result.id}`)).body;
    expect(ownV.createdByName).toBe(ownerName);
    expect(ownV.validatedByName).toBeNull();
  });

  it("lists the parts of a split payment that settle debts before the advance", async () => {
    const agent = (await call("POST", "/api/parties", { type: "agent", name: "Transit Lubumbashi" })).body;
    const container = (await call("POST", "/api/containers", { number: "HHU-17", supplierId, locationId, currency: "USD" })).body;
    expect((await call("POST", `/api/containers/${container.id}/expenses`, { date: day, type: "clearing", amount: "84000", currency: "CDF", rate: "2808", payablePartyId: agent.id })).status).toBeLessThan(300);
    expect((await call("POST", `/api/containers/${container.id}/expenses`, { date: day, type: "transport", amount: "3200", currency: "USD", payablePartyId: agent.id })).status).toBeLessThan(300);
    const pay = await call("POST", "/api/money/party-payment", { date: day, partyId: agent.id, accountId: cashCdf, amount: "10000000", rate: "2808" });
    expect(pay.status, JSON.stringify(pay.body)).toBeLessThan(300);
    const st = (await call("GET", `/api/parties/${agent.id}/statement`)).body;
    const parts = st.rows.filter((r: any) => r.type === "supplier_payment");
    expect(parts.length).toBe(3);
    // Each running balance existed: the debt goes down to nothing, then the advance.
    const balances = parts.map((r: any) => Number(r.balance));
    expect(balances[0]).toBeLessThan(0);
    expect(balances[0]).toBeGreaterThan(-3230.1);
    expect(balances[1]).toBeCloseTo(0, 2);
    expect(balances[2]).toBeGreaterThan(0);
    expect(st.rows.every((r: any) => Number(r.balance) >= -3230.1 - 0.001)).toBe(true);
  });

  it("tells the sales list the franc rounding of a walk-in sale refunded in francs", async () => {
    // 27 $ paid with 75 816 FC; the tyre comes back and 75 800 FC go back (rounded down): 0,01 $ kept.
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75816" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const back = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const row = (await call<any[]>("GET", "/api/sales")).body.find((r) => r.id === sale.body.id);
    expect(row.customerName).toBeNull();
    expect(row.refundedUsd).toBe("26.99");
    // "Payé" 0,01 $ over a total of 0 $: all of it franc rounding, none on a customer's account.
    expect(row.fcRoundingUsd).toBe("0.01");
    // A sale in dollars has none.
    const usdSale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "27" }] });
    expect((await call<any[]>("GET", "/api/sales")).body.find((r) => r.id === usdSale.body.id).fcRoundingUsd).toBe("0.00");
  });
});
