import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { journals } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** U10: "Payé" net of cash refunds, recent sales net of returns, a voucher's default description, yuan messages in French. */
describe.skipIf(!hasDb)("Fifth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  let server: Server;
  let base = "";
  let cookie = "";
  let db: Db;
  async function call<T = any>(method: string, path: string, body?: unknown, lang?: string): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(lang ? { "accept-language": lang } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let accounts: any[] = [];
  let cashUsd: number, cashCdf: number, locationId: number, variantId: number, saleId: number;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2800", cnyPerUsd: "7.15" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Huile moteur 4T", unit: "pcs", variants: [{ attributes: {}, sellPrice: "11" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "4" }] })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: today, accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "280000" }] })).status).toBe(201);
    // 27 $ paid in dollars, then two of the three bottles come back with 22 $ handed back from the dollar drawer.
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "3", unitPrice: "9" }], payments: [{ accountId: cashUsd, amount: "27" }] });
    expect(sale.status).toBe(201);
    saleId = sale.body.id;
    const ret = await call("POST", `/api/sales/${saleId}/returns`, { reason: "Erreur", refundAccountId: cashUsd, lines: [{ saleLineId: sale.body.lines[0].id, qty: "2" }] });
    expect(ret.status).toBeLessThan(300);
  });

  afterAll(() => {
    server?.close();
  });

  it("lists the cash refunded on each sale's returns, so Payé reads net", async () => {
    const row = (await call<any[]>("GET", "/api/sales")).body.find((s) => s.id === saleId);
    expect(row.paidUsd).toBe("27.00");
    expect(row.returnedTotal).toBe("18.00");
    expect(row.refundedUsd).toBe("18.00");
    expect((await call("GET", `/api/sales/${saleId}`)).body.returns[0].refundUsd).toBe("18.00");
  });

  it("counts only the francs handed back when a refund is paid from the franc drawer", async () => {
    const sale = await call("POST", "/api/sales", { locationId, lines: [{ variantId, qty: "1", unitPrice: "5.01" }], payments: [{ accountId: cashUsd, amount: "5.01" }] });
    // 5,01 $ at 2 870 is 14 378 FC: 14 300 FC go back, worth 4,98 $ that day. The drawer's francs came in
    // at 2 800, so its line carries 5,11 $: the 0,13 $ are an exchange difference, not money refunded.
    const ret = await call("POST", `/api/sales/${sale.body.id}/returns`, { reason: "Taille", refundAccountId: cashCdf, rate: "2870", lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(300);
    expect(ret.body.returns[0]).toMatchObject({ refundNative: "14300.00", refundUsd: "4.98" });
    const row = (await call<any[]>("GET", "/api/sales")).body.find((s) => s.id === sale.body.id);
    expect(row.refundedUsd).toBe("4.98");
  });

  it("gives the dashboard's recent sales what came back", async () => {
    const dash = await call("GET", "/api/reports/dashboard");
    const row = dash.body.recentSales.find((s: any) => s.id === saleId);
    expect(row).toMatchObject({ total: "27.00", returnedTotal: "18.00" });
  });

  it("describes a voucher typed with no description by its first line", async () => {
    const rent = accounts.find((a) => a.code === "6000").id;
    const power = accounts.find((a) => a.type === "expense" && a.code !== "6000").id;
    const one = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashCdf, rate: "2800", lines: [{ accountId: rent, amount: "28000" }] });
    expect(one.status).toBe(201);
    const two = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ accountId: rent, amount: "5" }, { accountId: power, amount: "3" }] });
    const noted = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, memo: "Loyer d'octobre", lines: [{ accountId: rent, amount: "5" }] });
    const memo = async (id: number) => (await db.select().from(journals).where(eq(journals.id, id)))[0].memo;
    expect(await memo(one.body.id)).toBe("Loyer");
    expect(await memo(two.body.id)).toBe("Loyer + 1 autre");
    expect(await memo(noted.body.id)).toBe("Loyer d'octobre");
  });

  it("writes yuan amounts and rates the French way in a supplier payment's refusal", async () => {
    const supplier = await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" });
    const c = await call("POST", "/api/containers", { number: "CNY-1", supplierId: supplier.body.id, locationId, currency: "CNY", rateToUsd: "0.14" });
    expect(c.status).toBeLessThan(300);
    expect((await call("PUT", `/api/containers/${c.body.id}/lines`, { lines: [{ variantId, quantity: "10", unitPrice: "1430" }] })).status).toBeLessThan(300);
    expect((await call("POST", `/api/containers/${c.body.id}/finalize`, { offloadDate: today })).status).toBeLessThan(300);
    const tooMuch = await call("POST", "/api/money/party-payment", { date: today, partyId: supplier.body.id, accountId: cashUsd, amount: "100", settleNative: "20000" });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.messageFr).toMatch(/n'attend que 14 300,00 ¥/);
    // 200 $ for 1,43 ¥: 1 $ = 0,01 ¥, far from 7,15.
    const typo = await call("POST", "/api/money/party-payment", { date: today, partyId: supplier.body.id, accountId: cashUsd, amount: "200", settleNative: "1.43" });
    expect(typo.status).toBe(400);
    expect(typo.body.messageFr).toMatch(/1 \$ = 0,01 ¥.*avec 7,15/);
  });
});
