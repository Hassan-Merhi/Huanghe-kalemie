import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U18: a credit sale covered by the customer's avoir, one franc rounding figure everywhere, the dashboard's contact sides. */
describe.skipIf(!hasDb)("Thirteenth UI audit", async () => {
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
  let cashCdf: number, cashUsd: number, locationId: number, variantId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2808", lines: [{ accountId: otherIncome, amount: "20000000" }] })).status).toBe(201);
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashUsd, lines: [{ accountId: otherIncome, amount: "2000" }] })).status).toBe(201);
    const product = await call("POST", "/api/products", { name: "Pneu 2.75-17", unit: "pcs", variants: [{ attributes: {}, sellPrice: "27" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "5" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("says when a credit sale came off the customer's avoir, and what avoir was left", async () => {
    const garage = (await call("POST", "/api/parties", { type: "customer", name: "Garage Mwamba" })).body.id;
    // Paid ahead: 100 $ with nothing owed is a 100 $ avoir.
    expect((await call("POST", "/api/money/customer-receipt", { date: day, partyId: garage, accountId: cashUsd, amount: "100" })).status).toBe(201);
    const sale = await call("POST", "/api/sales", { date: day, locationId, customerId: garage, lines: [{ variantId, qty: "1", unitPrice: "11" }], payments: [] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.creditUsd).toBe("11.00");
    expect(sale.body.avoirUsedUsd).toBe("11.00");
    expect(sale.body.avoirLeftUsd).toBe("89.00");
    // A later sale bigger than what is left: only the 89 $ are covered, the rest is owed.
    const big = await call("POST", "/api/sales", { date: day, locationId, customerId: garage, lines: [{ variantId, qty: "4", unitPrice: "27" }], payments: [] });
    expect(big.body.avoirUsedUsd).toBe("89.00");
    expect(big.body.avoirLeftUsd).toBe("0.00");
    // The first sale still says what it was then, read again later.
    const again = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect(again.avoirUsedUsd).toBe("11.00");
    expect(again.avoirLeftUsd).toBe("89.00");
    // A customer with no avoir: nothing covered.
    const owes = (await call("POST", "/api/parties", { type: "customer", name: "Kabila Motos" })).body.id;
    const plain = await call("POST", "/api/sales", { date: day, locationId, customerId: owes, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [] });
    expect(plain.body.avoirUsedUsd).toBeNull();
  });

  it("gives the sale page the Sales list's franc rounding, signed + when the shop kept it", async () => {
    // 75 800 FC for 27 $ at 2 808 (75 816 FC): 16 FC short, a cent less for the shop.
    const short = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75800", rate: "2808" }] });
    expect(short.status, JSON.stringify(short.body)).toBe(201);
    expect(short.body.saleFcRoundingUsd).toBe("-0.01");
    expect(short.body.fcRoundingUsd).toBe("-0.01");
    // 75 900 FC: 84 FC over, kept by the shop.
    const over = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "75900", rate: "2808" }] });
    expect(over.body.saleFcRoundingUsd).toBe("0.03");
    // A return refunded in francs, rounded down to 100 FC: the shop keeps a little more, on the sale page as on the list.
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "2", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "54" }] });
    const lineId = sale.body.lines[0].id;
    const ret = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, lines: [{ saleLineId: lineId, qty: "1" }] });
    expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(300);
    const detail = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect(detail.saleFcRoundingUsd).toBe("0.00");
    // 27 $ is 75 816 FC: 75 800 FC handed back, 16 FC kept.
    expect(detail.fcRoundingUsd).toBe("0.01");
    const list = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body;
    for (const s of [short.body, over.body, detail]) expect(list.find((r) => r.id === s.id).fcRoundingUsd).toBe(s.fcRoundingUsd);
  });

  it("shows supplier advances apart from what we owe, and customer avoirs apart from their debts", async () => {
    const huanghe = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
    const transit = (await call("POST", "/api/parties", { type: "supplier", name: "Transit Uvira" })).body.id;
    // A supplier refund we must pass on is owed to them; a payment with nothing owed is an advance.
    expect((await call("POST", "/api/vouchers/receipt", { date: day, accountId: cashUsd, lines: [{ partyId: huanghe, amount: "500" }] })).status).toBe(201);
    expect((await call("POST", "/api/vouchers/payment", { date: day, accountId: cashUsd, lines: [{ partyId: transit, amount: "120" }] })).status).toBe(201);
    const dash = (await call("GET", "/api/reports/dashboard")).body;
    expect(dash.contactBalances.weOweSuppliers).toBe("500.00");
    expect(dash.contactBalances.supplierAdvances).toBe("120.00");
    expect(dash.payables).toBe("380.00");
    // Garage Mwamba owes 19 $ (108 − 89), Kabila Motos 27 $; nobody holds an avoir any more.
    expect(dash.contactBalances.customersOwe).toBe("46.00");
    expect(dash.contactBalances.customerAvoirs).toBe("0.00");
    const ahead = (await call("POST", "/api/parties", { type: "customer", name: "Client avance" })).body.id;
    expect((await call("POST", "/api/money/customer-receipt", { date: day, partyId: ahead, accountId: cashUsd, amount: "30" })).status).toBe(201);
    const after = (await call("GET", "/api/reports/dashboard")).body;
    expect(after.contactBalances.customerAvoirs).toBe("30.00");
    expect(after.contactBalances.customersOwe).toBe("46.00");
    expect(after.receivables).toBe("16.00");
  });
});
