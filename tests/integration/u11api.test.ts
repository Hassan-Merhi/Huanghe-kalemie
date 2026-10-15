import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import Decimal from "decimal.js";
import { hasDb, resetDatabase } from "./helpers";

/** U11: an exact franc container rate, a voucher's amount as on the daybook, the dashboard's margin apart, a payment's split. */
describe.skipIf(!hasDb)("Sixth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const { usdPerUnit } = await import("../../client/src/lib/format");
  const { paymentSplit } = await import("../../client/src/lib/allocation");
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
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let accounts: any[] = [];
  let cashUsd: number, cashCdf: number, locationId: number, variantId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Huanghe HH150-8", unit: "pcs", variants: [{ attributes: {}, sellPrice: "1450" }] });
    variantId = product.body.variants[0].id;
    // 2 800 000 FC that cost 1 000 $ (2 800 FC for 1 $), and 1 000 $ in the dollar drawer.
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "2800000" }] })).status).toBe(201);
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "1000" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("costs a franc container at 2 808 FC for 1 $ exactly: 35 000 000 FC are 12 464,39 $", async () => {
    const supplier = await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group (Chongqing)" });
    const c = await call("POST", "/api/containers", { number: "CDF-1", supplierId: supplier.body.id, locationId, currency: "CDF", rateToUsd: usdPerUnit("2808") });
    expect(c.status, JSON.stringify(c.body)).toBeLessThan(300);
    expect((await call("GET", `/api/containers/${c.body.id}`)).body.rateToUsd).toBe("0.000356125356");
    expect((await call("PUT", `/api/containers/${c.body.id}/lines`, { lines: [{ variantId, quantity: "10", unitPrice: "3500000" }] })).status).toBeLessThan(300);
    const fin = await call("POST", `/api/containers/${c.body.id}/finalize`, { offloadDate: today });
    expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
    const after = (await call("GET", `/api/containers/${c.body.id}`)).body;
    expect(after.fobTotalUsd).toBe("12464.39");
    expect(after.lines[0].landedUnitCost).toBe("1246.439000");
    const st = (await call("GET", `/api/parties/${supplier.body.id}/statement`)).body;
    expect(st.balance).toBe("-12464.39");
    expect(st.foreign).toEqual([expect.objectContaining({ currency: "CDF", native: "-35000000.00", usd: "-12464.39" })]);
  });

  it("gives a franc voucher the daybook's amount, with the exchange difference apart", async () => {
    const rent = accounts.find((a) => a.code === "6000").id;
    // 1 400 000 FC at 2 808 = 498,58 $; the drawer's francs cost 500,00 $, so 1,42 $ is an exchange loss.
    const v = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, rate: "2808", memo: "Loyer d'octobre boutique", lines: [{ accountId: rent, amount: "1400000" }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const voucher = (await call("GET", `/api/vouchers/${v.body.id}`)).body;
    expect(voucher.amount).toBe("498.58");
    expect(voucher.fxDiff).toBe("1.42");
    expect(voucher.total).toBe("500.00");
    const cash = voucher.lines.find((l: any) => l.accountId === cashCdf);
    expect(cash).toMatchObject({ systemKey: "cash_cdf", credit: "500.00", nativeAmount: "-1400000.00" });
    expect(voucher.lines.find((l: any) => l.systemKey === "fx")).toMatchObject({ debit: "1.42" });
    const day = (await call("GET", `/api/daybook?from=${today}&to=${today}`)).body.rows.find((r: any) => r.id === v.body.id);
    expect(day.amount).toBe(voucher.amount);
  });

  it("splits the dashboard's gross profit into the margin on sales and what the books add", async () => {
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "1", unitPrice: "1450" }], payments: [{ accountId: cashUsd, amount: "1450" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const dash = (await call("GET", "/api/reports/dashboard")).body;
    // 1 450,00 − 1 246,44 on the sale; −1,42 $ of exchange; the opening receipts as other income.
    expect(dash.monthMargin).toEqual({ sales: "203.56", stockAdjustments: "0.00", fx: "-1.42", other: "2000.00" });
    const parts = Object.values(dash.monthMargin as Record<string, string>).reduce((s, x) => s.plus(x), new Decimal(0));
    expect(parts.toFixed(2)).toBe(dash.monthPnl.grossProfit);
  });

  it("settles a supplier's debts in the order the payment dialog says", async () => {
    const supplier = (await call("POST", "/api/parties", { type: "supplier", name: "Transit Kalemie" })).body;
    const fuel = accounts.find((a) => a.code === "6030").id;
    expect((await call("POST", "/api/expenses", { date: today, accountId: fuel, description: "Transport", amount: "500", payablePartyId: supplier.id })).status).toBe(201);
    expect((await call("POST", "/api/expenses", { date: today, accountId: fuel, description: "Manutention", amount: "280800", currency: "CDF", rate: "2808", payablePartyId: supplier.id })).status).toBe(201);
    const split = paymentSplit({ usd: new Decimal(700), francs: null, rate: new Decimal(2808), owedUsd: new Decimal(500), owedFc: new Decimal(280800) });
    expect(split).toEqual([{ kind: "usd", usd: "500.00" }, { kind: "cdf", usd: "100.00", native: "280800.00" }, { kind: "advance", usd: "100.00", native: null }]);
    expect((await call("POST", "/api/money/party-payment", { date: today, partyId: supplier.id, accountId: cashUsd, amount: "700" })).status).toBe(201);
    const st = (await call("GET", `/api/parties/${supplier.id}/statement`)).body;
    // The francs are settled in full, and the 100 $ left over is an advance.
    expect(st.foreign.filter((f: any) => f.currency === "CDF" && Number(f.native) !== 0)).toEqual([]);
    expect(st.balance).toBe("100.00");
  });
});
