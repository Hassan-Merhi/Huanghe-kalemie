import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

const NB = " ";

/** U13: rates said in shop terms, container numbers named, credit after returns, revaluation vouchers. */
describe.skipIf(!hasDb)("Eighth UI audit", async () => {
  const { createApp } = await import("../../server/index");
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
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let accounts: any[] = [];
  let cashUsd: number, cashCdf: number, locationId: number, variantId: number, supplierId: number, customerId: number;

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
    // August: francs taken in at 2 800, the month ends at 2 900 (a revaluation to post on closing).
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2800" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2800", lines: [{ accountId: otherIncome, amount: "280000" }] })).status).toBe(201);
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-31", cdfPerUsd: "2900" })).status).toBeLessThan(300);
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const product = await call("POST", "/api/products", { name: "Pneu 2.75-17", unit: "pcs", variants: [{ attributes: {}, sellPrice: "27" }] });
    variantId = product.body.variants[0].id;
    const adj = await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "15" }] });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Chongqing Huanghe" })).body.id;
    customerId = (await call("POST", "/api/parties", { type: "customer", name: "Garage Tanganyika" })).body.id;
  });

  afterAll(() => {
    server?.close();
  });

  it("writes a manager's refused rate French-style, and still lets the owner save it", async () => {
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    // Compared with the last rate before today (2 900 on 31 August), the nearest of those on file.
    const far = await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "28500" }, "gerant");
    expect(far.status).toBe(403);
    expect(far.body.messageFr).toBe(`28${NB}500${NB}FC pour 1${NB}$ s'écarte de plus de 5${NB}% du dernier taux (2${NB}900${NB}FC). Seul le propriétaire peut faire ce changement.`);
    // The owner confirms on the dashboard and may save it; put the right rate back after.
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2.85" })).status).toBe(200);
    expect((await call("GET", `/api/exchange-rates/for/${today}`)).body.cdfPerUsd).toBe("2.8500");
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBe(200);
  });

  it("says a container rate far from the day's in francs for 1 $", async () => {
    // "2,808" FC for 1 $ (2.808 read as a decimal): 1 FC = 0,356 $.
    const wrong = await call("POST", "/api/containers", { number: "CDF-A8", supplierId, locationId, currency: "CDF", rateToUsd: "0.356125356125" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.messageFr).toBe(`Le taux du conteneur (2,808${NB}FC pour 1${NB}$) s'écarte de plus de 5${NB}% du taux enregistré (2${NB}808${NB}FC pour 1${NB}$). Vérifiez-le, ou mettez d'abord à jour le taux du jour.`);
    expect(wrong.body.message).toMatch(/^The container rate \(2\.808 FC for \$1\) is more than 5% away from the rate on file \(2808 FC for \$1\)/);
    const right = await call("POST", "/api/containers", { number: "CDF-A8", supplierId, locationId, currency: "CDF", rateToUsd: "0.000356125356" });
    expect(right.status, JSON.stringify(right.body)).toBe(201);
  });

  it("names a container number already used, on creating and on renaming", async () => {
    const first = await call("POST", "/api/containers", { number: "CNY-A8", supplierId, locationId, currency: "USD" });
    expect(first.status).toBe(201);
    const again = await call("POST", "/api/containers", { number: " cny-a8 ", supplierId, locationId, currency: "USD" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("DUPLICATE_NUMBER");
    expect(again.body.messageFr).toBe("Le numéro de conteneur CNY-A8 existe déjà");
    const other = await call("POST", "/api/containers", { number: "CNY-A9", supplierId, locationId, currency: "USD" });
    const rename = await call("PATCH", `/api/containers/${other.body.id}`, { number: "CNY-A8" });
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe("DUPLICATE_NUMBER");
    // Keeping its own number is not a clash.
    expect((await call("PATCH", `/api/containers/${first.body.id}`, { number: "CNY-A8", notes: "ok" })).status).toBe(200);
  });

  it("gives the sales list and the day's summary the credit left after returns, as the ledger has it", async () => {
    const sale = await call("POST", "/api/sales", { locationId, customerId, lines: [{ variantId, qty: "2", unitPrice: "27" }], payments: [{ accountId: cashUsd, amount: "20" }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.creditUsd).toBe("34.00");
    const lineId = sale.body.lines[0].id;
    const row = async () => (await call<any[]>("GET", "/api/sales")).body.find((r) => r.id === sale.body.id);
    expect((await row()).creditLeftUsd).toBe("34.00");
    // One tyre back, taken off what the customer owes: 7,00 $ left on credit.
    expect((await call("POST", `/api/sales/${sale.body.id}/returns`, { date: today, reason: "Mauvaise taille", refundAccountId: null, lines: [{ saleLineId: lineId, qty: "1" }] })).status).toBe(200);
    expect((await row()).creditLeftUsd).toBe("7.00");
    expect((await call("GET", `/api/reports/daily?date=${today}`)).body.credit).toBe("7.00");
    // The other paid back from the drawer: the 7,00 $ unpaid come off the debt first, 20,00 $ in cash.
    const back = await call("POST", `/api/sales/${sale.body.id}/returns`, { date: today, reason: "Mauvaise taille", refundAccountId: cashUsd, lines: [{ saleLineId: lineId, qty: "1" }] });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const after = await row();
    expect(after.creditUsd).toBe("34.00");
    expect(after.creditLeftUsd).toBe("0.00");
    expect(after.refundedUsd).toBe("20.00");
    expect((await call("GET", `/api/reports/daily?date=${today}`)).body.credit).toBe("0.00");
    // The sale page reads the same lines: 27 + 7 taken off the balance.
    const full = (await call("GET", `/api/sales/${sale.body.id}`)).body;
    expect(full.returns.map((r: any) => r.refundToBalanceUsd).sort()).toEqual(["27.00", "7.00"]);
  });

  it("names who moved stock by their full name", async () => {
    const shop2 = await call("POST", "/api/locations", { name: "Dépôt" });
    const moved = await call("POST", "/api/stock/transfers", { date: today, fromLocationId: locationId, toLocationId: shop2.body.id, lines: [{ variantId, qty: "1" }] }, "gerant");
    expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(300);
    const list = (await call<any[]>("GET", `/api/stock/transfers?from=${today}&to=${today}`)).body;
    expect(list[0].userName).toBe("Jean Gérant");
    expect(list[0].username).toBe("gerant");
  });

  it("gives a revaluation voucher its amount and a French date and rate", async () => {
    // 280 000 FC worth 100,00 $ at 2 800 are worth 96,55 $ at 2 900: a 3,45 $ revaluation.
    const closed = await call("POST", "/api/periods/2026-08/close");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const book = await call("GET", "/api/daybook?from=2026-08-31&to=2026-08-31&type=revaluation");
    const reval = book.body.rows[0];
    expect(reval.memo).toBe(`Réévaluation des devises au 31/08/2026 (1${NB}$ = 2${NB}900${NB}FC)`);
    expect(reval.amount).toBe("3.45");
    const voucher = (await call("GET", `/api/vouchers/${reval.id}`)).body;
    expect(voucher.amount).toBe("3.45");
  });
});
