import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A44: what the thirty-ninth accounting audit found after A43. A payment that emptied a supplier's
 * francs or yuan, posted before a late close and undone, lost the month's revaluation (N1); a part paid took
 * its share of the revaluation by the yuan or francs owed at the month's end, oldest bill first, while the
 * books take them out at their average cost, and a part paid with the month closed left its share on the
 * reopened state, so the closed state still depended on the order (N3); the franc true-up was skipped when
 * the pool and the books agreed on the francs but not on the dollars (N2); closing a month locked a contact
 * after the revaluation had credited a drawer (N4).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the thirty-ninth audit", async () => {
  const { createApp } = await import("../../server/index");
  const checks = await import("../../server/services/checks");
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const [ty, tm] = today.split("-").map(Number);
  // The three months before this one: m3 (closed first), m2, m1 (the latest closed).
  const month = (back: number) => new Date(Date.UTC(ty, tm - 1 - back, 1)).toISOString().slice(0, 7);
  const end = (back: number) => new Date(Date.UTC(ty, tm - back, 0)).toISOString().slice(0, 10);
  const [m3, m2, m1] = [month(3), month(2), month(1)];
  const [m3End, m2End, m1End] = [end(3), end(2), end(1)];

  /** Fresh books with these rates ([date, CDF, CNY]), an opening of 100 000 $ and 102 800 000 FC, an owner and a manager. */
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
        { accountId: acc("cash_usd"), debit: "100000" },
        { accountId: acc("cash_cdf"), debit: "36714.29", nativeAmount: "102800000", rate: "2800" },
        { accountId: acc("opening_equity"), credit: "136714.29" },
      ],
    });
    let n = 0;
    const contact = async (name: string, type = "supplier") => (await must("POST", "/api/parties", { type, name: `${name} ${n++}` })).id as number;
    /** A balance on `accountId` (a contact's, or an account's own) in one currency: [native, usd]. */
    const balance = async (accountId: number, partyId: number | null, currency: "USD" | "CNY" | "CDF") => {
      const [r] = await db
        .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
        .from(journalLines)
        .where(and(eq(journalLines.accountId, accountId), partyId ? eq(journalLines.partyId, partyId) : sql`${journalLines.partyId} is null`, eq(journalLines.currency, currency)));
      return [r.native, r.usd];
    };
    const owed = (partyId: number, currency: "USD" | "CNY" | "CDF") => balance(acc("payables"), partyId, currency);
    /** A container of `quantity` × `unitPrice` (2 000 ¥ at 0,140845, or 600 000 FC at 0,000357, by default). */
    const container = async (s: number, currency: "CNY" | "CDF", quantity = "2", unitPrice = currency === "CNY" ? "1000" : "300000", rateToUsd = currency === "CNY" ? "0.140845" : "0.000357") => {
      const product = await must("POST", "/api/products", { name: `Pièce ${n++}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
      const box = await must("POST", "/api/containers", { number: `A44-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
      await must("PUT", `/api/containers/${box.id}/lines`, { lines: [{ variantId: product.variants[0].id, quantity, unitPrice }] });
      return box.id as number;
    };
    const offload = (box: number, offloadDate: string) => must("POST", `/api/containers/${box}/finalize`, { offloadDate });
    const reverseOn = (box: number, date: string) => must("POST", `/api/containers/${box}/reverse`, { date });
    const pay = (s: number, amount: string, date: string, accountId = acc("cash_usd"), who = "gerant") => must("POST", "/api/money/party-payment", { date, partyId: s, accountId, amount }, who);
    const undo = (journalId: number, date = today) => call("POST", `/api/journals/${journalId}/reverse`, { date });
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
    /** The lines of a kind on a contact: [journal type, usd]. */
    const kindLines = async (partyId: number, kind: "cost_fx" | "residue" | "revalued" | "settled_fx") => {
      const rows = await db
        .select({ type: journals.type, usd: sql<string>`(${journalLines.debit} - ${journalLines.credit})::numeric(20,2)::text` })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .where(and(eq(journalLines.partyId, partyId), eq(journalLines.kind, kind)))
        .orderBy(journals.id);
      return rows.map((r) => [r.type, r.usd]);
    };
    /** Every balance, by account, contact and currency. */
    const trial = async () => {
      const r = await db.execute(
        sql`select account_id, coalesce(party_id, 0) p, currency, sum(coalesce(native_amount, 0))::numeric(20,2)::text n, sum(debit - credit)::numeric(20,2)::text u from journal_lines group by 1, 2, 3 having sum(debit - credit) <> 0 or sum(coalesce(native_amount, 0)) <> 0 order by 1, 2, 3`,
      );
      return JSON.stringify((r as any).rows ?? r);
    };
    return { db, server, call, must, acc, contact, balance, owed, container, offload, reverseOn, pay, undo, close, reopen, selfOk, fxBooked, kindLines, trial };
  }
  type Books = Awaited<ReturnType<typeof books>>;
  const withBooks = async (rates: [string, string, string][], f: (h: Books) => Promise<void>) => {
    const h = await books(rates);
    try {
      await f(h);
    } finally {
      h.server.close();
    }
  };
  const cents = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

  // The loss case of the audit's probes: the month's end at 2 700 FC (6,9 ¥), the francs and yuan dearer since.
  const lossRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2740", "7.0"], [`${m1}-13`, "2760", "7.0"], [`${m1}-20`, "2780", "7.05"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];
  /** Close (C) and reopen (R) the month around the postings, in this order. */
  const plans = { early: ["C", 0, 1], between: [0, "C", 1], late: [0, 1, "C"], reopened: ["C", "R", 0, 1, "C"], cycled: ["C", 0, "R", 1, "C"] } as const;

  it("N1: a payment that empties the bill, posted before a late close and undone, leaves the month's revaluation on it, as closed first", async () => {
    for (const variant of ["francs", "dollars", "yuan"] as const) {
      const currency = variant === "yuan" ? "CNY" : "CDF";
      for (const [mode, plan] of Object.entries(plans)) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur N1 ${variant} ${mode}`);
          const box = currency === "CNY" ? await h.container(s, "CNY", "10", "2000") : await h.container(s, "CDF", "10", "1000000");
          await h.offload(box, `${m2}-04`);
          let paid: { id: number } | null = null;
          for (const step of plan) {
            if (step === "C") await h.close(m2);
            else if (step === "R") await h.reopen(m2);
            else if (step === 0) paid = variant === "francs" ? await h.pay(s, "10000000", `${m1}-13`, h.acc("cash_cdf")) : await h.pay(s, variant === "yuan" ? "2857.14" : "3623.19", `${m1}-13`);
            else expect((await h.undo(paid!.id, `${m1}-20`)).status, `${variant} ${mode}`).toBe(200);
          }
          // Owed again, at the month-end rate: 10 000 000 FC at 2 700, or 20 000 ¥ at 6,9.
          expect(await h.owed(s, currency), `${variant} ${mode}`).toEqual(currency === "CDF" ? ["-10000000.00", "-3703.70"] : ["-20000.00", "-2898.55"]);
          expect(await h.selfOk(), `${variant} ${mode}`).toEqual([]);
          const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
          await h.reopen(m2);
          expect(await h.owed(s, currency), `${variant} ${mode} reopened`).toEqual(currency === "CDF" ? ["-10000000.00", "-3570.00"] : ["-20000.00", "-2816.90"]);
          await h.close(m2);
          expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${variant} ${mode} closed again`).toBe(closed);
          // The manager pays the dollars shown: nothing left owed, and the advance is only the rate's move since.
          await h.pay(s, currency === "CDF" ? "3703.70" : "2898.55", `${m1}-26`);
          expect(await h.owed(s, currency), `${variant} ${mode}`).toEqual(["0.00", "0.00"]);
          expect(await h.owed(s, "USD"), `${variant} ${mode}`).toEqual(["0.00", currency === "CDF" ? "67.34" : "41.41"]);
        });
      }
    }
  }, 600_000);

  it("N1: so does one whose undoing comes after a bill's reversal left a claim, but not once a bill since is owed in its place", async () => {
    const steps = { early: ["C", 0, 1, 2], between: [0, "C", 1, 2], late: [0, 1, 2, "C"] } as const;
    for (const [mode, plan] of Object.entries(steps)) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Fournisseur N1b ${mode}`);
        const big = await h.container(s, "CDF", "10", "1000000");
        await h.offload(big, `${m2}-04`);
        const small = await h.container(s, "CDF", "1", "1000000");
        await h.offload(small, `${m2}-05`);
        let paid: { id: number } | null = null;
        for (const step of plan) {
          if (step === "C") await h.close(m2);
          else if (step === 0) paid = await h.pay(s, "11000000", `${m1}-13`, h.acc("cash_cdf"));
          else if (step === 1) await h.reverseOn(small, `${m1}-15`);
          else expect((await h.undo(paid!.id, `${m1}-20`)).status, mode).toBe(200);
        }
        expect(await h.owed(s, "CDF"), mode).toEqual(["-10000000.00", "-3703.70"]);
        expect(await h.selfOk(), mode).toEqual([]);
      });
    }
    // Emptied, then a bill since owed before the undoing: the month's revaluation stays as it was then, and
    // reopened none of it is left on the francs.
    for (const mode of ["early", "late"] as const) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Fournisseur N1c ${mode}`);
        const box = await h.container(s, "CDF", "10", "1000000");
        await h.offload(box, `${m2}-04`);
        if (mode === "early") await h.close(m2);
        const paid = await h.pay(s, "10000000", `${m1}-13`, h.acc("cash_cdf"));
        const since = await h.container(s, "CDF", "1", "1000000", "0.000362");
        await h.offload(since, `${m1}-15`);
        expect((await h.undo(paid.id, `${m1}-20`)).status, mode).toBe(200);
        await h.reverseOn(box, `${m1}-22`);
        if (mode === "late") await h.close(m2);
        const closed = await h.owed(s, "CDF");
        expect(await h.selfOk(), mode).toEqual([]);
        await h.reopen(m2);
        // What is owed is the bill since, at its own cost.
        expect(await h.owed(s, "CDF"), `${mode} reopened`).toEqual(["-1000000.00", "-362.00"]);
        await h.close(m2);
        expect(await h.owed(s, "CDF"), `${mode} closed again`).toEqual(closed);
      });
    }
  }, 600_000);

  it("N3: a part paid takes its share of the revaluation at the books' average cost, a bill since among the francs: closing first, last or around the payments books the same", async () => {
    const results: Record<string, string> = {};
    for (const mode of ["early", "after the first", "late", "reopened between"] as const) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Fournisseur N3 ${mode}`);
        await h.offload(await h.container(s, "CDF", "3", "1000000"), `${m2}-04`);
        await h.offload(await h.container(s, "CDF", "5", "1000000"), `${m2}-10`);
        if (mode === "early" || mode === "reopened between") await h.close(m2);
        await h.pay(s, "500", `${m1}-05`);
        if (mode === "after the first") await h.close(m2);
        if (mode === "reopened between") await h.reopen(m2);
        // A bill since, owed with the month's: the payments after it take the francs out at their average cost.
        await h.offload(await h.container(s, "CDF", "2", "1000000"), `${m1}-08`);
        await h.pay(s, "1500", `${m1}-20`);
        await h.pay(s, "300", `${m1}-25`);
        if (mode === "late" || mode === "reopened between") await h.close(m2);
        const [native, usd] = await h.owed(s, "CDF");
        expect(native, mode).toBe("-3626000.00");
        // −1 331,73 closed first (a cent of rounding apart: each part's share is rounded to the cent).
        expect(Math.abs(Number(usd) + 1331.73), `${mode} ${usd}`).toBeLessThanOrEqual(0.011);
        expect(await h.selfOk(), mode).toEqual([]);
        const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
        await h.reopen(m2);
        await h.close(m2);
        expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${mode} closed again`).toBe(closed);
        results[mode] = usd;
      });
    }
    // Before, closing last left −1 316,22: the payments' shares by the francs owed at the month's end alone.
    expect(Object.values(results).every((u) => Math.abs(Number(u) - Number(results.early)) <= 0.011), JSON.stringify(results)).toBe(true);
  }, 300_000);

  it("N3: a part paid with the month closed takes its share back once the month is reopened, so a part paid then books as closed first", async () => {
    for (const currency of ["CDF", "CNY"] as const) {
      const results: Record<string, string> = {};
      for (const [mode, plan] of Object.entries(plans)) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur N3 ${currency} ${mode}`);
          const box = currency === "CNY" ? await h.container(s, "CNY", "10", "2000") : await h.container(s, "CDF", "10", "1000000");
          await h.offload(box, `${m2}-04`);
          for (const step of plan) {
            if (step === "C") await h.close(m2);
            else if (step === "R") await h.reopen(m2);
            else await h.pay(s, "1000", step === 0 ? `${m1}-13` : `${m1}-20`);
          }
          const [native, usd] = await h.owed(s, currency);
          expect(native, `${currency} ${mode}`).toBe(currency === "CDF" ? "-4460000.00" : "-5950.00");
          expect(await h.selfOk(), `${currency} ${mode}`).toEqual([]);
          if (mode === "cycled") {
            // Reopened after the first part, that part's share is taken back: the francs or yuan left hold none of the revaluation.
            await h.reopen(m2);
            const [, open] = await h.owed(s, currency);
            expect(Number(open), `${currency} reopened`).toBeCloseTo(currency === "CDF" ? -4460000 * 0.000357 : -5950 * 0.140845, 1);
            await h.close(m2);
          }
          results[mode] = usd;
        });
      }
      // Before, closed, reopened after the first part and closed again after the second: 14,07 $ apart (CDF).
      expect(Object.values(results).every((u) => Math.abs(Number(u) - Number(results.early)) <= 0.011), `${currency} ${JSON.stringify(results)}`).toBe(true);
    }
  }, 300_000);

  it("N2: the franc true-up books the exact difference whenever the pool and the books hold the same francs", async () => {
    // Two bills, a dollar part payment, the small bill reversed, the month closed, then the big bill reversed.
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m2}-10`, "2796", "7.1"], [`${m2}-21`, "2804", "7.1"], [m2End, "2702", "6.85"], [`${m1}-04`, "2698", "6.85"], [`${m1}-07`, "2705", "6.86"], [`${m1}-10`, "2710", "6.87"], [today, "2752", "6.98"]], async (h) => {
      const s = await h.contact("Fournisseur N2 tard");
      const a = await h.container(s, "CDF", "1", "6172500", (1 / 2796).toFixed(8));
      const b = await h.container(s, "CDF", "1", "1000000", (1 / 2804).toFixed(8));
      await h.offload(a, `${m2}-10`);
      await h.offload(b, `${m2}-21`);
      await h.pay(s, "250", `${m1}-04`);
      await h.reverseOn(b, `${m1}-07`);
      await h.close(m2);
      await h.reverseOn(a, `${m1}-10`);
      // The francs paid are claimed back at the 250 $ paid for them (171,93 $ before).
      expect(await h.owed(s, "CDF")).toEqual(["674500.00", "250.00"]);
      expect(await h.selfOk()).toEqual([]);
      const r = await h.call("POST", "/api/vouchers/receipt", { date: `${m1}-10`, accountId: h.acc("cash_usd"), lines: [{ partyId: s, amount: "250.00" }] }, "gerant");
      expect(r.status).toBe(201);
      // The francs cleared, as with the month closed first: 250 $ at the day's 2 710 are 3 000 FC more than
      // the claim, which the shop owes back (1,11 $).
      expect([await h.owed(s, "CDF"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "-1.11"]]);
      expect(await h.selfOk()).toEqual([]);
    });
    // A franc deposit undone, then a franc bill dated between the two, reversed: no dollars left on no francs.
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m2}-25`, "2699", "6.9"], [`${m2}-30`, "2716", "7.0"], [m2End, "2750", "7.0"], [`${m1}-11`, "2780", "7.0"], [`${m1}-23`, "2800", "7.05"], [today, "2760", "7.0"]], async (h) => {
      const s = await h.contact("Fournisseur N2 acompte");
      const dep = await h.pay(s, "250000", `${m2}-25`, h.acc("cash_cdf"), "admin");
      expect((await h.undo(dep.id, `${m1}-11`)).status).toBe(200);
      const box = await h.container(s, "CDF", "1", "300013", "0.00036819");
      await h.offload(box, `${m2}-30`);
      await h.reverseOn(box, `${m1}-23`);
      expect([await h.owed(s, "CDF"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
      expect(await h.selfOk()).toEqual([]);
    });
  }, 120_000);

  it("N4: closing a month whose revaluation credits a drawer takes every restated contact's lock before it (HK_LOCK_ORDER=strict)", async () => {
    // Francs dearer at the month's end: the franc drawer loses, the francs owed gain.
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m2}-25`, "3000", "7.1"], [m2End, "2900", "7.1"], [`${m1}-05`, "2850", "7.1"], [today, "2850", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur N4");
      await h.offload(await h.container(s, "CDF", "2", "300000"), `${m2}-10`);
      await h.close(m2);
      // Half paid with the month closed: reopened, its share of the revaluation is taken back after the month's end.
      await h.pay(s, "300000", `${m1}-05`, h.acc("cash_cdf"));
      await h.reopen(m2);
      // Francs the supplier gave back, dated in the month at 3 000, leave the francs owed at its end at the
      // month-end rate to the cent (1 235 400 FC at 2 900 = 426,00 $): the revaluation restates them no more,
      // while the month's journals since moved them.
      const r = await h.call("POST", "/api/vouchers/receipt", { date: `${m2}-25`, accountId: h.acc("cash_cdf"), lines: [{ partyId: s, amount: "635400" }] }, "gerant");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await h.balance(h.acc("payables"), s, "CDF"), JSON.stringify(await h.balance(h.acc("payables"), s, "USD"))).toEqual(["-935400.00", expect.any(String)]);
      const was = process.env.HK_LOCK_ORDER;
      process.env.HK_LOCK_ORDER = "strict";
      try {
        const closed = await h.call("POST", `/api/periods/${m2}/close`, {});
        expect(closed.status, JSON.stringify(closed.body)).toBe(200);
        const reopened = await h.call("POST", `/api/periods/${m2}/reopen`, {});
        expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
        const again = await h.call("POST", `/api/periods/${m2}/close`, {});
        expect(again.status, JSON.stringify(again.body)).toBe(200);
      } finally {
        if (was === undefined) delete process.env.HK_LOCK_ORDER;
        else process.env.HK_LOCK_ORDER = was;
      }
      expect(await h.selfOk()).toEqual([]);
    });
  }, 120_000);
});
