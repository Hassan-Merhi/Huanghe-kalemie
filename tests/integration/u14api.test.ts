import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

const NB = "\u00a0";

/** U14: the owner's yuan rate survives a manager's franc save; packing-list measures read as typed. */
describe.skipIf(!hasDb)("Ninth UI audit", async () => {
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
  let locationId: number, supplierId: number;

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    supplierId = (await call("POST", "/api/parties", { type: "supplier", name: "Huanghe Group" })).body.id;
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
  });

  afterAll(() => {
    server?.close();
  });

  it("still refuses a manager's first-ever yuan rate, and saves a first franc rate", async () => {
    // No rate on file before today: the manager's franc rate is compared with the default rate.
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808" }, "gerant")).status).toBe(200);
    const first = await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.1" }, "gerant");
    expect(first.status).toBe(403);
    expect(first.body.messageFr).toBe("Seul le propriétaire peut saisir le premier taux du yuan");
  });

  it("keeps the owner's yuan rate as the reference after a manager saves the franc rate", async () => {
    // The first yuan rate ever, set by the owner today.
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2808", cnyPerUsd: "7.1" })).status).toBeLessThan(300);
    // The manager moves the franc rate (within 5 %), sending the yuan rate as the dashboard does.
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2900", cnyPerUsd: "7.1" }, "gerant")).status).toBe(200);
    // A small yuan step is compared with the owner's 7,1 ¥, not refused as "the first yuan rate".
    const near = await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2900", cnyPerUsd: "7.12" }, "gerant");
    expect(near.status, JSON.stringify(near.body)).toBe(200);
    expect((await call("GET", `/api/exchange-rates/for/${today}`)).body.cnyPerUsd).toBe("7.12");
    // The walk stays limited: the manager's own 7,12 ¥ is not a reference, so 7,45 ¥ (4,9 % from 7,1) passes
    // and 7,6 ¥ (7 % from 7,1, though under 5 % from 7,45) does not.
    expect((await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2900", cnyPerUsd: "7.45" }, "gerant")).status).toBe(200);
    const far = await call("POST", "/api/exchange-rates", { date: today, cdfPerUsd: "2900", cnyPerUsd: "7.6" }, "gerant");
    expect(far.status).toBe(403);
    expect(far.body.messageFr).toBe(`7,6${NB}¥ pour 1${NB}$ s'écarte de plus de 5${NB}% du dernier taux du yuan (7,1${NB}¥). Seul le propriétaire peut faire ce changement.`);
  });

  it("stores a packing list's litres, kilos and cubic metres as the browser read them", async () => {
    const c = await call("POST", "/api/containers", { number: "HHU-14", supplierId, locationId, currency: "USD" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    // "2,250" L, "12,375" kg, "0,856" m³ in the file, sent as the plain numbers the browser read.
    const res = await call("POST", `/api/containers/${c.body.id}/import-lines`, {
      mode: "append",
      rows: [{ name: "Huile moteur 4T 1 L", unit: "litre", quantity: "2.25", unitPrice: "18.5", weightKg: "12.375", volumeCbm: "0.856" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const line = res.body.container.lines[0];
    expect([line.quantity, line.weightKg, line.volumeCbm].map(Number)).toEqual([2.25, 12.375, 0.856]);
    // The preview names the unit of an item that exists, so the browser knows how to read its quantity.
    const preview = await call<any[]>("POST", "/api/import/items/preview", { rows: [{ name: "Huile moteur 4T 1 L" }] });
    expect(preview.body[0]).toMatchObject({ status: "existing", unit: "litre" });
    // "1.000" sent as it is (1 000 or 1?) is refused, never guessed.
    const unsure = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Huile moteur 4T 1 L", quantity: "2", unitPrice: "18.5", weightKg: "1.000" }] });
    expect(unsure.status).toBe(422);
    expect(unsure.body.messageFr).toBe(`«${NB}1.000${NB}»${NB}: 1${NB}000 ou 1${NB}? Écrivez-le sans le point.`);
    // Pieces still come in whole: "2.5" tyres is refused, as before.
    const split = await call("POST", `/api/containers/${c.body.id}/import-lines`, { mode: "append", rows: [{ name: "Pneu 2.75-17", unit: "pcs", quantity: "2.5", unitPrice: "10" }] });
    expect(split.status).toBe(400);
  });
});
