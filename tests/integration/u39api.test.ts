import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, exchangeRates, locations, parties } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U39: what the Sales list says of a cancelled sale that used the customer's avoir, and the transfer guard's
 * message naming the quantity there. No posting or guard changes.
 */
describe.skipIf(!hasDb)("Thirty-fourth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  const catalog = await import("../../server/services/catalog");
  const ops = await import("../../server/services/operations");
  const salesSvc = await import("../../server/services/sales");
  const NB = " ";
  const userId = 1;
  let db: Db;
  let server: Server;
  let base = "";
  let cookie = "";
  let cashUsd: number, locationId: number, today: string, yesterday: string;
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
  const product = async (name: string, sellPrice: string) =>
    (await db.transaction((tx) => catalog.createProduct(tx, { name, unit: "pcs", variants: [{ attributes: {}, sellPrice }] }))).variants[0].id;
  const opening = (variantId: number, qty: string, date: string) =>
    db.transaction((tx) => ops.adjustStock(tx, { date, locationId, kind: "opening", reason: "Ouverture", lines: [{ variantId, qtyChange: qty, unitCost: "5" }] }, userId));

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    const dt = new Date(`${today}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    yesterday = dt.toISOString().slice(0, 10);
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    const capital = accs.find((a) => a.type === "equity")!.id;
    [{ id: locationId }] = await db.select().from(locations).limit(1);
    await db.insert(exchangeRates).values({ date: yesterday, cdfPerUsd: "2808" });
    await db.transaction((tx) => ops.manualJournal(tx, { date: yesterday, memo: "Ouverture", lines: [{ accountId: cashUsd, debit: "30000" }, { accountId: capital, credit: "30000" }] }, userId));
  });
  afterAll(() => server?.close());

  it("gives the Sales list what a cancelled sale gave back to the avoir, apart from the cash refunded", async () => {
    const pads = await product("Plaquettes U39", "130");
    await opening(pads, "5", yesterday);
    const [{ id: customer }] = await db.insert(parties).values({ type: "customer", name: "Garage U39" }).returning();
    await db.transaction((tx) => ops.receiveFromCustomer(tx, { date: today, partyId: customer, accountId: cashUsd, amount: "110" }, userId));
    // 130 $: 20 $ in cash, the 110 $ left on credit all covered by the avoir.
    const sale = await db.transaction((tx) => salesSvc.createSale(tx, { date: today, locationId, customerId: customer, lines: [{ variantId: pads, qty: "1", unitPrice: "130" }], payments: [{ accountId: cashUsd, amount: "20" }] }, userId));
    const row = async () => (await call<any[]>("GET", `/api/sales?from=${today}&to=${today}`)).body.find((r) => r.id === sale.id);
    expect((await row()).avoirGivenBackUsd).toBe("0.00");
    expect((await call("POST", `/api/sales/${sale.id}/void`, { reason: "Erreur" })).status).toBe(200);
    const voided = await row();
    expect([voided.status, voided.creditUsd, voided.paidKeptUsd, voided.avoirGivenBackUsd, voided.avoirAtSaleUsd]).toEqual(["voided", "110.00", "20.00", "110.00", "0"]);
    // As the sale page reads it.
    expect((await call("GET", `/api/sales/${sale.id}`)).body.avoirGivenBackUsd).toBe("110.00");
    const { voidedParts, voidedSplit } = await import("../../client/src/lib/saleRows");
    expect(voidedParts((_e, f) => f, voidedSplit(voided))).toEqual([`20,00${NB}$ remboursés`, `110,00${NB}$ rendus à l'avoir`]);
  });

  it("names the quantity there when a transfer asks for more", async () => {
    const tyre = await product("Pneu U39", "22");
    await opening(tyre, "261", yesterday);
    const [{ id: depot }] = await db.insert(locations).values({ name: "Dépôt U39" }).returning();
    const res = await call("POST", "/api/stock/transfers", { date: today, fromLocationId: locationId, toLocationId: depot, lines: [{ variantId: tyre, qty: "300" }] });
    expect(res.status).toBe(409);
    expect(res.body.messageFr).toMatch(new RegExp(`^Stock insuffisant de Pneu U39 \\(.+\\) pour le transfert${NB}: 261 disponibles, 300 demandés$`));
    expect(res.body.message).toMatch(/: 261 available, 300 asked$/);
    // The guard itself is unchanged: all 261 move.
    expect((await call("POST", "/api/stock/transfers", { date: today, fromLocationId: locationId, toLocationId: depot, lines: [{ variantId: tyre, qty: "261" }] })).status).toBe(201);
  });
});
