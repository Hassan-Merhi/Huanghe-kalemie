import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A48: what the forty-third accounting audit found after A47. What closing or reopening a month moves on a
 * balance settled since its end was handed to the francs it belongs to by what was replayed next to it, and
 * francs are replayed by date: a bill, a payment or an undoing posted the same day in between gave it to other
 * francs. A payment of all a supplier's francs owed and more with a bill posted the same day, the month closed
 * after both: the month's bill reversed after took 69,66 $ of the revaluation onto the bill since (M1; 38,00 $
 * paid in two parts, 65,36 $ with a bill reversed the same day). A payment undone that had also paid a bill
 * since, another posted after it, the month's bill reversed, then the month closed: the revaluation the bill
 * since carries from that second payment's average cost stayed on it in full (M2: 47,44 $; 28,98 $ in yuan). A
 * payment of all owed and more, undone, after another payment of part of the month's bills: its share of the
 * revaluation was not given back (M3: 6,08 $), and with a payment after the undoing undone the same day, 35,65 $.
 * Now each line says which posting it restates (journal_lines.restates_journal_id), and the francs are replayed
 * with it right after that posting. Each case on its own books, closed at every place in its postings.
 */
describe.skipIf(!hasDb)("Guards found by the forty-third audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A48-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
      await must("PUT", `/api/containers/${box.id}/lines`, { lines: [{ variantId: product.variants[0].id, quantity, unitPrice }] });
      return box.id as number;
    };
    const offload = (box: number, offloadDate: string) => must("POST", `/api/containers/${box}/finalize`, { offloadDate });
    const reverseOn = (box: number, date: string) => must("POST", `/api/containers/${box}/reverse`, { date });
    const pay = (s: number, amount: string, date: string, accountId = acc("cash_usd"), who = "gerant") => must("POST", "/api/money/party-payment", { date, partyId: s, accountId, amount }, who);
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
    return { db, server, call, must, acc, contact, owed, container, offload, reverseOn, pay, undo, close, reopen, selfOk, fxBooked, kindLines, trial };
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

  // The loss case of the audit's probes: the month's end at 2 700 FC (6,9 ¥), the francs and yuan dearer since.
  const lossRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2740", "7.0"], [`${m1}-13`, "2760", "7.0"], [`${m1}-20`, "2780", "7.05"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];

  type Op = [kind: "pay" | "bill" | "undo" | "reverse", arg: string, day: string];
  /**
   * The month's bills (1 and 10 containers of 1 000 000 FC, or 2 000 ¥, on its 4th and 8th), then `ops` in
   * the next month, the month closed before the `at`-th of them ("reopened": closed first, reopened at once and
   * closed after them all). `pay` from the franc drawer (yuan: in dollars), `bill` offloads a container of that
   * many, `undo` the n-th payment, `reverse` the n-th bill. What is owed after, closed, and closed again.
   */
  const run = async (currency: "CDF" | "CNY", ops: Op[], at: number | "reopened") =>
    withBooks(lossRates(), async (h) => {
      const s = await h.contact(`Fournisseur A48 ${currency} ${at}`);
      const boxes: number[] = [];
      const pays: number[] = [];
      for (const [i, quantity] of ["1", "10"].entries()) {
        boxes.push(await h.container(s, currency, quantity));
        await h.offload(boxes[i], `${m2}-0${4 + 4 * i}`);
      }
      if (at === "reopened") {
        await h.close(m2);
        await h.reopen(m2);
      }
      for (const [i, [kind, arg, day]] of ops.entries()) {
        if (i === at) await h.close(m2);
        const date = `${m1}-${day}`;
        if (kind === "pay") pays.push((await h.pay(s, arg, date, h.acc(currency === "CDF" ? "cash_cdf" : "cash_usd"))).id);
        else if (kind === "bill") {
          const box = await h.container(s, currency, arg);
          await h.offload(box, date);
          boxes.push(box);
        } else if (kind === "undo") await h.undo(pays[Number(arg)], date);
        else await h.reverseOn(boxes[Number(arg)], date);
      }
      if (at === ops.length || at === "reopened") await h.close(m2);
      const owed = await h.owed(s, currency);
      expect(await h.selfOk(), `${at}`).toEqual([]);
      const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
      await h.reopen(m2);
      await h.close(m2);
      expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${at} closed again`).toBe(closed);
      return owed;
    });
  /** What is owed, closed at every place in `ops` and reopened between, to the cent the rounding of each part leaves. */
  const everywhere = async (name: string, currency: "CDF" | "CNY", ops: Op[], want: [string, string]) => {
    for (const at of [...ops.map((_, i) => i), ops.length, "reopened" as const]) {
      const [native, usd] = await run(currency, ops, at);
      expect(native, `${name} ${at}`).toBe(want[0]);
      expect(Math.abs(Number(usd) - Number(want[1])), `${name} ${at} ${usd}`).toBeLessThan(0.015);
    }
  };

  it("M1: a payment of all owed and more with a bill posted the same day, the month's bill reversed after keeps the revaluation off the bill since, wherever the close sits", async () => {
    // 12 000 000 FC paid, 20 000 000 FC billed that day, the 10 000 000 FC bill reversed: 9 000 000 FC of the bill
    // since at its own dollars (before, 3 143,34 $ closed after the bill).
    await everywhere("one payment", "CDF", [["pay", "12000000", "13"], ["bill", "20", "13"], ["reverse", "1", "22"]], ["-9000000.00", "-3213.00"]);
    // In two parts (before, 3 175,00 $).
    await everywhere("two payments", "CDF", [["pay", "5000000", "10"], ["pay", "7000000", "13"], ["bill", "20", "13"], ["reverse", "1", "22"]], ["-9000000.00", "-3213.00"]);
    // The 1 000 000 FC bill reversed the same day as the payment, before the bill since (before, 2 790,64 $).
    await everywhere("a bill reversed that day", "CDF", [["pay", "12000000", "13"], ["reverse", "0", "13"], ["bill", "20", "13"], ["reverse", "1", "22"]], ["-8000000.00", "-2856.00"]);
  }, 1_800_000);

  it("M2: a payment undone that also paid a bill since, another posted after it, the month's bill reversed: the bill since keeps the share of the revaluation as when the month was closed first", async () => {
    // 31 000 000 FC paid (the 20 000 000 FC bill since among them), undone, 15 000 000 FC paid that day, the
    // 10 000 000 FC bill reversed (before, 2 217,91 $ closed last).
    await everywhere("francs", "CDF", [["bill", "20", "05"], ["pay", "31000000", "13"], ["undo", "0", "20"], ["pay", "15000000", "20"], ["reverse", "1", "22"]], ["-6000000.00", "-2170.47"]);
    // 62 000 ¥ in dollars, undone, 4 000 $ paid that day (before, 28,98 $ more).
    await everywhere("yuan", "CNY", [["bill", "20", "05"], ["pay", "8857.14", "13"], ["undo", "0", "20"], ["pay", "4000", "20"], ["reverse", "1", "22"]], ["-13800.00", "-1963.65"]);
  }, 1_800_000);

  it("M3: payments undone the same day give back what they took of the revaluation, a payment of all owed and more among them, wherever the close sits", async () => {
    // 11 000 000 FC paid, undone, 3 000 000 FC paid and undone that day, the 10 000 000 FC bill reversed: the
    // 1 000 000 FC bill owed with its share (before, 406,02 $ closed before the reversal).
    await everywhere("after the undoing", "CDF", [["pay", "11000000", "13"], ["undo", "0", "20"], ["pay", "3000000", "20"], ["undo", "1", "20"], ["reverse", "1", "22"]], ["-1000000.00", "-370.37"]);
    // Two payments of 6 000 000 FC the same day, the second paying all owed and more, a bill since, both undone,
    // the 10 000 000 FC bill reversed (before, 7 504,29 $ closed last).
    await everywhere("two the same day", "CDF", [["pay", "6000000", "13"], ["pay", "6000000", "13"], ["bill", "20", "15"], ["undo", "1", "20"], ["undo", "0", "20"], ["reverse", "1", "22"]], ["-21000000.00", "-7510.37"]);
  }, 1_800_000);

  it("what closing a month moves on a balance settled since says which posting it restates", async () => {
    await withBooks(lossRates(), async (h) => {
      const s = await h.contact("Fournisseur A48 lien");
      const box = await h.container(s, "CDF", "10");
      await h.offload(box, `${m2}-08`);
      const paid = await h.pay(s, "12000000", `${m1}-13`, h.acc("cash_cdf"));
      await h.offload(await h.container(s, "CDF", "20"), `${m1}-13`);
      await h.close(m2);
      const rows = await h.db
        .select({ restates: journalLines.restatesJournalId, source: journals.sourceType })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .where(and(eq(journalLines.partyId, s), eq(journals.sourceType, "period_settled")));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.restates).toBe(paid.id);
    });
  }, 600_000);
});
