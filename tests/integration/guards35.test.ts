import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A40: what the thirty-fifth accounting audit found after A39: reopening a month took back, of what a
 * container's reversal cleared since, only what ran against that month's revaluation, so a part payment's
 * own exchange difference (N1) or an earlier month's revaluation the other way (N2) came back with it.
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the thirty-fifth audit", async () => {
  const { createApp } = await import("../../server/index");
  const checks = await import("../../server/services/checks");
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const [ty, tm] = today.split("-").map(Number);
  // The two months before this one: m2 (closed first), m1 (the latest closed).
  const m2 = new Date(Date.UTC(ty, tm - 3, 1)).toISOString().slice(0, 7);
  const m1 = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  const m2End = new Date(Date.UTC(ty, tm - 2, 0)).toISOString().slice(0, 10);
  const m1End = new Date(Date.UTC(ty, tm - 1, 0)).toISOString().slice(0, 10);

  /** Fresh books with these rates ([date, CDF, CNY]), an opening of 10 000 $ and 2 800 000 FC, an owner and a manager. */
  async function books(rates: [string, string, string][]) {
    const db = await resetDatabase();
    const app = await createApp();
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    const must = async (method: string, path: string, body?: unknown, who = "admin") => {
      const r = await call(method, path, body, who);
      expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
      return r.body;
    };
    await must("POST", "/api/auth/login", { username: "admin", password: "test-password-123" });
    await must("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" });
    await must("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant");
    const locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    const acc = (k: string) => accs.find((a) => a.systemKey === k)!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of rates) await must("POST", "/api/exchange-rates", { date, cdfPerUsd, cnyPerUsd, confirm: true });
    await must("POST", "/api/journals", {
      date: rates[0][0],
      memo: "Ouverture",
      type: "opening",
      lines: [
        { accountId: acc("cash_usd"), debit: "30000" },
        { accountId: acc("cash_cdf"), debit: "1000", nativeAmount: "2800000", rate: "2800" },
        { accountId: acc("opening_equity"), credit: "31000" },
      ],
    });
    let n = 0;
    const contact = async (name: string) => (await must("POST", "/api/parties", { type: "supplier", name: `${name} ${n++}` })).id as number;
    /** A supplier's balance on payables in one currency: [native, usd]. */
    const owed = async (partyId: number, currency: "USD" | "CNY" | "CDF") => {
      const [r] = await db
        .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
        .from(journalLines)
        .where(and(eq(journalLines.accountId, acc("payables")), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
      return [r.native, r.usd];
    };
    /** A container of `quantity` × `unitPrice` (2 000 ¥ at 0,140845, or 600 000 FC at 0,000357, by default). */
    const container = async (s: number, currency: "CNY" | "CDF", quantity = "2", unitPrice = currency === "CNY" ? "1000" : "300000") => {
      const product = await must("POST", "/api/products", { name: `Pièce ${n++}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
      const box = await must("POST", "/api/containers", { number: `A40-${n++}`, supplierId: s, locationId, currency, rateToUsd: currency === "CNY" ? "0.140845" : "0.000357", status: "arrived" });
      await must("PUT", `/api/containers/${box.id}/lines`, { lines: [{ variantId: product.variants[0].id, quantity, unitPrice }] });
      return box.id as number;
    };
    const offload = (box: number, offloadDate: string) => must("POST", `/api/containers/${box}/finalize`, { offloadDate });
    const reverse = (box: number) => must("POST", `/api/containers/${box}/reverse`, { date: today });
    const pay = (s: number, amount: string, date: string) => must("POST", "/api/money/party-payment", { date, partyId: s, accountId: acc("cash_usd"), amount }, "gerant");
    const refund = (s: number, amount: string, settleNative: string) =>
      call("POST", "/api/vouchers/receipt", { date: today, accountId: acc("cash_usd"), lines: [{ partyId: s, amount, settleNative }] }, "gerant");
    const close = (m: string) => must("POST", `/api/periods/${m}/close`, {});
    const reopen = (m: string) => must("POST", `/api/periods/${m}/reopen`, {});
    const selfOk = async () => {
      const r = await checks.selfCheck(db);
      return r.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${JSON.stringify(c.details ?? "")}`);
    };
    /** Exchange differences booked, the month closes' own journals aside. */
    const fxBooked = async () => {
      const [r] = await db
        .select({ v: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::numeric(20,2)::text` })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .where(and(eq(journalLines.accountId, acc("fx")), ne(journals.type, "period_close")));
      return r.v;
    };
    /** Every account's balance, by code. */
    const trial = async () => {
      const r = await db.execute(sql`select a.code, sum(l.debit - l.credit)::numeric(20,2)::text u from journal_lines l join accounts a on a.id = l.account_id group by 1 having sum(l.debit - l.credit) <> 0 order by 1`);
      return JSON.stringify((r as any).rows ?? r);
    };
    return { db, server, call, acc, contact, owed, container, offload, reverse, pay, refund, close, reopen, selfOk, fxBooked, trial };
  }

  it("N1: reopening keeps a yuan claim at what was paid, and the refund leaves no dollar debt to pay out", async () => {
    // 200 000 ¥ at 7,1, 10 000 $ paid on a 7,0 day, the month ends at 7,25; reversed today at 7,1.
    const results: Record<string, string> = {};
    for (const mode of ["baseline", "reopen"] as const) {
      const h = await books([[`${m1}-01`, "2800", "7.1"], [`${m1}-20`, "2800", "7.0"], [m1End, "2800", "7.25"], [today, "2800", "7.1"]]);
      try {
        const s = await h.contact("Fournisseur N1");
        const box = await h.container(s, "CNY", "200", "1000");
        await h.offload(box, `${m1}-10`);
        await h.pay(s, "10000", `${m1}-22`);
        await h.close(m1);
        await h.reverse(box);
        expect(await h.owed(s, "CNY")).toEqual(["70000.00", "10000.00"]);
        if (mode === "reopen") {
          await h.reopen(m1);
          // The claim is what was paid: the payment's own 140,85 $ stays taken back with the revaluation's.
          expect(await h.owed(s, "CNY")).toEqual(["70000.00", "10000.00"]);
          expect(await h.selfOk()).toEqual([]);
        }
        const r = await h.refund(s, "10000", "70000");
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect([await h.owed(s, "CNY"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
        if (mode === "reopen") {
          await h.close(m1);
          // Closed again: no dollars owed to the supplier, nothing a manager could pay out.
          expect(await h.owed(s, "USD")).toEqual(["0.00", "0.00"]);
          expect(await h.owed(s, "CNY")).toEqual(["0.00", "0.00"]);
        }
        expect(await h.selfOk()).toEqual([]);
        results[mode] = `${await h.trial()} fx ${await h.fxBooked()}`;
      } finally {
        h.server.close();
      }
    }
    // The books after reopening, refunding and closing again are those of the month never reopened.
    expect(results.reopen).toBe(results.baseline);
  });

  it("N1: a part payment at another rate than the month's end, one month reopened then refunded", async () => {
    for (const [payRate, endRate] of [["6.9", "7.3"], ["7.3", "6.9"], ["7.0", "7.25"]] as const) {
      const h = await books([[`${m1}-01`, "2800", "7.1"], [`${m1}-20`, "2800", payRate], [m1End, "2800", endRate], [today, "2800", "7.1"]]);
      try {
        const s = await h.contact("Fournisseur N1b");
        const box = await h.container(s, "CNY");
        await h.offload(box, `${m1}-10`);
        await h.pay(s, "100", `${m1}-22`);
        await h.close(m1);
        await h.reverse(box);
        const claimed = await h.owed(s, "CNY");
        expect(claimed[1], `${payRate}/${endRate}`).toBe("100.00");
        await h.reopen(m1);
        expect(await h.owed(s, "CNY"), `${payRate}/${endRate}`).toEqual(claimed);
        expect(await h.selfOk()).toEqual([]);
        expect((await h.refund(s, "100", claimed[0])).status).toBe(201);
        await h.close(m1);
        expect([await h.owed(s, "CNY"), await h.owed(s, "USD")], `${payRate}/${endRate}`).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
        expect(await h.selfOk()).toEqual([]);
      } finally {
        h.server.close();
      }
    }
  });

  it("N2: two closed months whose revaluations go opposite ways, reopened and closed again over several cycles", async () => {
    for (const [label, m2Cdf, m2Cny, m1Cdf, m1Cny, currency] of [
      ["yuan up then down", "2810", "6.9", "2810", "7.15", "CNY"],
      ["yuan down then up", "2810", "7.3", "2810", "7.05", "CNY"],
      ["yuan small move back", "2810", "6.9", "2810", "7.0", "CNY"],
      ["francs up then down", "2700", "7.1", "2790", "7.1", "CDF"],
      ["francs down then up", "2900", "7.1", "2800", "7.1", "CDF"],
    ] as const) {
      const h = await books([[`${m2}-01`, "2800", "7.1"], [m2End, m2Cdf, m2Cny], [m1End, m1Cdf, m1Cny], [today, "2800", "7.1"]]);
      try {
        const s = await h.contact("Fournisseur N2");
        const s2 = await h.contact("Fournisseur N2 payé");
        const box = await h.container(s, currency);
        const box2 = await h.container(s2, currency);
        await h.offload(box, `${m2}-25`);
        await h.offload(box2, `${m2}-25`);
        await h.pay(s2, "100", `${m1}-10`);
        await h.close(m2);
        await h.close(m1);
        await h.reverse(box);
        await h.reverse(box2);
        const before = [await h.owed(s, currency), await h.owed(s2, currency)];
        expect(before[0], label).toEqual(["0.00", "0.00"]);
        if (currency === "CNY") expect(before[1][1], label).toBe("100.00");
        const fx = await h.fxBooked();
        const trial = await h.trial();
        for (let round = 0; round < 2; round++) {
          await h.reopen(m1);
          // The balance emptied stays at none; the yuan claimed stay at what was paid for them.
          expect(await h.owed(s, currency), `${label} r${round}`).toEqual(["0.00", "0.00"]);
          if (currency === "CNY") expect(await h.owed(s2, currency), `${label} r${round}`).toEqual(before[1]);
          expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
          await h.reopen(m2);
          expect(await h.owed(s, currency), `${label} r${round}`).toEqual(["0.00", "0.00"]);
          if (currency === "CNY") expect(await h.owed(s2, currency), `${label} r${round}`).toEqual(before[1]);
          expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
          await h.close(m2);
          expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
          await h.close(m1);
          // Closed again, the books are as they were.
          expect([await h.owed(s, currency), await h.owed(s2, currency)], `${label} r${round}`).toEqual(before);
          expect(await h.fxBooked(), `${label} r${round}`).toBe(fx);
          expect(await h.trial(), `${label} r${round}`).toBe(trial);
        }
      } finally {
        h.server.close();
      }
    }
  });

  it("N2: the part-paid yuan refunded while both months are reopened leave no dollars owed", async () => {
    const results: Record<string, string> = {};
    for (const mode of ["closed", "reopened"] as const) {
      const h = await books([[`${m2}-01`, "2800", "7.1"], [m2End, "2810", "6.9"], [m1End, "2810", "7.15"], [today, "2800", "7.1"]]);
      try {
        const s2 = await h.contact("Fournisseur N2 remboursé");
        const box2 = await h.container(s2, "CNY");
        await h.offload(box2, `${m2}-25`);
        await h.pay(s2, "100", `${m1}-10`);
        await h.close(m2);
        await h.close(m1);
        await h.reverse(box2);
        if (mode === "reopened") {
          await h.reopen(m1);
          await h.reopen(m2);
        }
        const [native, usd] = await h.owed(s2, "CNY");
        expect(usd, mode).toBe("100.00");
        expect((await h.refund(s2, "100", native)).status).toBe(201);
        if (mode === "reopened") {
          await h.close(m2);
          await h.close(m1);
        }
        expect([await h.owed(s2, "CNY"), await h.owed(s2, "USD")], mode).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
        expect(await h.selfOk()).toEqual([]);
        results[mode] = `${await h.trial()} fx ${await h.fxBooked()}`;
      } finally {
        h.server.close();
      }
    }
    expect(results.reopened).toBe(results.closed);
  });

  it("N2: two bills of one supplier, one reversed, then the other after the months were reopened and closed again", async () => {
    const h = await books([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-15`, "2800", "7.0"], [m1End, "2790", "7.15"], [today, "2800", "7.1"]]);
    try {
      const s = await h.contact("Fournisseur deux conteneurs");
      const b1 = await h.container(s, "CNY");
      const b2 = await h.container(s, "CNY", "3");
      await h.offload(b1, `${m2}-25`);
      await h.offload(b2, `${m2}-26`);
      await h.pay(s, "300", `${m1}-15`);
      await h.close(m2);
      await h.close(m1);
      await h.reverse(b1);
      const left = await h.owed(s, "CNY");
      const fx = await h.fxBooked();
      await h.reopen(m1);
      // The 900 ¥ still owed keep the earlier month's revaluation only: 900 × 0,140845 + 900/2 900 × 20,41.
      expect(await h.owed(s, "CNY")).toEqual(["-900.00", "-133.09"]);
      await h.reopen(m2);
      expect(await h.owed(s, "CNY")).toEqual(["-900.00", "-126.76"]);
      expect(await h.selfOk()).toEqual([]);
      await h.close(m2);
      await h.close(m1);
      expect(await h.owed(s, "CNY")).toEqual(left);
      expect(await h.fxBooked()).toBe(fx);
      // The other container reversed: the 2 100 ¥ paid are claimed at the 300 $ paid, reopened or not.
      await h.reverse(b2);
      expect(await h.owed(s, "CNY")).toEqual(["2100.00", "300.00"]);
      await h.reopen(m1);
      expect(await h.owed(s, "CNY")).toEqual(["2100.00", "300.00"]);
      expect(await h.selfOk()).toEqual([]);
      expect((await h.refund(s, "300", "2100")).status).toBe(201);
      await h.close(m1);
      expect([await h.owed(s, "CNY"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
      expect(await h.selfOk()).toEqual([]);
    } finally {
      h.server.close();
    }
  });

  it("A balance settled in full after the close leaves no dollars on it when the month is reopened", async () => {
    const h = await books([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-15`, "2800", "7.0"], [today, "2800", "7.1"]]);
    try {
      const s = await h.contact("Fournisseur réglé");
      const box = await h.container(s, "CDF", "1", "100000");
      await h.offload(box, `${m2}-25`);
      await h.close(m2);
      // 100 000 FC paid from the franc drawer after the close: the payment takes the revalued cost.
      const p = await h.call("POST", "/api/money/party-payment", { date: `${m1}-15`, partyId: s, accountId: h.acc("cash_cdf"), amount: "100000" }, "gerant");
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      const trial = await h.trial();
      await h.reopen(m2);
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      expect(await h.selfOk()).toEqual([]);
      await h.close(m2);
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      expect(await h.trial()).toBe(trial);
    } finally {
      h.server.close();
    }
  });
});
