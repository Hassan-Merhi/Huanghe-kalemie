import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A49: what the forty-fourth accounting audit found after A48. A payment of all a supplier's francs owed
 * and more, a bill since that its claim met, the month's bill reversed, then the payment undone: closing the
 * month after the payment gave back with the undoing the whole revaluation the payment took, counting as its
 * own the francs its claim met and those the reversed bill's paid francs paid since, which hold none of it
 * (N1: 134,81 $; 1 337,17 $ on 100 000 000 FC; paid by voucher, offloaded again before the undoing, three
 * bills of the month, a part paid before). A payment undone and another posted and undone the same day, the
 * month's bill reversed after: what closing the month moved on that day gave the undone payments' share of
 * the revaluation to the month's bills only, not to a bill since they had paid at their own average cost
 * (N2: 17,25 $; 86,26 $ with no second payment; 3,55 $ and 3,09 $ with same-day undoings, 1,11 $). Each case
 * on its own books, closed at every place in its postings.
 */
describe.skipIf(!hasDb)("Guards found by the forty-fourth audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A49-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
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

  // The loss case of the audit's probes: the month's end at 2 700 FC, the francs dearer since.
  const lossRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2740", "7.0"], [`${m1}-13`, "2760", "7.0"], [`${m1}-20`, "2780", "7.05"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];

  type Op = [kind: "pay" | "voucher" | "bill" | "reoffload" | "undo" | "reverse", arg: string, day: string];
  /**
   * The month's franc bills (`bills`: that many containers of 1 000 000 FC, by default 1 and 10, on its 4th,
   * 8th and 20th), then `ops` in the next month, the month closed before the `at`-th of them ("reopened":
   * closed first, reopened at once and closed after them all). `pay` from the franc drawer (`voucher` the
   * same by a payment voucher), `bill` offloads a container of that many, `reoffload` the n-th container
   * again, `undo` the n-th payment, `reverse` the n-th bill. What is owed after, closed, and closed again.
   */
  const run = async (ops: Op[], at: number | "reopened", bills: string[]) =>
    withBooks(lossRates(), async (h) => {
      const s = await h.contact(`Fournisseur A49 ${at}`);
      const boxes: number[] = [];
      const pays: number[] = [];
      for (const [i, quantity] of bills.entries()) {
        boxes.push(await h.container(s, "CDF", quantity));
        await h.offload(boxes[i], `${m2}-${["04", "08", "20"][i]}`);
      }
      if (at === "reopened") {
        await h.close(m2);
        await h.reopen(m2);
      }
      for (const [i, [kind, arg, day]] of ops.entries()) {
        if (i === at) await h.close(m2);
        const date = `${m1}-${day}`;
        if (kind === "pay") pays.push((await h.pay(s, arg, date, h.acc("cash_cdf"))).id);
        else if (kind === "voucher") pays.push((await h.voucher(s, arg, date, h.acc("cash_cdf"))).id);
        else if (kind === "bill") {
          const box = await h.container(s, "CDF", arg);
          await h.offload(box, date);
          boxes.push(box);
        } else if (kind === "reoffload") await h.offload(boxes[Number(arg)], date);
        else if (kind === "undo") await h.undo(pays[Number(arg)], date);
        else await h.reverseOn(boxes[Number(arg)], date);
      }
      if (at === ops.length || at === "reopened") await h.close(m2);
      const owed = await h.owed(s, "CDF");
      expect(await h.selfOk(), `${at}`).toEqual([]);
      const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
      await h.reopen(m2);
      await h.close(m2);
      expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${at} closed again`).toBe(closed);
      return owed;
    });
  /** What is owed, closed at every place in `ops` and reopened between, to the cent the rounding of each part leaves. */
  const everywhere = async (name: string, ops: Op[], want: [string, string], bills = ["1", "10"]) => {
    for (const at of [...ops.map((_, i) => i), ops.length, "reopened" as const]) {
      const [native, usd] = await run(ops, at, bills);
      expect(native, `${name} ${at}`).toBe(want[0]);
      expect(Math.abs(Number(usd) - Number(want[1])), `${name} ${at} ${usd}`).toBeLessThan(0.015);
    }
  };

  it("N1: a payment of all owed and more undone after the month's bill it paid was reversed gives back only the share of what it took that the francs coming back owed hold, wherever the close sits", async () => {
    // 12 000 000 FC paid, 20 000 000 FC billed since, the 10 000 000 FC bill reversed, the payment undone: the
    // 1 000 000 FC bill owed again with its share of what the payment took (before, 7 644,51 $ closed after it).
    await everywhere("one payment", [["pay", "12000000", "13"], ["bill", "20", "15"], ["reverse", "1", "22"], ["undo", "0", "25"]], ["-21000000.00", "-7509.70"]);
    // The same by a payment voucher (before, 134,81 $ off).
    await everywhere("by voucher", [["voucher", "12000000", "13"], ["bill", "20", "15"], ["reverse", "1", "22"], ["undo", "0", "25"]], ["-21000000.00", "-7509.70"]);
    // The container offloaded again before the undoing (before, 134,81 $ off).
    await everywhere("offloaded again", [["pay", "12000000", "13"], ["bill", "20", "15"], ["reverse", "1", "22"], ["reoffload", "1", "23"], ["undo", "0", "25"]], ["-31000000.00", "-11079.70"]);
    // A part paid before, the payment of all the rest and more undone (before, 66,85 $ off).
    await everywhere("a part paid before", [["pay", "6000000", "10"], ["pay", "6000000", "13"], ["bill", "20", "15"], ["reverse", "1", "22"], ["undo", "1", "25"]], ["-15000000.00", "-5355.00"]);
  }, 1_800_000);

  it("N1: the same with three bills of the month, or a hundred million francs", async () => {
    // Bills of 1, 10 and 5 containers (before, 138,43 $ off).
    await everywhere("three bills", [["pay", "17000000", "13"], ["bill", "20", "15"], ["reverse", "1", "22"], ["undo", "0", "25"]], ["-26000000.00", "-9359.38"], ["1", "10", "5"]);
    // 100 000 000 FC billed in the month, 200 000 000 FC since (before, 1 337,17 $ off).
    await everywhere("a hundred million", [["pay", "102000000", "13"], ["bill", "200", "13"], ["reverse", "1", "22"], ["undo", "0", "25"]], ["-201000000.00", "-71770.29"], ["1", "100"]);
  }, 1_800_000);

  it("N2: payments undone, the month's bill reversed after, leave the revaluation on the francs still owed as when the month was closed first, a bill since among them", async () => {
    // 20 000 000 FC billed since, 31 000 000 FC paid and undone, 15 000 000 FC paid and undone the same day, the
    // 10 000 000 FC bill reversed (before, 7 579,38 $ closed after the second payment).
    await everywhere("two undone", [["bill", "20", "05"], ["pay", "31000000", "13"], ["undo", "0", "20"], ["pay", "15000000", "20"], ["undo", "1", "20"], ["reverse", "1", "22"]], ["-21000000.00", "-7596.63"]);
    // With no second payment (before, 86,26 $ off).
    await everywhere("one undone", [["bill", "20", "05"], ["pay", "31000000", "13"], ["undo", "0", "20"], ["reverse", "1", "22"]], ["-21000000.00", "-7596.63"]);
    // Paid, billed, undone and paid again the same day (before, 3,55 $).
    await everywhere("paid again", [["pay", "12000000", "13"], ["bill", "20", "13"], ["undo", "0", "13"], ["pay", "12000000", "13"], ["reverse", "1", "22"]], ["-9000000.00", "-3253.56"]);
    // Two payments the same day, both undone (before, 3,09 $).
    await everywhere("both undone", [["pay", "5000000", "13"], ["bill", "20", "13"], ["pay", "7000000", "13"], ["undo", "1", "13"], ["undo", "0", "20"], ["reverse", "1", "22"]], ["-21000000.00", "-7572.08"]);
    // All owed and more, a bill the same day, undone before the reversal (before, 1,11 $).
    await everywhere("undone first", [["pay", "12000000", "13"], ["bill", "20", "13"], ["undo", "0", "20"], ["reverse", "1", "22"]], ["-21000000.00", "-7509.70"]);
  }, 1_800_000);
});
