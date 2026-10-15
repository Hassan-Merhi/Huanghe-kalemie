import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, exchangeRates, parties, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A17: the two minor items the twelfth accounting audit left open. */
describe.skipIf(!hasDb)("Guards found by the twelfth audit", async () => {
  const { createApp } = await import("../../server/index");
  const ops = await import("../../server/services/operations");
  const payroll = await import("../../server/services/payroll");
  const vouchers = await import("../../server/services/vouchers");
  let db: Db;
  let server: Server;
  let base = "";
  let ownerId: number, cashUsd: number;

  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  }

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    [{ id: ownerId }] = await db.select().from(users).where(eq(users.role, "owner"));
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    await db.insert(exchangeRates).values([{ date: "2026-08-01", cdfPerUsd: "2800", cnyPerUsd: "7" }]);
    await db.transaction((tx) =>
      ops.manualJournal(tx, { date: "2026-08-01", memo: "Ouverture", type: "opening", lines: [{ accountId: cashUsd, debit: "20000" }, { accountId: accs.find((a) => a.systemKey === "opening_equity")!.id, credit: "20000" }] }, ownerId),
    );
  });
  afterAll(() => server?.close());

  it("hides an expense's note from a partner when the voucher also moves the other partner", async () => {
    const owner = client();
    expect((await owner("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    const ps = (await owner("GET", "/api/partners")).body;
    await owner("POST", "/api/users", { username: "assoca", fullName: "Associé A", role: "partner", partnerId: ps[0].id, password: "partner-pass" });
    const rent = (await db.select().from(accounts).where(eq(accounts.type, "expense")))[0].id;
    const posted = await owner("POST", "/api/vouchers/payment", { date: "2026-08-02", accountId: cashUsd, lines: [{ accountId: rent, amount: "5", memo: "SECRET loyer maison" }, { accountId: ps[1].currentAccountId, amount: "3" }] });
    expect(posted.status).toBe(201);
    const partner = client();
    expect((await partner("POST", "/api/auth/login", { username: "assoca", password: "partner-pass" })).status).toBe(200);
    const seen = await partner("GET", "/api/expenses");
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toContain("SECRET");
    expect(JSON.stringify((await owner("GET", "/api/expenses")).body)).toContain("SECRET");
  });

  it("refuses cancelling a payroll run whose withholdings were already paid over", async () => {
    const [{ id: e }] = await db.insert(parties).values({ type: "employee", name: "Furaha", monthlySalary: "300" }).returning();
    const accountId = (await db.transaction((tx) => payroll.salaryAccountId(tx)))!;
    await db.transaction((tx) => payroll.runPayroll(tx, { month: "2026-08", date: "2026-08-05", accountId, currency: "USD", lines: [{ partyId: e, salary: "300", withheld: "50" }] }, ownerId));
    const [{ id: liab }] = await db.select().from(accounts).where(eq(accounts.systemKey, "payroll_withheld"));
    await db.transaction((tx) => vouchers.postVoucher(tx, "payment", { date: "2026-08-06", accountId: cashUsd, lines: [{ accountId: liab, amount: "50" }] }, ownerId, { owner: true }));
    await expect(db.transaction((tx) => payroll.cancelRun(tx, "2026-08", null, ownerId))).rejects.toThrow(/already paid/);
  });
});
