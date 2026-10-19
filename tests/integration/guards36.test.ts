import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A41: what the thirty-sixth accounting audit found after A40. Reopening a month took back what was
 * settled since of its revaluation one sequence at a time, and the yuan replay, the reversal's clearing and
 * the close each saw it their own way: a claim left above what was paid (F1), a balance at no yuan or francs
 * left holding dollars once a settling payment was undone (F2, F3), francs paid dated before their bill
 * (F4), and a month reopened and closed again booking differently (F5).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the thirty-sixth audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A41-${n++}`, supplierId: s, locationId, currency, rateToUsd: currency === "CNY" ? "0.140845" : "0.000357", status: "arrived" });
      await must("PUT", `/api/containers/${box.id}/lines`, { lines: [{ variantId: product.variants[0].id, quantity, unitPrice }] });
      return box.id as number;
    };
    const offload = (box: number, offloadDate: string) => must("POST", `/api/containers/${box}/finalize`, { offloadDate });
    const reverse = (box: number) => must("POST", `/api/containers/${box}/reverse`, { date: today });
    const pay = (s: number, amount: string, date: string, accountId = acc("cash_usd"), who = "gerant") => must("POST", "/api/money/party-payment", { date, partyId: s, accountId, amount }, who);
    const undo = (journalId: number, date = today) => must("POST", `/api/journals/${journalId}/reverse`, { date });
    const reverseOn = (box: number, date: string) => must("POST", `/api/containers/${box}/reverse`, { date });
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
    /** Every balance, by account, contact and currency. */
    const trial = async () => {
      const r = await db.execute(
        sql`select account_id, coalesce(party_id, 0) p, currency, sum(coalesce(native_amount, 0))::numeric(20,2)::text n, sum(debit - credit)::numeric(20,2)::text u from journal_lines group by 1, 2, 3 having sum(debit - credit) <> 0 or sum(coalesce(native_amount, 0)) <> 0 order by 1, 2, 3`,
      );
      return JSON.stringify((r as any).rows ?? r);
    };
    return { db, server, call, acc, contact, owed, container, offload, reverse, reverseOn, pay, undo, refund, close, reopen, selfOk, fxBooked, trial };
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

  it("F1: a bill paid in full after the close, another part paid; the month reopened, the other reversed: the claim is what was paid", async () => {
    for (const currency of ["CNY", "CDF"] as const) {
      const results: Record<string, string> = {};
      for (const mode of ["baseline", "reopen"] as const) {
        await withBooks([[`${m1}-01`, "2800", "7.1"], [m1End, "2700", "6.95"], [today, "2780", "7.2"]], async (h) => {
          const s = await h.contact(`Fournisseur F1 ${currency}`);
          const a = await h.container(s, currency, "200");
          const b = await h.container(s, currency, "200");
          await h.offload(a, `${m1}-10`);
          await h.close(m1);
          // The first bill paid in full at what the revaluation made it, by the manager.
          const [na] = await h.owed(s, currency);
          await h.pay(s, (Math.abs(Number(na)) / (currency === "CNY" ? 7.2 : 2780)).toFixed(2), today);
          expect(await h.owed(s, currency)).toEqual(["0.00", "0.00"]);
          await h.offload(b, today);
          await h.pay(s, "10000", today);
          if (mode === "reopen") await h.reopen(m1);
          await h.reverse(b);
          const [claim, worth] = await h.owed(s, currency);
          // At what was paid for it, and nothing owed in dollars.
          if (currency === "CNY") expect(worth, mode).toBe("10000.00");
          expect(await h.owed(s, "USD"), mode).toEqual(["0.00", "0.00"]);
          expect(await h.selfOk(), mode).toEqual([]);
          const r =
            currency === "CNY"
              ? await h.refund(s, worth, claim)
              : await h.call("POST", "/api/vouchers/receipt", { date: today, accountId: h.acc("cash_usd"), lines: [{ partyId: s, amount: (Number(claim) / 2780).toFixed(2) }] }, "gerant");
          expect(r.status, JSON.stringify(r.body)).toBe(201);
          expect([await h.owed(s, currency), await h.owed(s, "USD")], mode).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
          if (mode === "reopen") await h.close(m1);
          // Nothing left a manager could pay out.
          expect([await h.owed(s, currency), await h.owed(s, "USD")], mode).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
          expect(await h.selfOk(), mode).toEqual([]);
          results[mode] = `${await h.trial()} fx ${await h.fxBooked()}`;
        });
      }
      expect(results.reopen, currency).toBe(results.baseline);
    }
  });

  it("F2/F3: a payment that settled the balance in full undone, then the bill reversed, closed or reopened: nothing left on it", async () => {
    for (const [currency, quantity, unit] of [["CNY", "200", "1000"], ["CNY", "1", "1000"], ["CDF", "100", "300000"]] as const) {
      await withBooks(
        [[`${m3}-01`, "2800", "7.1"], [m3End, "2750", "7.0"], [m2End, "2850", "7.2"], [`${m1}-21`, "2810", "7.15"], [m1End, "2700", "6.95"], [today, "2800", "7.05"]],
        async (h) => {
          const label = `${currency} ${quantity}`;
          const s = await h.contact(`Fournisseur F2 ${label}`);
          const box = await h.container(s, currency, quantity, unit);
          await h.offload(box, `${m3}-24`);
          await h.close(m3);
          await h.close(m2);
          const [n, u] = await h.owed(s, currency);
          const p =
            currency === "CNY"
              ? await h.pay(s, (Math.abs(Number(n)) / 7.15).toFixed(2), `${m1}-21`, h.acc("cash_usd"), "admin")
              : await h.pay(s, String(-Number(n)), `${m1}-21`, h.acc("cash_cdf"), "admin");
          expect(await h.owed(s, currency), label).toEqual(["0.00", "0.00"]);
          await h.close(m1);
          expect(u).not.toBe("0.00");
          // F3: undone and reversed while every month is closed.
          await h.undo(p.id);
          await h.reverse(box);
          expect(await h.owed(s, currency), label).toEqual(["0.00", "0.00"]);
          expect(await h.selfOk(), label).toEqual([]);
          const trial = await h.trial();
          const fx = await h.fxBooked();
          // F2: reopened, nothing comes back on it; closed again, the books are as they were.
          for (let round = 0; round < 2; round++) {
            await h.reopen(m1);
            await h.reopen(m2);
            expect(await h.owed(s, currency), `${label} r${round}`).toEqual(["0.00", "0.00"]);
            expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
            await h.reopen(m3);
            expect(await h.owed(s, currency), `${label} r${round}`).toEqual(["0.00", "0.00"]);
            expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
            await h.close(m3);
            expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
            await h.close(m2);
            expect(await h.selfOk(), `${label} r${round}`).toEqual([]);
            await h.close(m1);
            expect(await h.owed(s, currency), `${label} r${round}`).toEqual(["0.00", "0.00"]);
            expect(await h.trial(), `${label} r${round}`).toBe(trial);
            expect(await h.fxBooked(), `${label} r${round}`).toBe(fx);
          }
          // A new bill paid while the months are reopened: still nothing left, and closing books no profit on it.
          await h.reopen(m1);
          await h.reopen(m2);
          const b2 = await h.container(s, currency, currency === "CNY" ? "10" : "1", unit);
          await h.offload(b2, today);
          const [n2, u2] = await h.owed(s, currency);
          if (currency === "CNY") await h.pay(s, (Math.abs(Number(n2)) / 7.05).toFixed(2), today, h.acc("cash_usd"), "admin");
          else await h.pay(s, String(-Number(n2)), today, h.acc("cash_cdf"), "admin");
          expect(await h.owed(s, currency), label).toEqual(["0.00", "0.00"]);
          await h.close(m2);
          await h.close(m1);
          expect(await h.owed(s, currency), label).toEqual(["0.00", "0.00"]);
          expect(await h.selfOk(), label).toEqual([]);
          expect(u2).not.toBe("0.00");
        },
      );
    }
  });

  it("F4: francs paid from the franc drawer dated before their bill settle it at its cost; undone, the bill is owed as booked", async () => {
    for (const who of ["gerant", "admin"]) {
      await withBooks([[`${m1}-01`, "2919", "7.1"], [`${m1}-09`, "2800", "7.1"], [today, "2800", "7.1"]], async (h) => {
        const s = await h.contact("Fournisseur F4");
        const box = await h.container(s, "CDF", "1");
        await h.offload(box, `${m1}-09`);
        expect(await h.owed(s, "CDF")).toEqual(["-300000.00", "-107.10"]);
        const fx = await h.fxBooked();
        const p = await h.pay(s, "300000", `${m1}-01`, h.acc("cash_cdf"), who);
        expect(await h.owed(s, "CDF"), who).toEqual(["0.00", "0.00"]);
        // The drawer's francs cost 107,14 $ for a bill of 107,10 $.
        expect(Number(await h.fxBooked()) - Number(fx), who).toBeCloseTo(-0.04, 2);
        expect(await h.selfOk(), who).toEqual([]);
        // By voucher too.
        const v = await h.call("POST", "/api/vouchers/payment", { date: `${m1}-01`, accountId: h.acc("cash_cdf"), lines: [{ partyId: s, amount: "300000" }] }, who);
        expect(v.status, JSON.stringify(v.body)).toBe(201);
        expect(await h.selfOk(), who).toEqual([]);
        await h.undo(v.body.id);
        await h.undo(p.id);
        expect(await h.owed(s, "CDF"), who).toEqual(["-300000.00", "-107.10"]);
        expect(await h.fxBooked(), who).toBe(fx);
        expect(await h.selfOk(), who).toEqual([]);
        await h.close(m1);
        expect(await h.selfOk(), who).toEqual([]);
      });
    }
  });

  it("F5: a month reopened and closed again with nothing in between books the same, after francs posted since moved the day they were settled", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "7.1"], [`${m1}-05`, "2750", "7.1"], [`${m1}-15`, "2790", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur F5");
      const a = await h.container(s, "CDF", "1");
      const b = await h.container(s, "CDF", "1");
      await h.offload(a, `${m2}-25`);
      // Settled before the close, then the close: its revaluation is taken off on the 15th.
      const p = await h.pay(s, "300000", `${m1}-15`, h.acc("cash_cdf"), "admin");
      await h.close(m2);
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      // Since: another bill dated back before that payment, paid, and the first payment undone and made again.
      await h.offload(b, `${m1}-05`);
      await h.pay(s, "300000", `${m1}-05`, h.acc("cash_cdf"), "admin");
      await h.undo(p.id);
      await h.pay(s, "300000", today, h.acc("cash_cdf"), "admin");
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      expect(await h.selfOk()).toEqual([]);
      const trial = await h.trial();
      for (let round = 0; round < 3; round++) {
        await h.reopen(m2);
        expect(await h.owed(s, "CDF"), `r${round}`).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk(), `r${round}`).toEqual([]);
        await h.close(m2);
        expect(await h.trial(), `r${round}`).toBe(trial);
        expect(await h.selfOk(), `r${round}`).toEqual([]);
      }
    });
  });

  it("F5: a bill reversed dated before another reversal that emptied the balance after the close: no dollars left on it, and re-closing books the same", async () => {
    // Francs only: a supplier's yuan cannot move dated before their last yuan entry.
    for (const currency of ["CDF"] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [today, "2800", "7.1"]], async (h) => {
        const s = await h.contact(`Fournisseur F5 ${currency}`);
        const a = await h.container(s, currency, "3");
        const b = await h.container(s, currency, "2");
        await h.offload(a, `${m2}-15`);
        const p = await h.pay(s, "450000", `${m2}-20`, h.acc("cash_cdf"), "admin");
        await h.close(m2);
        await h.offload(b, `${m1}-10`);
        await h.undo(p.id, `${m1}-13`);
        await h.reverseOn(b, `${m1}-26`);
        // Dated before the other reversal: the balance is emptied on the 26th, the month's revaluation with it.
        await h.reverseOn(a, `${m1}-22`);
        expect(await h.owed(s, currency), currency).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk(), currency).toEqual([]);
        const trial = await h.trial();
        await h.reopen(m2);
        expect(await h.owed(s, currency), currency).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk(), currency).toEqual([]);
        await h.close(m2);
        expect(await h.trial(), currency).toBe(trial);
      });
    }
  });

  it("F1: a bill paid in full after the close with more besides, then reversed: the claim stays what was paid, reopened or closed again", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2800", "6.95"], [`${m1}-26`, "2800", "7.0"], [today, "2800", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur payé d'avance");
      const b1 = await h.container(s, "CNY", "2");
      const b2 = await h.container(s, "CNY", "3");
      await h.offload(b2, `${m2}-27`);
      await h.close(m2);
      await h.offload(b1, `${m1}-10`);
      // 5 000 ¥ owed and paid on the 26th, with an advance in dollars besides; the 3 000 ¥ bill reversed that day.
      await h.pay(s, "800", `${m1}-26`);
      await h.reverseOn(b2, `${m1}-26`);
      const claim = await h.owed(s, "CNY");
      expect(claim[0]).toBe("3000.00");
      // The 3 000 ¥ claimed at the 3/5 of the 5 000 ¥ paid at 7.0 that they were paid.
      expect(claim[1]).toBe((3000 / 7).toFixed(2));
      const trial = await h.trial();
      await h.reopen(m2);
      expect(await h.owed(s, "CNY")).toEqual(claim);
      expect(await h.selfOk()).toEqual([]);
      await h.close(m2);
      expect(await h.trial()).toBe(trial);
      expect((await h.refund(s, claim[1], "3000")).status).toBe(201);
      expect(await h.owed(s, "CNY")).toEqual(["0.00", "0.00"]);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("F1: yuan paid after a payment undone are taken out at what the books carry them at; reversed, the claim is what was paid", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2800", "7.3"], [`${m1}-02`, "2800", "7.2"], [today, "2800", "7.2"]], async (h) => {
      const s = await h.contact("Fournisseur deux taux");
      const b1 = await h.container(s, "CNY", "1");
      const b2 = await h.container(s, "CNY", "3");
      await h.offload(b1, `${m2}-10`);
      await h.offload(b2, `${m2}-12`);
      // Paid after the month's end but before it is closed, then after the close; the first undone.
      const first = await h.pay(s, "200", `${m1}-02`);
      await h.close(m2);
      await h.pay(s, "100", `${m1}-05`);
      await h.undo(first.id, `${m1}-07`);
      await h.pay(s, "150", `${m1}-08`);
      await h.reverse(b1);
      await h.reverse(b2);
      // 720 ¥ and 1 080 ¥ claimed back at the 250 $ paid for them, closed or reopened.
      expect(await h.owed(s, "CNY")).toEqual(["1800.00", "250.00"]);
      expect(await h.selfOk()).toEqual([]);
      await h.reopen(m2);
      expect(await h.owed(s, "CNY")).toEqual(["1800.00", "250.00"]);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("F1: a payment that settles the yuan in full, then a bill reversed the same day after the close: the claim is what was paid, reopened or not", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2800", "7.05"], [today, "2800", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur réglé puis annulé");
      const b1 = await h.container(s, "CNY", "2");
      const b2 = await h.container(s, "CNY", "1");
      await h.offload(b2, `${m2}-06`);
      await h.offload(b1, `${m2}-13`);
      await h.pay(s, "100", `${m2}-20`);
      // Paid after the month's end before it is closed, undone once it is.
      const early = await h.pay(s, "30", `${m1}-06`);
      await h.close(m2);
      await h.undo(early.id, `${m1}-16`);
      const [owedCny] = await h.owed(s, "CNY");
      const rest = (Math.round((-Number(owedCny) / 7.1) * 100) / 100).toFixed(2);
      await h.call("POST", "/api/money/party-payment", { date: `${m1}-24`, partyId: s, accountId: h.acc("cash_usd"), amount: rest, settleNative: (-Number(owedCny)).toFixed(2) }, "admin").then((r) => expect(r.status, JSON.stringify(r.body)).toBe(201));
      expect(await h.owed(s, "CNY")).toEqual(["0.00", "0.00"]);
      await h.reverseOn(b1, `${m1}-24`);
      await h.reverse(b2);
      const paid = (100 + Number(rest)).toFixed(2);
      expect(await h.owed(s, "CNY")).toEqual(["3000.00", paid]);
      expect(await h.selfOk()).toEqual([]);
      await h.reopen(m2);
      expect(await h.owed(s, "CNY")).toEqual(["3000.00", paid]);
      expect(await h.selfOk()).toEqual([]);
    });
  });
});
