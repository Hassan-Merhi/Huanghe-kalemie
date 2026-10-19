import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, sales } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U46: a till still showing a customer's avoir another sale used up (or no avoir where a payment made one) is
 * refused rather than booked otherwise than it said (a tightened guard). No posting changes.
 */
describe.skipIf(!hasDb)("Forty-first UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const NB = "\u00a0";
  let db: Db;
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
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  let cashUsd: number, locationId: number, tyre: number, neema: number;
  const saleCount = async () => (await db.select({ id: sales.id }).from(sales)).length;
  const balanceOf = async (id: number) => (await call<any[]>("GET", "/api/parties")).body.find((p) => p.id === id).balance as string;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Caissière", role: "cashier", password: "cashier-pass" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "cashier-pass" }, "caisse")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    const p = await call("POST", "/api/products", { name: "Pneu U46", unit: "pcs", variants: [{ attributes: {}, sellPrice: "25" }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    tyre = p.body.variants[0].id;
    expect((await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId: tyre, qtyChange: "100", unitCost: "12" }] })).status).toBe(201);
    neema = (await call("POST", "/api/parties", { type: "customer", name: "Neema" })).body.id;
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" })).status).toBeLessThan(300);
  });
  afterAll(() => server?.close());

  const sale = (qty: string, tillBalance?: string, payments: unknown[] = []) => ({
    locationId,
    customerId: neema,
    lines: [{ variantId: tyre, qty, unitPrice: "25" }],
    payments,
    ...(tillBalance !== undefined ? { tillBalance } : {}),
  });

  it("refuses a sale on an avoir another sale used up meanwhile, and saves it once the till shows the balance now", async () => {
    // Neema pays 50 $ ahead: an avoir of 50 $.
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: neema, accountId: cashUsd, amount: "50" })).status).toBe(201);
    expect(await balanceOf(neema)).toBe("-50.00");
    // The manager's sale uses the 50 $ up while the cashier's till still shows it.
    expect((await call("POST", "/api/sales", sale("2", "-50.00"))).status).toBe(201);
    const before = await saleCount();
    const stale = await call("POST", "/api/sales", sale("1", "-50.00"), "caisse");
    expect(stale.status).toBe(409);
    expect(stale.body.messageFr).toBe(`Le solde de Neema a changé${NB}: vérifiez le paiement`);
    expect(stale.body.message).toBe("Neema's balance has changed: check the payment");
    expect(await saleCount()).toBe(before);
    // Read again, the till says "à crédit": the same sale goes through as such.
    const fresh = await call("POST", "/api/sales", sale("1", await balanceOf(neema)), "caisse");
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(Number(fresh.body.creditUsd)).toBe(25);
    expect(await balanceOf(neema)).toBe("25.00");
  });

  it("refuses a credit sale the till shows as owed when a payment since made an avoir that covers it", async () => {
    const shown = await balanceOf(neema);
    // The owner records 100 $: Neema now holds 75 $ the till does not show.
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: neema, accountId: cashUsd, amount: "100" })).status).toBe(201);
    const stale = await call("POST", "/api/sales", sale("1", shown), "caisse");
    expect(stale.status).toBe(409);
    expect(stale.body.messageFr).toBe(`Le solde de Neema a changé${NB}: vérifiez le paiement`);
    expect((await call("POST", "/api/sales", sale("1", await balanceOf(neema)), "caisse")).status).toBe(201);
  });

  it("checks only what changes how the sale settles, and nothing for a till that sends no balance", async () => {
    // Owes 10 $ more or less than the till showed: the sale is on credit either way.
    expect(await balanceOf(neema)).toBe("-50.00");
    expect((await call("POST", "/api/sales", sale("2", "-50.00"))).status).toBe(201);
    expect(await balanceOf(neema)).toBe("0.00");
    const debt = await call("POST", "/api/sales", sale("1", "-0.00"), "caisse");
    expect(debt.status, JSON.stringify(debt.body)).toBe(201);
    expect((await call("POST", "/api/sales", sale("1", "10.00"), "caisse")).status).toBe(201);
    // Paid in full, the balance does not matter.
    expect((await call("POST", "/api/sales", sale("1", "-500.00", [{ accountId: cashUsd, amount: "25" }]), "caisse")).status).toBe(201);
    // An avoir bigger than the credit both times covers it all the same: 200 $ held, 150 $ shown, 25 $ on credit.
    expect((await call("POST", "/api/money/customer-receipt", { date: today, partyId: neema, accountId: cashUsd, amount: "250" })).status).toBe(201);
    expect(await balanceOf(neema)).toBe("-200.00");
    expect((await call("POST", "/api/sales", sale("1", "-150.00"), "caisse")).status).toBe(201);
    // An older till, or an API caller, sends nothing: the sale is booked as before.
    expect((await call("POST", "/api/sales", sale("1"), "caisse")).status).toBe(201);
    expect((await call("POST", "/api/sales", sale("1", ""), "caisse")).status).toBe(201);
    // Not a number: refused as any other bad field.
    expect((await call("POST", "/api/sales", sale("1", "beaucoup"), "caisse")).status).toBe(400);
  });
});
