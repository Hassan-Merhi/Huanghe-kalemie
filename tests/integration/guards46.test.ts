import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A51: what the forty-sixth accounting audit found after A50. A payment of part of a supplier's francs, a
 * bill of the month reversed, the month closed, the payment undone and the bill since reversed: what closing the
 * month moved on the reversal was lent to the payment and came back on the month's francs with its undoing, and
 * the undoing gave back only the share of the francs it paid, not of the revaluation they hold (N1: 1 000 000 FC
 * owed at -238,39 $ instead of -370,37 $, 123,35 $ of exchange differences left once reopened; -2 383,92 $ for
 * -3 703,70 $ ten times over). A bill since reversed before the payment that paid part of it was undone took
 * with it what that payment's average cost had left on its francs, and the undoing did not give it back
 * (N2: 75,91 $ of a 147,07 $ revaluation, 45,42 $ never closed). Two payments undone oldest first: the first
 * undoing left what its payment had left on the francs the second paid on the francs it brought back, and the
 * second brought its francs back with it too (N3: 22,33 $, never closed). Now a payment's undoing is the exact
 * inverse of the payment and of what closing or reopening the month moved with it, whatever was posted between
 * and in whatever order they are undone; what left with a bill taken away since is given back by its true-up,
 * and the month's closing gives back the share of its revaluation the francs coming back hold. Each case on
 * its own books, closed at every place in its postings and reopened between.
 */
