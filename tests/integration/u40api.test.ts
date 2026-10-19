import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { exchangeRates } from "@shared/schema";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/**
 * U40: a manager's change to a day's rate is also held to the rate already set for that day (a tightened
 * guard). No posting changes.
 */
describe.skipIf(!hasDb)("Thirty-fifth UI audit", async () => {
  const { createApp } = await import("../../server/index");
  let db: Db;
  let server: Server;
  let base = "";
  const jar: Record<string, string> = {};
  let today: string;
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

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    today = (await call("GET", "/api/settings")).body.today;
    const dt = new Date(`${today}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    await db.insert(exchangeRates).values({ date: dt.toISOString().slice(0, 10), cdfPerUsd: "2812" });
  });
  afterAll(() => server?.close());

  it("holds a manager's change of today's rate to the rate already set today, not only to yesterday's", async () => {
    const save = (cdfPerUsd: string, who = "gerant") => call("POST", "/api/exchange-rates", { date: today, cdfPerUsd }, who);
    expect((await save("2808")).status).toBe(200);
    // 2 950 is 4,9 % from yesterday's 2 812 but 5,06 % from today's 2 808.
    const far = await save("2950");
    expect(far.status).toBe(403);
    expect(far.body.message).toMatch(/rate already set/);
    expect(far.body.messageFr).toBe("2 950 FC pour 1 $ s'écarte de plus de 5 % du taux déjà saisi pour ce jour (2 808 FC). Seul le propriétaire peut faire ce changement.");
    // Within 5 % of both, and saving the day's rate as it is, still go through; the owner may make any change.
    expect((await save("2940")).status).toBe(200);
    expect((await save("2940")).status).toBe(200);
    expect((await save("3200", "admin")).status).toBe(200);
    // The owner's 3 200 is the day's reference now: a manager may correct it a little, not walk it back at once.
    expect((await save("3150")).status).toBe(200);
    expect((await save("2900")).status).toBe(403);
  });
});
