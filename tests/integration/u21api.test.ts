import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";
import { zodIssueFr } from "../../server/http";

/** U21: one franc rate per sale, readable validation errors, the customer payment memo and per-line francs on a voucher. */
describe.skipIf(!hasDb)("Sixteenth UI audit", async () => {
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
  let cashCdf: number, cashUsd: number, locationId: number, variantId: number, rent: number, power: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const accounts = (await call<any[]>("GET", "/api/accounts")).body;
    cashCdf = accounts.find((a) => a.systemKey === "cash_cdf").id;
    cashUsd = accounts.find((a) => a.systemKey === "cash_usd").id;
    const spend = accounts.filter((a) => a.type === "expense" && !a.systemKey && !a.partnerId);
    rent = spend[0].id;
    power = spend[1].id;
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    expect((await call("POST", "/api/exchange-rates", { date: "2026-08-01", cdfPerUsd: "2808" })).status).toBeLessThan(300);
    const otherIncome = accounts.find((a) => a.systemKey === "other_income").id;
    expect((await call("POST", "/api/vouchers/receipt", { date: "2026-08-01", accountId: cashCdf, rate: "2808", lines: [{ accountId: otherIncome, amount: "20000000" }] })).status).toBe(201);
    const product = await call("POST", "/api/products", { name: "Pneu 2.75-17", unit: "pcs", variants: [{ attributes: {}, sellPrice: "22" }] });
    variantId = product.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: "2026-08-01", locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: "20", unitCost: "5" }] })).status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  it("refuses franc payments of one sale typed at two rates, rather than valuing them all at the first", async () => {
    const lines = [{ variantId, qty: "1", unitPrice: "22" }];
    const two = await call("POST", "/api/sales", {
      date: day,
      locationId,
      lines,
      payments: [{ accountId: cashCdf, amount: "40000", rate: "2808" }, { accountId: cashCdf, amount: "21776", rate: "2750" }],
    });
    expect(two.status).toBe(400);
    expect(two.body.messageFr).toContain("même taux");
    expect(two.body.messageFr).toContain("2 808");
    expect(two.body.messageFr).toContain("2 750");
    // A rate left out is the day's rate: the same as 2 808 typed.
    const same = await call("POST", "/api/sales", {
      date: day,
      locationId,
      lines,
      payments: [{ accountId: cashCdf, amount: "40000", rate: "2808" }, { accountId: cashCdf, amount: "21776" }],
    });
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    expect(same.body.creditUsd).toBe("0.00");
    // One typed rate within the tolerance still works for the owner, and the change goes back at it.
    const typed = await call("POST", "/api/sales", {
      date: day,
      locationId,
      lines,
      payments: [{ accountId: cashCdf, amount: "30000", rate: "2750" }, { accountId: cashCdf, amount: "30500", rate: "2750" }],
    });
    expect(typed.status, JSON.stringify(typed.body)).toBe(201);
    expect(typed.body.creditUsd).toBe("0.00");
    expect(typed.body.payments.every((p: any) => p.rate === null || Number(p.rate) === 2750)).toBe(true);
  });

  it("says validation errors in words, not as a field path", async () => {
    const bad = await call("POST", "/api/vouchers/payment", { date: day, accountId: cashUsd, lines: [{ accountId: rent, amount: "0.00" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.messageFr).toBe("Ligne 1 : le montant doit être supérieur à zéro.");
    expect(bad.body.messageFr).not.toContain("lines.0");
    expect(zodIssueFr({ path: ["payments", 2, "qty"], message: "Must be greater than zero" })).toBe("Paiement 3 : la quantité doit être supérieure à zéro.");
    expect(zodIssueFr({ path: ["date"], message: "Use a date like 2026-10-12" })).toBe("La date doit être une date comme 2026-10-12.");
    expect(zodIssueFr({ path: ["lines", 0, "amount"], message: "Required" })).toBe("Ligne 1 : le montant est manquant ou invalide.");
    expect(zodIssueFr({ path: ["somethingElse"], message: "Required" })).toBeNull();
  });

  it("writes the customer payment memo with the elision: Paiement d'Atelier Bahati", async () => {
    const customer = (await call("POST", "/api/parties", { type: "customer", name: "Atelier Bahati" })).body;
    const paid = await call("POST", "/api/money/customer-receipt", { date: day, partyId: customer.id, accountId: cashUsd, amount: "10" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect((await call("GET", `/api/vouchers/${paid.body.id}`)).body.memo).toBe("Paiement d'Atelier Bahati");
    const other = (await call("POST", "/api/parties", { type: "customer", name: "Garage Mwamba" })).body;
    const paid2 = await call("POST", "/api/money/customer-receipt", { date: day, partyId: other.id, accountId: cashUsd, amount: "10" });
    expect((await call("GET", `/api/vouchers/${paid2.body.id}`)).body.memo).toBe("Paiement de Garage Mwamba");
  });

  it("gives each franc expense line of a voucher its francs for the print", async () => {
    const v = await call("POST", "/api/vouchers/payment", {
      date: day,
      accountId: cashCdf,
      rate: "2808.5",
      memo: "Test petit montant",
      lines: [{ accountId: power, amount: "100000" }, { accountId: rent, amount: "100000" }, { accountId: power, amount: "100000" }],
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const doc = (await call("GET", `/api/vouchers/${v.body.id}`)).body;
    const spentLines = doc.lines.filter((l: any) => l.accountId === power || l.accountId === rent);
    expect(spentLines).toHaveLength(3);
    expect(spentLines.map((l: any) => l.docNativeAmount)).toEqual(["100000.00", "100000.00", "100000.00"]);
    // The cash line keeps its own francs and gets no extra field.
    const cash = doc.lines.find((l: any) => l.accountId === cashCdf);
    expect(cash.docNativeAmount).toBeUndefined();
    expect(Number(cash.nativeAmount)).toBe(-300000);
  });
});
