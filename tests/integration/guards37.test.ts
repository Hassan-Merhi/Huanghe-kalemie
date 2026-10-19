import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A42: what the thirty-seventh accounting audit found after A41. A franc bill reversed after a month's
 * close left the whole revaluation on the supplier's other francs (N1); payroll runs, advances and vouchers
 * undone left employees and the withholdings account with dollars on no francs (N2); a yuan claim drifted
 * from the cash paid once a payment was undone across reopen and close cycles (N3); closing or reopening a
 * month took the contacts' locks out of order (N4); a dollar payment dated before a franc bill's reversal
 * left a few francs with dollars no rate explains (N5); and the owner could undo the books' own francs_met
 * journal on its own (N6).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the thirty-seventh audit", async () => {
  const { createApp } = await import("../../server/index");
  const checks = await import("../../server/services/checks");
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const [ty, tm] = today.split("-").map(Number);
  // The four months before this one: m4 (closed first), m3, m2, m1 (the latest closed).
  const month = (back: number) => new Date(Date.UTC(ty, tm - 1 - back, 1)).toISOString().slice(0, 7);
  const end = (back: number) => new Date(Date.UTC(ty, tm - back, 0)).toISOString().slice(0, 10);
  const [m4, m3, m2, m1] = [month(4), month(3), month(2), month(1)];
  const [m4End, m3End, m2End, m1End] = [end(4), end(3), end(2), end(1)];

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
    const container = async (s: number, currency: "CNY" | "CDF", quantity = "2", unitPrice = currency === "CNY" ? "1000" : "300000") => {
      const product = await must("POST", "/api/products", { name: `Pièce ${n++}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
      const box = await must("POST", "/api/containers", { number: `A42-${n++}`, supplierId: s, locationId, currency, rateToUsd: currency === "CNY" ? "0.140845" : "0.000357", status: "arrived" });
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
    /** The cash paid to a contact, net of what came back: the money lines of the journals that touch them. */
    const cashPaid = async (partyId: number) => {
      const r = await db.execute(
        sql`select coalesce(-sum(l.debit - l.credit), 0)::numeric(20,2)::text v from journal_lines l join accounts a on a.id = l.account_id join journals j on j.id = l.journal_id where a.is_money and j.type <> 'revaluation' and l.journal_id in (select journal_id from journal_lines where party_id = ${partyId})`,
      );
      return ((r as any).rows ?? r)[0].v as string;
    };
    /** Every balance, by account, contact and currency. */
    const trial = async () => {
      const r = await db.execute(
        sql`select account_id, coalesce(party_id, 0) p, currency, sum(coalesce(native_amount, 0))::numeric(20,2)::text n, sum(debit - credit)::numeric(20,2)::text u from journal_lines group by 1, 2, 3 having sum(debit - credit) <> 0 or sum(coalesce(native_amount, 0)) <> 0 order by 1, 2, 3`,
      );
      return JSON.stringify((r as any).rows ?? r);
    };
    return { db, server, call, must, acc, contact, balance, owed, container, offload, reverseOn, pay, undo, close, reopen, selfOk, fxBooked, cashPaid, trial };
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

  it("N1: a franc bill reversed after the close takes its share of the revaluation with it, in both directions, as a yuan bill does", async () => {
    for (const loss of [true, false]) {
      const label = loss ? "loss" : "gain";
      const endRate = loss ? 2700 : 2906;
      const dayRate = loss ? 2750 : 2850;
      const rates: [string, string, string][] = [[`${m2}-01`, "2800", "7.1"], [m2End, String(endRate), loss ? "6.9" : "7.3"], [`${m1}-20`, String(dayRate), "7.0"], [today, String(dayRate), "7.0"]];
      const results: Record<string, string> = {};
      for (const mode of ["baseline", "cycle"] as const) {
        await withBooks(rates, async (h) => {
          const s = await h.contact(`Fournisseur N1 ${label}`);
          const big = await h.container(s, "CDF", "10", "500340");
          const small = await h.container(s, "CDF", "1", "123400");
          await h.offload(big, `${m2}-16`);
          await h.offload(small, `${m2}-18`);
          await h.close(m2);
          expect(await h.owed(s, "CDF"), label).toEqual(["-5126800.00", `-${cents(5126800 / endRate)}`]);
          if (mode === "cycle") {
            await h.reopen(m2);
            await h.close(m2);
          }
          await h.reverseOn(big, `${m1}-20`);
          // The small bill carries its own part of the revaluation: its francs at the month-end rate.
          expect(await h.owed(s, "CDF"), label).toEqual(["-123400.00", `-${cents(123400 / endRate)}`]);
          expect(await h.owed(s, "USD"), label).toEqual(["0.00", "0.00"]);
          expect(await h.selfOk(), label).toEqual([]);
          // Paid in francs by the manager: nothing left, and no dollars paid out for francs the shop did not owe.
          await h.pay(s, "123400", `${m1}-20`, h.acc("cash_cdf"));
          expect([await h.owed(s, "CDF"), await h.owed(s, "USD")], label).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
          expect(await h.selfOk(), label).toEqual([]);
          await h.reopen(m2);
          expect(await h.selfOk(), `${label} reopened`).toEqual([]);
          await h.close(m2);
          results[mode] = `${await h.trial()} fx ${await h.fxBooked()}`;
        });
      }
      expect(results.cycle, label).toBe(results.baseline);
    }
  });

  it("N1: paying the dollars shown for the francs left after a reversal pays no advance beyond the rate's move since the month's end", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-20`, "2750", "7.0"], [today, "2750", "7.0"]], async (h) => {
      const s = await h.contact("Fournisseur N1 dollars");
      const big = await h.container(s, "CDF", "10", "500340");
      const small = await h.container(s, "CDF", "1", "123400");
      await h.offload(big, `${m2}-16`);
      await h.offload(small, `${m2}-18`);
      await h.close(m2);
      await h.reverseOn(big, `${m1}-20`);
      const [, shown] = await h.owed(s, "CDF");
      expect(shown).toBe(`-${cents(123400 / 2700)}`);
      await h.pay(s, String(-Number(shown)), `${m1}-20`);
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      // Only what the rate's move since the month's end makes of 123 400 FC (45,70 − 44,87), not the big bill's revaluation.
      const [, advance] = await h.owed(s, "USD");
      expect(Number(advance)).toBeCloseTo(123400 / 2700 - 123400 / 2750, 1);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("N1: one franc bill, paid in part after the close, then reversed: the claim is what was paid, and reopening or closing again books the same", async () => {
    const results: Record<string, string> = {};
    for (const mode of ["baseline", "cycle"] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-10`, "2750", "7.0"], [today, "2780", "7.0"]], async (h) => {
        const s = await h.contact("Fournisseur N1 partiel");
        const box = await h.container(s, "CDF", "3", "300000");
        await h.offload(box, `${m2}-20`);
        await h.close(m2);
        await h.pay(s, "600000", `${m1}-10`, h.acc("cash_cdf"));
        if (mode === "cycle") {
          await h.reopen(m2);
          await h.close(m2);
        }
        await h.reverseOn(box, `${m1}-12`);
        // 600 000 FC claimed back at what was paid for them that day, no dollars either way.
        expect(await h.owed(s, "CDF")).toEqual(["600000.00", cents(600000 / 2750)]);
        expect(await h.owed(s, "USD")).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk()).toEqual([]);
        // Refunded in francs: nothing left.
        const r = await h.call("POST", "/api/vouchers/receipt", { date: today, accountId: h.acc("cash_cdf"), lines: [{ partyId: s, amount: "600000" }] }, "gerant");
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect([await h.owed(s, "CDF"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
        await h.reopen(m2);
        expect(await h.selfOk()).toEqual([]);
        await h.close(m2);
        results[mode] = `${await h.trial()} fx ${await h.fxBooked()}`;
      });
    }
    expect(results.cycle).toBe(results.baseline);
  });

  it("N1: a single franc bill reversed after the close leaves nothing, closed or reopened", async () => {
    for (const endRate of ["2700", "2906"]) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, endRate, "6.9"], [today, "2750", "7.0"]], async (h) => {
        const s = await h.contact(`Fournisseur N1 seul ${endRate}`);
        const box = await h.container(s, "CDF", "1", "123400");
        await h.offload(box, `${m2}-18`);
        await h.close(m2);
        await h.reverseOn(box, `${m1}-05`);
        expect([await h.owed(s, "CDF"), await h.owed(s, "USD")], endRate).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
        await h.reopen(m2);
        expect([await h.owed(s, "CDF"), await h.owed(s, "USD")], endRate).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
        expect(await h.selfOk(), endRate).toEqual([]);
      });
    }
  });

  it("N2: withheld francs paid over dated between two runs leave the account at no francs and no dollars, undone or not", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m2}-15`, "2830", "7.1"], [m2End, "2790", "7.1"], [`${m1}-10`, "2760", "7.1"], [m1End, "2810", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const e1 = await h.contact("Employé N2 a", "employee");
      const e2 = await h.contact("Employé N2 b", "employee");
      const salaryAcc = (await h.must("GET", "/api/payroll")).salaryAccountId;
      const run = (m: string, date: string) => h.must("POST", "/api/payroll/runs", { month: m, date, accountId: salaryAcc, currency: "CDF", lines: [{ partyId: e1, salary: "561700", withheld: "10000" }, { partyId: e2, salary: "280000", withheld: "10000" }] }, "gerant");
      await run(m2, `${m2}-15`);
      await run(m1, m1End);
      const withheld = h.acc("payroll_withheld");
      expect((await h.balance(withheld, null, "CDF"))[0]).toBe("-40000.00");
      // The first run's withholdings paid over in full, dated between the two runs: only the second's are left, at its own dollars.
      const r = await h.call("POST", "/api/vouchers/payment", { date: `${m1}-10`, accountId: h.acc("cash_cdf"), memo: "Retenues versées", lines: [{ accountId: withheld, amount: "20000" }] }, "gerant");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await h.balance(withheld, null, "CDF")).toEqual(["-20000.00", `-${cents(20000 / 2810)}`]);
      expect(await h.selfOk()).toEqual([]);
      const r2 = await h.call("POST", "/api/vouchers/payment", { date: today, accountId: h.acc("cash_cdf"), memo: "Retenues versées", lines: [{ accountId: withheld, amount: "20000" }] }, "gerant");
      expect(r2.status, JSON.stringify(r2.body)).toBe(201);
      expect(await h.balance(withheld, null, "CDF")).toEqual(["0.00", "0.00"]);
      expect(await h.selfOk()).toEqual([]);
      // Undone: the francs are owed again as the runs booked them, dollars and all.
      expect((await h.undo(r2.body.id)).status).toBe(200);
      expect((await h.undo(r.body.id)).status).toBe(200);
      expect(await h.balance(withheld, null, "CDF")).toEqual(["-40000.00", `-${cents(Number(cents(20000 / 2830)) + Number(cents(20000 / 2810)))}`]);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("N2: a franc salary paid in dollars and francs after the close, the run cancelled and the payments undone: the employee's francs never hold dollars at none", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "7.1"], [`${m1}-05`, "2760", "7.1"], [`${m1}-12`, "2790", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const e = await h.contact("Employé N2 c", "employee");
      const salaryAcc = (await h.must("GET", "/api/payroll")).salaryAccountId;
      await h.must("POST", "/api/payroll/runs", { month: m2, date: m2End, accountId: salaryAcc, currency: "CDF", lines: [{ partyId: e, salary: "561700" }] }, "gerant");
      await h.close(m2);
      const advance = await h.pay(e, "20", `${m1}-05`);
      const p = await h.call("POST", "/api/vouchers/payment", { date: `${m1}-12`, accountId: h.acc("cash_cdf"), memo: "Salaires", lines: [{ partyId: e, amount: "500000" }] }, "gerant");
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      expect(await h.selfOk()).toEqual([]);
      await h.must("POST", `/api/payroll/runs/${m2}/cancel`, { date: today }, "gerant");
      // What was paid is the employee's to give back: the francs, with dollars of their own sign.
      const [claim, worth] = await h.owed(e, "CDF");
      expect(claim).toBe("555200.00");
      expect(Number(worth)).toBeGreaterThan(0);
      expect(await h.selfOk()).toEqual([]);
      expect((await h.undo(p.body.id)).status).toBe(200);
      expect((await h.owed(e, "CDF"))[0]).toBe("55200.00");
      expect(await h.selfOk()).toEqual([]);
      await h.reopen(m2);
      expect(await h.selfOk()).toEqual([]);
      await h.close(m2);
      expect(await h.selfOk()).toEqual([]);
      // The advance undone too: nothing left, in either currency.
      expect((await h.undo(advance.id)).status).toBe(200);
      expect([await h.owed(e, "CDF"), await h.owed(e, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("N3: a yuan claim revalued at a close, the payment undone, paid again across reopen and close cycles: the claim is the cash paid", async () => {
    // Fuzzer f36's seed 188, supplier 1 alone, its rates on the days that matter; with the month closes and without.
    const rates: [string, string, string][] = [
      [`${m4}-01`, "2792", "7.1217"], [m4End, "2886", "7.3302"], [`${m3}-03`, "2885", "7.2580"], [`${m3}-12`, "2950", "6.9573"], [`${m3}-25`, "2896", "6.9995"], [m3End, "2906", "6.8000"],
      [`${m2}-10`, "2937", "6.8000"], [`${m2}-13`, "2927", "6.9466"], [`${m2}-15`, "2920", "6.9217"], [m2End, "2950", "6.8000"], [`${m1}-11`, "2825", "6.8098"], [m1End, "2933", "6.8624"], [today, "2843", "7.2218"],
    ];
    for (const periods of [true, false]) {
      await withBooks(rates, async (h) => {
        const label = periods ? "closes" : "no closes";
        const s = await h.contact(`Fournisseur N3 ${label}`);
        const b1 = await h.container(s, "CNY", "1");
        const b2 = await h.container(s, "CNY", "2");
        const period = async (f: () => Promise<unknown>) => {
          if (periods) await f();
        };
        await h.offload(b2, `${m3}-03`);
        await h.offload(b1, `${m3}-12`);
        const paid = await h.pay(s, "428.60", `${m3}-25`, h.acc("cash_usd"), "admin");
        await period(() => h.close(m4));
        await h.reverseOn(b1, `${m3}-25`);
        await period(() => h.reopen(m4));
        await period(() => h.close(m4));
        await period(() => h.close(m3));
        const undone = await h.undo(paid.id, `${m2}-10`);
        expect(undone.status, `${label} ${JSON.stringify(undone.body)}`).toBe(200);
        // The yuan owed again carry the bill's own dollars: the revaluation of the claim went with the payment undone.
        expect(await h.owed(s, "CNY"), label).toEqual(["-2000.00", "-281.69"]);
        expect(await h.owed(s, "USD"), label).toEqual(["0.00", "0.00"]);
        await period(() => h.reopen(m3));
        await period(() => h.close(m3));
        await h.pay(s, "143.96", `${m2}-13`, h.acc("cash_usd"), "admin");
        await period(() => h.reopen(m3));
        await period(() => h.reopen(m4));
        await period(() => h.close(m4));
        await h.offload(b1, `${m2}-15`);
        await period(() => h.close(m3));
        await period(() => h.reopen(m3));
        await h.pay(s, "91.04", `${m1}-11`);
        await h.reverseOn(b1, today);
        await h.reverseOn(b2, today);
        await period(() => h.reopen(m4));
        // 1 619,99 ¥ claimed back, worth the 235,00 $ paid for them, with the month closes or without.
        const [claim, worth] = await h.owed(s, "CNY");
        const [, usd] = await h.owed(s, "USD");
        expect(claim, label).toBe("1619.99");
        expect(cents(Number(worth) + Number(usd)), label).toBe("235.00");
        expect(await h.cashPaid(s), label).toBe("235.00");
        expect(await h.selfOk(), label).toEqual([]);
      });
    }
  });

  it("N4: closing and reopening a month take the restated contacts' locks in order (HK_LOCK_ORDER=strict)", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "7.1"], [`${m1}-05`, "2750", "7.1"], [`${m1}-10`, "2760", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const a = await h.contact("Fournisseur N4 a");
      const b = await h.contact("Fournisseur N4 b");
      const c = await h.contact("Fournisseur N4 c");
      for (const s of [a, b, c]) await h.offload(await h.container(s, "CDF", "1", "300000"), `${m2}-20`);
      // Settled after the month's end on different days, the latest contact first.
      await h.pay(c, "300000", `${m1}-05`, h.acc("cash_cdf"));
      await h.pay(b, "300000", `${m1}-08`, h.acc("cash_cdf"));
      await h.pay(a, "300000", `${m1}-10`, h.acc("cash_cdf"));
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
      for (const s of [a, b, c]) expect([await h.owed(s, "CDF"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("N5: a payment dated before a franc bill's reversal, the other bill revalued at the close: the francs and their dollars clear together", async () => {
    for (const variant of ["exact", "short", "francs"] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "7.1"], [`${m1}-10`, "2750", "7.1"], [m1End, "2760", "7.1"], [today, "2800", "7.1"]], async (h) => {
        const s = await h.contact(`Fournisseur N5 ${variant}`);
        const a = await h.container(s, "CDF", "3", "300000");
        const b = await h.container(s, "CDF", "1", "300000");
        await h.offload(a, `${m2}-26`);
        await h.close(m2);
        await h.offload(b, `${m1}-05`);
        await h.reverseOn(a, `${m1}-13`);
        expect(await h.owed(s, "CDF"), variant).toEqual(["-300000.00", "-107.10"]);
        // 299 999 FC settle the bill too: the franc left is worth under half a cent.
        const francs = variant === "exact" ? 300000 : 299999;
        if (variant === "francs") await h.pay(s, String(francs), `${m1}-10`, h.acc("cash_cdf"));
        else await h.pay(s, (francs / 2750).toFixed(2), `${m1}-10`);
        const [left, worth] = await h.owed(s, "CDF");
        expect(left, variant).toBe("0.00");
        expect(worth, variant).toBe("0.00");
        expect(await h.owed(s, "USD"), variant).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk(), variant).toEqual([]);
        await h.close(m1);
        expect(await h.selfOk(), variant).toEqual([]);
        expect((await h.owed(s, "CDF"))[1], variant).toBe("0.00");
      });
    }
  });

  it("N5: a franc bill dated before the day a reversal left the claim it meets takes the claim at what was paid, nothing left at none", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m2}-15`, "2688", "7.1"], [`${m2}-18`, "2755", "7.1"], [m2End, "2700", "7.1"], [`${m1}-15`, "2760", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur N5 reprise");
      const a = await h.container(s, "CDF", "1", "300000");
      await h.offload(a, `${m2}-15`);
      // Paid in dollars three days later at a better rate: 108,89 $ settle the 300 000 FC booked at 111,61 $.
      await h.pay(s, "108.89", `${m2}-18`, h.acc("cash_usd"), "admin");
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      await h.close(m2);
      await h.reverseOn(a, `${m1}-16`);
      // The francs come back claimed at what was paid for them.
      expect(await h.owed(s, "CDF")).toEqual(["300000.00", "108.89"]);
      // Another bill, dated the day before the reversal: the claim meets it, and the bill's own difference goes to exchange.
      const b = await h.container(s, "CDF", "1", "300000");
      await h.offload(b, `${m1}-15`);
      expect([await h.owed(s, "CDF"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
      expect(await h.selfOk()).toEqual([]);
      await h.reopen(m2);
      expect(await h.selfOk()).toEqual([]);
    });
  });

  it("N6: the books' own francs_met journal (or an advance applied) cannot be undone on its own, only with its payment", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m1}-01`, "2919", "7.1"], [`${m1}-09`, "2800", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur N6");
      const box = await h.container(s, "CDF", "1", "300000");
      await h.offload(box, `${m1}-09`);
      const paid = await h.pay(s, "300000", `${m1}-01`, h.acc("cash_cdf"));
      const [met] = await h.db.select({ id: journals.id }).from(journals).where(eq(journals.sourceType, "francs_met"));
      expect(met).toBeDefined();
      const r = await h.undo(met.id);
      expect(r.status).toBe(409);
      expect(r.body.messageFr).toMatch(/comptabilité elle-même/);
      expect([await h.owed(s, "CDF"), await h.owed(s, "USD")]).toEqual([["0.00", "0.00"], ["0.00", "0.00"]]);
      // Undone with its payment: the bill is owed again as booked.
      expect((await h.undo(paid.id)).status).toBe(200);
      expect(await h.owed(s, "CDF")).toEqual(["-300000.00", "-107.10"]);
      expect(await h.selfOk()).toEqual([]);
      // A dollar advance applied to a franc bill is the bill's as well.
      const t = await h.contact("Fournisseur N6 avance");
      await h.pay(t, "50", `${m1}-01`);
      await h.offload(await h.container(t, "CDF", "1", "300000"), `${m1}-09`);
      const [applied] = await h.db.select({ id: journals.id }).from(journals).where(eq(journals.sourceType, "advance_container"));
      expect(applied).toBeDefined();
      expect((await h.undo(applied.id)).status).toBe(409);
    });
  });
});