describe.skipIf(!hasDb)("Guards found by the forty-sixth audit", async () => {
  const { createApp } = await import("../../server/index");
  const checks = await import("../../server/services/checks");
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const [ty, tm] = today.split("-").map(Number);
  // The three months before this one: m3 (closed first), m2, m1 (the latest closed).
  const month = (back: number) => new Date(Date.UTC(ty, tm - 1 - back, 1)).toISOString().slice(0, 7);
  const end = (back: number) => new Date(Date.UTC(ty, tm - back, 0)).toISOString().slice(0, 10);
  const [m3, m2, m1] = [month(3), month(2), month(1)];
  const [m3End, m2End, m1End] = [end(3), end(2), end(1)];

  /** Fresh books with these rates ([date, CDF, CNY]), an opening of 100 000 $ and 1 028 000 000 FC, an owner and a manager. */
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
        { accountId: acc("cash_cdf"), debit: "367142.86", nativeAmount: "1028000000", rate: "2800" },
        { accountId: acc("opening_equity"), credit: "467142.86" },
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
      const box = await must("POST", "/api/containers", { number: `A51-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
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

  type Op = [kind: "payfc" | "pay" | "bill" | "undo" | "reverse", arg: string, day: string, rate?: string];
  /**
   * The month's bills (`bills`: containers of that many 1 000 000 FC or 2 000 ¥, on its 4th and 8th), then `ops`
   * in the next month, the month closed before the `at`-th of them ("reopened": closed first, reopened at once
   * and closed after them all; "never": not closed). `payfc` from the franc drawer, `pay` from the dollar
   * drawer, `bill` offloads a container of that many (at `rate`), `undo` the n-th payment, `reverse` the n-th
   * bill. What is owed closed, and reopened, and the exchange differences once reopened.
   */
  const run = async (currency: "CDF" | "CNY", rates: [string, string, string][], ops: Op[], at: number | "reopened" | "never", bills: string[]) =>
    withBooks(rates, async (h) => {
      const s = await h.contact(`Fournisseur A51 ${at}`);
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
      for (const [i, [kind, arg, day, rate]] of ops.entries()) {
        if (i === at) await h.close(m2);
        const date = `${m1}-${day}`;
        if (kind === "payfc") pays.push((await h.pay(s, arg, date, h.acc("cash_cdf"))).id);
        else if (kind === "pay") pays.push((await h.pay(s, arg, date)).id);
        else if (kind === "bill") {
          const box = await h.container(s, currency, arg, undefined, rate);
          await h.offload(box, date);
          boxes.push(box);
        } else if (kind === "undo") await h.undo(pays[Number(arg)], date);
        else await h.reverseOn(boxes[Number(arg)], date);
      }
      if (at === "never") return { owed: await h.owed(s, currency), open: await h.owed(s, currency), fx: await h.fxBooked() };
      if (at === ops.length || at === "reopened") await h.close(m2);
      const owed = await h.owed(s, currency);
      expect(await h.selfOk(), `${at}`).toEqual([]);
      const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
      await h.reopen(m2);
      const open = await h.owed(s, currency);
      const fx = await h.fxBooked();
      await h.close(m2);
      expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${at} closed again`).toBe(closed);
      return { owed, open, fx };
    });
  /** What is owed closed (`want`) and reopened (`atCost`, with no exchange difference left), closed at every place in `ops` and reopened between. */
  const everywhere = async (name: string, ops: Op[], want: [string, string], atCost: string, o: { currency?: "CDF" | "CNY"; gain?: boolean; bills?: string[] } = {}) => {
    for (const at of [...ops.map((_, i) => i), ops.length, "reopened" as const]) {
      const { owed, open, fx } = await run(o.currency ?? "CDF", o.gain ? gainRates() : lossRates(), ops, at, o.bills ?? ["1", "10"]);
      expect(owed[0], `${name} ${at}`).toBe(want[0]);
      expect(Math.abs(Number(owed[1]) - Number(want[1])), `${name} ${at} ${owed[1]}`).toBeLessThan(0.015);
      expect(Math.abs(Number(open[1]) - Number(atCost)), `${name} ${at} reopened ${open[1]}`).toBeLessThan(0.015);
      expect(Math.abs(Number(fx)), `${name} ${at} reopened fx ${fx}`).toBeLessThan(0.015);
    }
  };

  it("N1: a bill of the month reversed, the month closed, the payment undone and the bill since reversed leave the month's francs at its end's rate, wherever the close sits", async () => {
    // 1 000 000 FC owed (before, -238,39 $ closed after the reversal, 123,35 $ of exchange differences once reopened).
    const ops: Op[] = [["bill", "20", "05"], ["payfc", "5000000", "13"], ["reverse", "1", "15"], ["undo", "0", "20"], ["reverse", "2", "22"]];
    await everywhere("francs", ops, ["-1000000.00", "-370.37"], "-357.00");
    await everywhere("francs, a gain", ops, ["-1000000.00", "-344.12"], "-357.00", { gain: true });
    // 5 000 000 FC owed (before, -1 641,74 $).
    await everywhere("5 000 000 FC", ops, ["-5000000.00", "-1851.85"], "-1785.00", { bills: ["5", "10"] });
    // Ten times over (before, -2 383,92 $ for -3 703,70 $, 1 233,52 $ left once reopened).
    const ten: Op[] = [["bill", "200", "05"], ["payfc", "50000000", "13"], ["reverse", "1", "15"], ["undo", "0", "20"], ["reverse", "2", "22"]];
    await everywhere("ten times over", ten, ["-10000000.00", "-3703.70"], "-3570.00", { bills: ["10", "100"] });
  }, 3_600_000);

  it("N2: the bill since reversed before the payment is undone ends where undoing it first does", async () => {
    // 15 000 000 FC paid the same day (before, -3 998,16 $ closed first or last).
    for (const rate of ["0.000357", "0.000365"]) {
      const reversedFirst: Op[] = [["bill", "20", "10", rate], ["payfc", "15000000", "10"], ["reverse", "2", "10"], ["undo", "0", "10"]];
      const undoneFirst: Op[] = [["bill", "20", "10", rate], ["payfc", "15000000", "10"], ["undo", "0", "10"], ["reverse", "2", "10"]];
      for (const ops of [reversedFirst, undoneFirst]) {
        await everywhere(`francs ${rate}`, ops, ["-11000000.00", "-4074.07"], "-3927.00");
        // Never closed (before, -3 972,42 $ with the bill since at another rate).
        const { owed, fx } = await run("CDF", lossRates(), ops, "never", ["1", "10"]);
        expect(owed, `never ${rate}`).toEqual(["-11000000.00", "-3927.00"]);
        expect(fx).toBe("0.00");
      }
    }
    // Paid in dollars (before, -80,79 $), and in yuan (before, -54,32 $).
    await everywhere("dollars", [["bill", "20", "10"], ["pay", "5000", "10"], ["reverse", "2", "10"], ["undo", "0", "10"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("yuan", [["bill", "20", "10"], ["pay", "3500", "10"], ["reverse", "2", "10"], ["undo", "0", "10"]], ["-22000.00", "-3188.41"], "-3098.59", { currency: "CNY" });
  }, 3_600_000);

  it("N2: the same, cycle after cycle", async () => {
    for (const first of [true, false]) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Cycles A51 ${first}`);
        await h.offload(await h.container(s, "CDF", "1"), `${m2}-04`);
        await h.offload(await h.container(s, "CDF", "10"), `${m2}-08`);
        if (first) await h.close(m2);
        for (let i = 0; i < 4; i++) {
          const date = `${m1}-${10 + i}`;
          const box = await h.container(s, "CDF", "20", undefined, "0.000365");
          await h.offload(box, date);
          const p = await h.pay(s, "15000000", date, h.acc("cash_cdf"));
          await h.reverseOn(box, date);
          await h.undo(p.id, date);
        }
        if (!first) await h.close(m2);
        // Before, -3 935,06 $ (-4 018,24 $ at another rate).
        expect(await h.owed(s, "CDF"), `closed ${first ? "first" : "last"}`).toEqual(["-11000000.00", "-4074.07"]);
        expect(await h.selfOk()).toEqual([]);
        await h.reopen(m2);
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", "-3927.00"]);
        expect(await h.fxBooked()).toBe("0.00");
        await h.close(m2);
        expect(await h.owed(s, "CDF")).toEqual(["-11000000.00", "-4074.07"]);
      });
    }
  }, 1_800_000);

  it("N3: two payments undone in either order, no month closed, leave every bill at its own dollars", async () => {
    // 5 000 000 FC, then the rest: undone oldest first (before, -3 938,33 $ for -3 927,00 $), or newest first.
    for (const [first, second] of [["0", "1"], ["1", "0"]]) {
      const ops: Op[] = [["bill", "20", "05", "0.000365"], ["payfc", "5000000", "13"], ["payfc", "26000000", "14"], ["undo", first, "20"], ["undo", second, "21"], ["reverse", "2", "22"]];
      const { owed, fx } = await run("CDF", lossRates(), ops, "never", ["1", "10"]);
      expect(owed, `undone ${first} first`).toEqual(["-11000000.00", "-3927.00"]);
      expect(fx).toBe("0.00");
    }
    // Ten times over at another rate (before, 347,39 $), and yuan (before, 127,62 $ thirty times over).
    const { owed, fx } = await run("CDF", lossRates(), [["bill", "200", "05", "0.000370"], ["payfc", "50000000", "13"], ["payfc", "260000000", "14"], ["undo", "0", "20"], ["undo", "1", "21"], ["reverse", "2", "22"]], "never", ["10", "100"]);
    expect(owed).toEqual(["-110000000.00", "-39270.00"]);
    expect(fx).toBe("0.00");
    const yuan = await run("CNY", lossRates(), [["bill", "20", "05", "0.1449"], ["pay", "700", "13"], ["pay", "8157.14", "14"], ["undo", "0", "20"], ["undo", "1", "21"], ["reverse", "2", "22"]], "never", ["1", "10"]);
    expect(yuan.owed).toEqual(["-22000.00", "-3098.59"]);
    expect(yuan.fx).toBe("0.00");
  }, 1_800_000);
});
