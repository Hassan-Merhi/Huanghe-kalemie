import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

const NB = " ";

/** U8: franc refunds rounded like the till's change, French server messages, and document amounts in the daybook. */
describe.skipIf(!hasDb)("Refund rounding, French messages and document amounts", async () => {
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
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Bougie", unit: "pcs", variants: [{ attributes: {}, sellPrice: "5.01" }] });
    expect(product.status).toBe(201);
    variantId = product.body.variants[0].id;
    const adj = await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "2" }] });
    expect(adj.status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "2800000" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("hands a franc refund back in 100 FC steps and posts the difference as the till's rounding", async () => {
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "2", unitPrice: "5.01" }], payments: [{ accountId: cashUsd, amount: "10.02" }] });
    expect(sale.status).toBe(201);
    // 5,01 $ at 2 800 is 14 028 FC: 14 000 FC go back and the 28 FC (0,01 $) are rounding.
    const ret = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, rate: "2800", lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status).toBeLessThan(300);
    const r = ret.body.returns[0];
    expect(r.total).toBe("5.01");
    expect(r.refundNative).toBe("14000.00");
    const book = await call("GET", `/api/daybook?from=${day}&to=${day}&type=sale_return`);
    const lines = book.body.rows[0].lines;
    const cash = lines.find((l: any) => l.accountId === cashCdf);
    expect(cash.credit).toBe("5.00");
    const rounding = lines.find((l: any) => l.memo === "Arrondi FC");
    expect(rounding.credit).toBe("0.01");
    expect(book.body.rows[0].amount).toBe("5.01");
  });

  it("writes amounts, dates and spacing the French way in French messages", async () => {
    const rent = accounts.find((a) => a.type === "expense" && !a.systemKey)?.id ?? accounts.find((a) => a.type === "expense").id;
    const short = await call("POST", "/api/vouchers/payment", { date: day, accountId: cashUsd, lines: [{ accountId: rent, amount: "1800" }] });
    expect(short.status).toBe(409);
    expect(short.body.message).toMatch(/would be [\d.]+ USD short on 2026-08-03\./);
    expect(short.body.messageFr).toMatch(new RegExp(`^Solde insuffisant sur Caisse USD${NB}: il manquerait 1${NB}7\\d\\d,\\d\\d${NB}\\$ au 03/08/2026\\.$`));

    const decimals = await call("POST", "/api/vouchers/payment", { date: day, accountId: cashCdf, rate: "2800", lines: [{ accountId: rent, amount: "45000.5" }] });
    expect(decimals.status).toBe(400);
    expect(decimals.body.messageFr).toBe(`Les montants en FC sont des nombres entiers (45${NB}000,5${NB}FC a des décimales)`);

    // Months close in order, named in words.
    const order = await call("POST", "/api/periods/2026-09/close");
    expect(order.status).toBe(409);
    expect(order.body.messageFr).toBe("Clôturez d'abord août 2026. Les mois se clôturent dans l'ordre.");
    expect(order.body.message).toBe("Close 2026-08 first. Months are closed in order.");
  });

  it("shows a container cost paid in francs at its own rate, with the exchange difference apart", async () => {
    // Francs taken in at 2 800 (before the tests), spent on a cost billed at 2 808.
    const supplier = await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" });
    const container = await call("POST", "/api/containers", { number: "HHU-8", supplierId: supplier.body.id, locationId, currency: "USD" });
    expect(container.status).toBe(201);
    const cost = await call("POST", `/api/containers/${container.body.id}/expenses`, { date: day, type: "duties", amount: "2500000", currency: "CDF", rate: "2808", paidFromAccountId: cashCdf });
    expect(cost.status).toBeLessThan(300);
    expect(cost.body.amountUsd).toBe("890.31");
    const book = await call("GET", `/api/daybook?from=${day}&to=${day}&type=container_expense`);
    const row = book.body.rows[0];
    expect(row.amount).toBe("890.31");
    // The francs left the box at 2 800 (892,86 $): 2,55 $ of exchange loss beside the document.
    expect(row.fxDiff).toBe("2.55");
  });

  it("shows on a supplier's statement what was paid, with the exchange difference apart", async () => {
    // A bill of 280 800 FC at 2 808 (100 $), paid with francs taken in at 2 800 (100,29 $).
    const agent = await call("POST", "/api/parties", { type: "agent", name: "Transitaire" });
    const container = await call("POST", "/api/containers", { number: "HHU-9", supplierId: (await call<any[]>("GET", "/api/parties")).body.find((p) => p.type === "supplier").id, locationId, currency: "USD" });
    const bill = await call("POST", `/api/containers/${container.body.id}/expenses`, { date: day, type: "clearing", amount: "280800", currency: "CDF", rate: "2808", payablePartyId: agent.body.id });
    expect(bill.status).toBeLessThan(300);
    const pay = await call("POST", "/api/money/party-payment", { date: day, partyId: agent.body.id, accountId: cashCdf, amount: "280800", rate: "2800" });
    expect(pay.status).toBeLessThan(300);
    const st = await call("GET", `/api/parties/${agent.body.id}/statement`);
    const row = st.body.rows.find((r: any) => r.type === "supplier_payment");
    expect(row.debit).toBe("100.00");
    expect(row.paid).toBe("100.29");
    expect(row.fxDiff).toBe("-0.29");
    expect(st.body.balance).toBe("0.00");
  });

  it("shows a stock count at its net change, with what was found and lost apart", async () => {
    const other = await call("POST", "/api/products", { name: "Chaîne", unit: "pcs", variants: [{ attributes: {}, sellPrice: "10" }] });
    const otherId = other.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: otherId, qtyChange: "10", unitCost: "4" }] })).status).toBeLessThan(300);
    const count = await call("POST", "/api/stock/adjustments", {
      date: day,
      locationId,
      kind: "count",
      reason: "Inventaire",
      lines: [
        { variantId, qtyChange: "1" },
        { variantId: otherId, qtyChange: "-3" },
      ],
    });
    expect(count.status).toBeLessThan(300);
    const book = await call("GET", `/api/daybook?from=${day}&to=${day}&type=stock_adjustment`);
    const row = book.body.rows[0];
    expect(row.stockAdded).toBe("2.00");
    expect(row.stockRemoved).toBe("12.00");
    expect(row.amount).toBe("-10.00");
  });
});
