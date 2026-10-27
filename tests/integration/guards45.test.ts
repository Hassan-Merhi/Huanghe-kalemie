import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A50: what the forty-fifth accounting audit found after A49. A payment of part of a supplier's francs
 * (or yuan) owed took them out at their average cost and left on a bill offloaded after the month's end its
 * share of the month's revaluation; undone, it brought its francs back at that average, so the bill since
 * kept the share, and taking it away (a container reversed) took it off the francs still owed: with the
 * month closed first, 94,89 $ of a 147,07 $ revaluation (NEW-1; paid in dollars or by voucher, paid again
 * after, offloaded again, 33,18 $ with 5 000 000 FC paid and no undoing, 57,95 $ and 13,41 $ in yuan, 897,28 $
 * on 300 000 000 FC, the whole of it after five cycles). The same averaging left 0,41 $ a cycle on payments
 * of all owed and more undone the same day (NEW-2). Now a payment's undoing brings its francs back exactly as
 * they were, and a payment leaves its share of a month's revaluation on the francs that hold some of it,
 * never on a bill since while any of them are owed. Each case on its own books, closed at every place in its
 * postings and reopened between.
 */
describe.skipIf(!hasDb)("Guards found by the forty-fifth audit", async () => {
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
    /** A contact's balance on payables in one currency: [native, usd]. */
    const owed = async (partyId: number, currency: "USD" | "CNY" | "CDF") => {
      const [r] = await db
        .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
        .from(journalLines)
        .where(and(eq(journalLines.accountId, acc("payables")), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
      return [r.native, r.usd];
    };
    /** A container of `quantity` × `unitPrice` (2 000 ¥ at 0,140845, or 1 000 000 FC at 0,000357, by default). */
    const container = async (s: number, currency: "CNY" | "CDF", quantity: string, unitPrice = currency === "CNY" ? "2000" : "1000000", rateToUsd = currency === "CNY" ? "0.140845" : "0.000357") => {
      const product = await must("POST", "/api/products", { name: `Pièce ${n++}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
      const box = await must("POST", "/api/containers", { number: `A50-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
      await must("PUT", `/api/containers/${box.id}/lines`, { lines: [{ variantId: product.variants[0].id, quantity, unitPrice }] });
      return box.id as number;
    };
    const offload = (box: number, offloadDate: string) => must("POST", `/api/containers/${box}/finalize`, { offloadDate });
    const reverseOn = (box: number, date: string) => must("POST", `/api/containers/${box}/reverse`, { date });
    const pay = (s: number, amount: string, date: string, accountId = acc("cash_usd"), who = "gerant") => must("POST", "/api/money/party-payment", { date, partyId: s, accountId, amount }, who);
    const voucher = (s: number, amount: string, date: string, accountId: number) => must("POST", "/api/vouchers/payment", { date, accountId, lines: [{ partyId: s, amount }] }, "gerant");
    const undo = (journalId: number, date: string) => must("POST", `/api/journals/${journalId}/reverse`, { date });
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
    return { db, server, call, must, acc, contact, owed, container, offload, reverseOn, pay, voucher, undo, close, reopen, selfOk, fxBooked, kindLines, trial };
  }
  type Books = Awaited<ReturnType<typeof books>>;
  const withBooks = async <T>(rates: [string, string, string][], f: (h: Books) => Promise<T>): Promise<T> => {
    const h = await books(rates);
    try {
      return await f(h);
    } finally {
      h.server.close();
    }
  };

  // The loss and gain cases of the audit's probes: the month's end at 2 700 (or 2 906) FC.
  const lossRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2740", "7.0"], [`${m1}-13`, "2760", "7.0"], [`${m1}-20`, "2780", "7.05"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];
  const gainRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2906", "7.3"], [`${m1}-05`, "2880", "7.25"], [`${m1}-13`, "2870", "7.2"], [`${m1}-20`, "2860", "7.2"], [`${m1}-26`, "2850", "7.2"], [m1End, "2900", "7.2"], [today, "2880", "7.2"]];

  type Op = [kind: "payfc" | "pay" | "voucher" | "bill" | "reoffload" | "undo" | "reverse", arg: string, day: string];
  /**
   * The month's bills (`bills`: that many containers of 1 000 000 FC or 2 000 ¥, on its 4th and 8th), then `ops`
   * in the next month, the month closed before the `at`-th of them ("reopened": closed first, reopened at once
   * and closed after them all). `payfc` from the franc drawer (`voucher` the same by a payment voucher), `pay`
   * from the dollar drawer, `bill` offloads a container of that many, `reoffload` the n-th container again,
   * `undo` the n-th payment, `reverse` the n-th bill. What is owed closed, and reopened.
   */
  const run = async (currency: "CDF" | "CNY", rates: [string, string, string][], ops: Op[], at: number | "reopened", bills: string[]) =>
    withBooks(rates, async (h) => {
      const s = await h.contact(`Fournisseur A50 ${at}`);
      const boxes: number[] = [];
      const pays: number[] = [];
      for (const [i, quantity] of bills.entries()) {
        boxes.push(await h.container(s, currency, quantity));
        await h.offload(boxes[i], `${m2}-${["04", "08"][i]}`);
      }
      if (at === "reopened") {
        await h.close(m2);
        await h.reopen(m2);
      }
      for (const [i, [kind, arg, day]] of ops.entries()) {
        if (i === at) await h.close(m2);
        const date = `${m1}-${day}`;
        if (kind === "payfc") pays.push((await h.pay(s, arg, date, h.acc("cash_cdf"))).id);
        else if (kind === "pay") pays.push((await h.pay(s, arg, date)).id);
        else if (kind === "voucher") pays.push((await h.voucher(s, arg, date, h.acc("cash_cdf"))).id);
        else if (kind === "bill") {
          const box = await h.container(s, currency, arg);
          await h.offload(box, date);
          boxes.push(box);
        } else if (kind === "reoffload") await h.offload(boxes[Number(arg)], date);
        else if (kind === "undo") await h.undo(pays[Number(arg)], date);
        else await h.reverseOn(boxes[Number(arg)], date);
      }
      if (at === ops.length || at === "reopened") await h.close(m2);
      const owed = await h.owed(s, currency);
      expect(await h.selfOk(), `${at}`).toEqual([]);
      const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
      await h.reopen(m2);
      const open = await h.owed(s, currency);
      await h.close(m2);
      expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${at} closed again`).toBe(closed);
      return { owed, open };
    });
  /** What is owed closed (`want`) and reopened (`atCost`), closed at every place in `ops` and reopened between. */
  const everywhere = async (name: string, ops: Op[], want: [string, string], atCost: string, o: { currency?: "CDF" | "CNY"; gain?: boolean; bills?: string[] } = {}) => {
    for (const at of [...ops.map((_, i) => i), ops.length, "reopened" as const]) {
      const { owed, open } = await run(o.currency ?? "CDF", o.gain ? gainRates() : lossRates(), ops, at, o.bills ?? ["1", "10"]);
      expect(owed[0], `${name} ${at}`).toBe(want[0]);
      expect(Math.abs(Number(owed[1]) - Number(want[1])), `${name} ${at} ${owed[1]}`).toBeLessThan(0.015);
      expect(Math.abs(Number(open[1]) - Number(atCost)), `${name} ${at} reopened ${open[1]}`).toBeLessThan(0.015);
    }
  };

  it("NEW-1: a payment undone brings its francs back as they were, so reversing a bill since leaves the month's revaluation on the francs owed at its end, wherever the close sits", async () => {
    // 20 000 000 FC billed since, 15 000 000 FC paid and undone, the bill since reversed: 11 000 000 FC owed at
    // 2 700, at cost once reopened (before, 94,89 $ off with the month closed first).
    await everywhere("francs", [["bill", "20", "05"], ["payfc", "15000000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("francs, a gain", [["bill", "20", "05"], ["payfc", "15000000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"]], ["-11000000.00", "-3785.27"], "-3927.00", { gain: true });
    // Paid in dollars, or by voucher (before, 94,89 $).
    await everywhere("dollars", [["bill", "20", "05"], ["pay", "5000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("voucher", [["bill", "20", "05"], ["voucher", "15000000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"]], ["-11000000.00", "-4074.07"], "-3927.00");
    // A part of the month's francs paid and undone (before, 33,18 $).
    await everywhere("a part", [["bill", "20", "05"], ["payfc", "5000000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"]], ["-11000000.00", "-4074.07"], "-3927.00");
  }, 3_600_000);

  it("NEW-1: the same paid again after the undoing, or offloaded again after the reversal", async () => {
    // 5 000 000 FC paid again after (before, 94,89 $).
    await everywhere("paid again", [["bill", "20", "05"], ["payfc", "15000000", "13"], ["undo", "0", "20"], ["payfc", "5000000", "20"], ["reverse", "2", "22"]], ["-6000000.00", "-2265.35"], "-2142.00");
    // The bill since offloaded again after its reversal (before, 94,89 $).
    await everywhere("offloaded again", [["bill", "20", "05"], ["payfc", "15000000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"], ["reoffload", "2", "23"]], ["-31000000.00", "-11214.07"], "-11067.00");
  }, 3_600_000);

  it("NEW-1: a part paid, no undoing, then the bill since reversed leaves the rest of the revaluation on the month's francs still owed", async () => {
    // 5 000 000 FC paid takes its average share, the 6 000 000 FC of the month still owed keep the rest (before, 33,18 $).
    await everywhere("francs", [["bill", "20", "05"], ["payfc", "5000000", "13"], ["reverse", "2", "22"]], ["-6000000.00", "-2265.35"], "-2142.00");
    await everywhere("francs, a gain", [["bill", "20", "05"], ["payfc", "5000000", "13"], ["reverse", "2", "22"]], ["-6000000.00", "-2023.13"], "-2142.00", { gain: true });
  }, 3_600_000);

  it("NEW-1: the same in yuan", async () => {
    // 40 000 ¥ billed since, 4 000 $ paid and undone, the bill since reversed (before, 57,95 $).
    await everywhere("undone", [["bill", "20", "05"], ["pay", "4000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"]], ["-22000.00", "-3188.41"], "-3098.59", { currency: "CNY" });
    // Offloaded again after (before, 57,95 $).
    await everywhere("offloaded again", [["bill", "20", "05"], ["pay", "4000", "13"], ["undo", "0", "20"], ["reverse", "2", "22"], ["reoffload", "2", "23"]], ["-62000.00", "-8822.21"], "-8732.39", { currency: "CNY" });
    // 1 000 $ paid, no undoing (before, 13,41 $).
    await everywhere("a part", [["bill", "20", "05"], ["pay", "1000", "13"], ["reverse", "2", "22"]], ["-15000.00", "-2192.35"], "-2112.67", { currency: "CNY" });
  }, 3_600_000);

  it("NEW-1: bills since offloaded, paid in part, undone and reversed, cycle after cycle, leave the month's revaluation whole", async () => {
    for (const first of [true, false]) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Cycles A50 ${first}`);
        await h.offload(await h.container(s, "CDF", "11"), `${m2}-08`);
        if (first) await h.close(m2);
        for (let i = 0; i < 5; i++) {
          const date = `${m1}-${10 + i}`;
          const box = await h.container(s, "CDF", "100");
          await h.offload(box, date);
          const p = await h.pay(s, "50000000", date, h.acc("cash_cdf"));
          await h.undo(p.id, date);
          await h.reverseOn(box, date);
        }
        if (!first) await h.close(m2);
        // Before, the whole revaluation was gone by the fifth cycle (-3 927,00 $), closed first.
        expect(await h.owed(s, "CDF"), `closed ${first ? "first" : "last"}`).toEqual(["-11000000.00", "-4074.07"]);
        expect(await h.selfOk()).toEqual([]);
        await h.reopen(m2);
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", "-3927.00"]);
        expect(await h.kindLines(s, "settled_fx")).toEqual([]);
        await h.close(m2);
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", "-4074.07"]);
      });
    }
  }, 1_800_000);

  it("NEW-2: payments of all owed and more undone the same day, cycle after cycle, leave nothing behind", async () => {
    for (const reversed of [false, true]) for (const first of [true, false]) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Cycles A50 ${reversed} ${first}`);
        await h.offload(await h.container(s, "CDF", "1"), `${m2}-04`);
        const b1 = await h.container(s, "CDF", "10");
        await h.offload(b1, `${m2}-08`);
        if (first) await h.close(m2);
        for (const day of ["10", "11", "12", "14"]) {
          const date = `${m1}-${day}`;
          const p = await h.pay(s, "12000000", date, h.acc("cash_cdf"));
          // With the month's bill reversed and offloaded again the same day (before, 11,18 $ the first cycle).
          if (reversed) await h.reverseOn(b1, date);
          await h.undo(p.id, date);
          if (reversed) await h.offload(b1, date);
        }
        // Before, 0,41 $ a cycle. Offloaded again, the month's bill is a bill since: none of the revaluation on it.
        const revalued = reversed ? "-3940.37" : "-4074.07";
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", first ? revalued : "-3927.00"]);
        if (!first) await h.close(m2);
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", revalued]);
        expect(await h.selfOk()).toEqual([]);
        await h.reopen(m2);
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", "-3927.00"]);
      });
    }
  }, 1_800_000);
});
