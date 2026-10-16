import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** U19: "Payé" as the cash really kept after a franc refund, and the day's credit an avoir covered. */
describe.skipIf(!hasDb)("Fourteenth UI audit", async () => {
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

  it("reads Payé as the cash kept, so Payé − Total is the Arrondi FC, on the sale page and the list", async () => {
    // 151 700 FC for 54 $ at 2 808 (151 632 FC): 68 FC over, 0,02 $ kept by the shop.
    const sale = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "2", unitPrice: "27" }], payments: [{ accountId: cashCdf, amount: "151700", rate: "2808" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.paidUsd).toBe("54.00");
    expect(sale.body.saleFcRoundingUsd).toBe("0.02");
    expect(sale.body.paidKeptUsd).toBe("54.02");
    // One back, refunded in francs: 27 $ is 75 816 FC, 75 800 FC handed back (26,99 $), 0,01 $ more kept.
    const ret = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: day, reason: "Mauvaise taille", refundAccountId: cashCdf, lines: [{ saleLineId: sale.body.lines[0].id, qty: "1" }] });
    expect(ret.status, JSON.stringify(ret.body)).toBeLessThan(300);
    const detail = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect(detail.returns[0].refundUsd).toBe("26.99");
    expect(detail.fcRoundingUsd).toBe("0.03");
    // 54,02 $ in, 26,99 $ back: 27,03 $ kept, not the 27,01 $ of the booked 54 $ less the real refund.
    expect(detail.paidKeptUsd).toBe("27.03");
    const net = Number(detail.total) - Number(detail.returns[0].total);
    expect((Number(detail.paidKeptUsd) - net).toFixed(2)).toBe(detail.fcRoundingUsd);
    const row = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body.find((r) => r.id === sale.body.id);
    expect(row.paidKeptUsd).toBe("27.03");
    expect(row.fcRoundingUsd).toBe("0.03");
    // A dollar sale with no rounding keeps its booked figure.
    const plain = await call("POST", "/api/sales", { date: day, locationId, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "27" }] });
    expect(plain.body.paidKeptUsd).toBe("27.00");
    // A cancelled sale keeps its booked figure too.
    const voided = await call("POST", `/api/sales/${plain.body.id}/void`, { reason: "Erreur de saisie" });
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
    const after = (await call<any[]>("GET", `/api/sales?from=${day}&to=${day}`)).body.find((r) => r.id === plain.body.id);
    expect(after.paidKeptUsd).toBe("27.00");
  });

  it("counts apart the day's credit an avoir covered", async () => {
    const dayB = "2026-08-04";
    const ahead = (await call("POST", "/api/parties", { type: "customer", name: "Garage Mwamba" })).body.id;
    const owes = (await call("POST", "/api/parties", { type: "customer", name: "Kabila Motos" })).body.id;
    expect((await call("POST", "/api/money/customer-receipt", { date: dayB, partyId: ahead, accountId: cashUsd, amount: "20" })).status).toBe(201);
    // 27 $ on credit with a 20 $ avoir: 20 $ on the avoir, 7 $ owed; 27 $ more on credit with none.
    const a = await call("POST", "/api/sales", { date: dayB, locationId, customerId: ahead, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [] });
    expect(a.body.avoirUsedUsd).toBe("20.00");
    expect((await call("POST", "/api/sales", { date: dayB, locationId, customerId: owes, lines: [{ variantId, qty: "1", unitPrice: "27" }], payments: [] })).status).toBe(201);
    const daily = (await call("GET", `/api/reports/daily?date=${dayB}`)).body;
    expect(daily.credit).toBe("54.00");
    expect(daily.creditOnAvoirUsd).toBe("20.00");
    // The Sales list says the same of each sale, as the sale page does.
    const rows = (await call<any[]>("GET", `/api/sales?from=${dayB}&to=${dayB}`)).body;
    expect(rows.find((r) => r.id === a.body.id).avoirUsedUsd).toBe("20.00");
    expect(rows.filter((r) => r.id !== a.body.id).map((r) => r.avoirUsedUsd)).toEqual(["0.00"]);
    // The first day's sales gave no credit at all.
    expect((await call("GET", `/api/reports/daily?date=${day}`)).body.creditOnAvoirUsd).toBe("0.00");
  });
});
