import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A52: what the forty-seventh accounting audit found after A51. A bill since reversed took with it the share
 * of the month's revaluation a payment's average cost had left on its francs, and reopening the month did not take
 * it back with the reversal; the payment's undoing then gave it back, so reopened the month kept what it should not
 * (R1: -4 013,86 $ for -3 927,00 $, 86,86 $ of exchange differences left, and 86,86 $ on 0 FC once paid in full
 * and closed again: the self-check went red; 868,65 $ ten times over). A payment undone while a payment since had
 * paid into a claim: the francs it brought back met that claim, and the claim's payment undone in turn brought
 * them back owed without their share of the revaluation (P1: -4 007,22 $ for -4 074,07 $ closed; P2, a payment
 * dated back and undone: 120,33 $ left once reopened, all 147,07 $ when done again). Now a bill taken away takes
 * the share of the revaluation the francs it held carry, the month's francs owed again or not, and francs that met
 * a claim on their way back bring their share back when that claim's payment is undone, unless the true-ups gave
 * it back already. Each case on its own books, closed at every place in its postings and reopened between.
 */
describe.skipIf(!hasDb)("Guards found by the forty-seventh audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A52-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
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
      const s = await h.contact(`Fournisseur A52 ${at}`);
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


  // R1: the month's bills of 1 000 000 and 10 000 000 FC; next month a bill of 20 000 000 FC, two payments, a bill of
  // 5 000 000 FC, then the first bill since reversed, both payments undone and the second bill since reversed.
  const r1 = (q: [string, string, string, string], [rate, rate2]: [string, string]): Op[] => [["bill", q[0], "04", rate], ["payfc", q[1], "05"], ["payfc", q[2], "10"], ["bill", q[3], "12", rate2], ["reverse", "2", "28"], ["undo", "1", "28"], ["undo", "0", "28"], ["reverse", "3", "28"]];

  it("R1: a bill since reversed takes the share of the revaluation its francs carry, so reopened the month keeps none of it", async () => {
    // Before, -4 013,86 $ reopened and 86,86 $ of exchange differences (-3 856,87 $ and -70,13 $ at a loss).
    await everywhere("a gain", r1(["20", "3000000", "9000000", "5"], ["0.000350", "0.000335"]), ["-11000000.00", "-3785.27"], "-3927.00", { gain: true });
    await everywhere("a loss", r1(["20", "3000000", "9000000", "5"], ["0.000370", "0.000357"]), ["-11000000.00", "-4074.07"], "-3927.00");
    // Ten times over (before, 793,93 $ left once reopened).
    await everywhere("ten times over", r1(["200", "30000000", "90000000", "50"], ["0.000350", "0.000335"]), ["-110000000.00", "-37852.72"], "-39270.00", { gain: true, bills: ["10", "100"] });
  }, 3_600_000);

  it("R1: reopened, paid in full and closed again, nothing is left and the self-check passes", async () => {
    for (const [gain, big] of [[true, false], [false, false], [true, true]]) {
      await withBooks(gain ? gainRates() : lossRates(), async (h) => {
        const s = await h.contact(`Réglé A52 ${gain} ${big}`);
        const k = big ? 10 : 1;
        const boxes: number[] = [];
        const pays: number[] = [];
        for (const [q, day] of [[1, "04"], [10, "08"]] as const) {
          boxes.push(await h.container(s, "CDF", String(q * k)));
          await h.offload(boxes.at(-1)!, `${m2}-${day}`);
        }
        await h.close(m2);
        const [rate, rate2] = gain ? ["0.000350", "0.000335"] : ["0.000370", "0.000357"];
        for (const [kind, arg, day, r] of r1([String(20 * k), String(3000000 * k), String(9000000 * k), String(5 * k)], [rate, rate2])) {
          const date = `${m1}-${day}`;
          if (kind === "payfc") pays.push((await h.pay(s, arg, date, h.acc("cash_cdf"))).id);
          else if (kind === "bill") {
            boxes.push(await h.container(s, "CDF", arg, undefined, r));
            await h.offload(boxes.at(-1)!, date);
          } else if (kind === "undo") await h.undo(pays[Number(arg)], date);
          else await h.reverseOn(boxes[Number(arg)], date);
        }
        await h.reopen(m2);
        // Before, 86,86 $ on 0 FC (868,65 $ ten times over, -90,14 $ at a loss) and the self-check red.
        expect(await h.owed(s, "CDF")).toEqual([`-${11000000 * k}.00`, big ? "-39270.00" : "-3927.00"]);
        expect(await h.fxBooked()).toBe("0.00");
        await h.pay(s, String(11000000 * k), `${m1}-29`, h.acc("cash_cdf"));
        await h.close(m2);
        expect(await h.owed(s, "CDF"), `${gain} ${big}`).toEqual(["0.00", "0.00"]);
        expect(await h.owed(s, "USD")).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk()).toEqual([]);
      });
    }
  }, 1_800_000);

  it("P1: a payment into a claim undone after the payment that left the claim gives the francs it brings back owed their share", async () => {
    // 5 000 $ pay all the francs owed and leave a claim in dollars, then 5 000 000 FC (or 5 000 000 and 1 000 000 FC)
    // paid into it. Before, -4 007,22 $ closed (-4 060,70 $).
    await everywhere("dollars first undone", [["pay", "5000", "03"], ["payfc", "5000000", "06"], ["undo", "0", "28"], ["undo", "1", "28"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("francs first undone", [["pay", "5000", "03"], ["payfc", "5000000", "06"], ["undo", "1", "28"], ["undo", "0", "28"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("two of them", [["pay", "5000", "03"], ["payfc", "5000000", "15"], ["payfc", "1000000", "16"], ["undo", "1", "28"], ["undo", "0", "28"], ["undo", "2", "28"]], ["-11000000.00", "-4074.07"], "-3927.00");
  }, 3_600_000);

  it("P2: a payment dated back before a payment of all that was owed and more, undone, then that payment undone, leave none of the revaluation reopened", async () => {
    // Before, 120,33 $ left once reopened (147,07 $ done twice or more, 13,37 $ for 1 000 000 FC).
    await everywhere("once", [["payfc", "12000000", "07"], ["payfc", "9000000", "04"], ["undo", "1", "28"], ["undo", "0", "28"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("three times", [["payfc", "12000000", "07"], ["payfc", "9000000", "04"], ["undo", "1", "28"], ["payfc", "9000000", "04"], ["undo", "2", "28"], ["payfc", "9000000", "04"], ["undo", "3", "28"], ["undo", "0", "28"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("1 000 000 FC", [["payfc", "12000000", "07"], ["payfc", "1000000", "04"], ["undo", "1", "28"], ["undo", "0", "28"]], ["-11000000.00", "-4074.07"], "-3927.00");
    await everywhere("ten times over", [["payfc", "120000000", "07"], ["payfc", "90000000", "04"], ["undo", "1", "28"], ["undo", "0", "28"]], ["-110000000.00", "-40740.74"], "-39270.00", { bills: ["10", "100"] });
  }, 3_600_000);
});
