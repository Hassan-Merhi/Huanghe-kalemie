import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A46: what the forty-first accounting audit found after A45. A month closed after a payment of its
 * bills, the payment undone once a bill since was owed: what the close moved on the day of the undoing (the
 * revaluation the payment took, given back) restated the bill since too, which holds none of it, so a month's
 * bill reversed after took too little of the revaluation with it (N1: 86,26 $ on 21 000 000 FC, 52,68 $ on
 * 42 000 ¥, as against the month closed first), and the bills left owed too much. A month's bills paid off
 * before its close, what a part of the bills since paid before it took of the revaluation was left on what
 * was owed once closed (N2, the close-order class: 2,88 $ here on 2 600 ¥).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the forty-first audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A46-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
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
  const withBooks = async (rates: [string, string, string][], f: (h: Books) => Promise<void>) => {
    const h = await books(rates);
    try {
      await f(h);
    } finally {
      h.server.close();
    }
  };

  // The loss case of the audit's probes: the month's end at 2 700 FC (6,9 ¥), the francs and yuan dearer since.
  const lossRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2740", "7.0"], [`${m1}-13`, "2760", "7.0"], [`${m1}-20`, "2780", "7.05"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];

  it("N1: a month's bill reversed after a payment of it was undone with a bill since owed takes its whole share of the revaluation, wherever the month's close sits", async () => {
    const cases = {
      // 1 000 000 FC and 10 000 000 FC billed in the month, all paid from the drawer, 20 000 000 FC billed
      // since; the 10 000 000 FC bill reversed. Before, 7 596,63 $ owed when closed after the payment.
      francs: { currency: "CDF", bills: ["1", "10"], pay: ["11000000", "cash_cdf"], since: "20", owed: ["-21000000.00", "-7510.37"], reopened: ["-21000000.00", "-7497.00"] },
      // Ten times the francs of the smaller bill: the audit's g4 (before, 4 286,06 $ owed reopened).
      "francs, the small bill reversed": { currency: "CDF", bills: ["10", "1"], pay: ["11000000", "cash_cdf"], since: "2", owed: ["-12000000.00", "-4417.70"], reopened: ["-12000000.00", "-4284.00"] },
      // Part of them paid (5 000 000 FC): the undoing gives back the share the payment took to the francs
      // that come back owed. Before, 5,14 $ off.
      "francs, part paid": { currency: "CDF", bills: ["10", "1"], pay: ["5000000", "cash_cdf"], since: "2", owed: ["-12000000.00", "-4417.70"], reopened: ["-12000000.00", "-4284.00"] },
      // 2 000 ¥ and 20 000 ¥ paid in dollars, 40 000 ¥ billed since. Before, 5 976,34 $.
      yuan: { currency: "CNY", bills: ["1", "10"], pay: ["3142.86", "cash_usd"], since: "20", owed: ["-42000.00", "-5923.66"], reopened: ["-42000.00", "-5915.49"] },
    } as const;
    for (const [name, c] of Object.entries(cases)) {
      const results: string[] = [];
      for (const close of [0, 1, 2, 3, 4, "reopened"] as const) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur N1 ${name} ${close}`);
          const currency = c.currency;
          const boxes: number[] = [];
          for (const [i, quantity] of c.bills.entries()) {
            boxes.push(await h.container(s, currency, quantity));
            await h.offload(boxes[i], `${m2}-0${4 + 4 * i}`);
          }
          if (close === 0) await h.close(m2);
          if (close === "reopened") {
            await h.close(m2);
            await h.reopen(m2);
          }
          const paid = await h.pay(s, c.pay[0], `${m1}-13`, h.acc(c.pay[1]));
          if (close === 1) await h.close(m2);
          await h.offload(await h.container(s, currency, c.since), `${m1}-15`);
          if (close === 2) await h.close(m2);
          await h.undo(paid.id, `${m1}-20`);
          if (close === 3) await h.close(m2);
          await h.reverseOn(boxes[1], `${m1}-22`);
          if (close === 4 || close === "reopened") await h.close(m2);
          // As closed first: the bills left owed at their share of the month-end rate, the bill since at its own.
          expect(await h.owed(s, currency), `${name} ${close}`).toEqual(c.owed);
          expect(await h.selfOk(), `${name} ${close}`).toEqual([]);
          const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
          await h.reopen(m2);
          expect(await h.owed(s, currency), `${name} ${close} reopened`).toEqual(c.reopened);
          await h.close(m2);
          expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${name} ${close} closed again`).toBe(closed);
          results.push(closed);
        });
      }
      expect(new Set(results).size, name).toBe(1);
    }
  }, 1_200_000);

  it("N2: a month's yuan or francs paid off before its close, a part of the bills since paid after keeps its share of the revaluation, wherever the close sits", async () => {
    for (const currency of ["CNY", "CDF"] as const) {
      const owed: number[] = [];
      for (const close of [0, 1, 2, "reopened"] as const) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur N2 ${currency} ${close}`);
          await h.offload(await h.container(s, currency, "2"), `${m2}-04`);
          if (close === 0) await h.close(m2);
          if (close === "reopened") {
            await h.close(m2);
            await h.reopen(m2);
          }
          await h.offload(await h.container(s, currency, "2"), `${m1}-05`);
          // The month's bill paid off with part of the bill since, then part of what is left of it.
          await h.pay(s, currency === "CNY" ? "800" : "1000", `${m1}-13`);
          if (close === 1) await h.close(m2);
          await h.pay(s, currency === "CNY" ? "200" : "300", `${m1}-20`);
          if (close === 2 || close === "reopened") await h.close(m2);
          expect(await h.selfOk(), `${currency} ${close}`).toEqual([]);
          const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
          await h.reopen(m2);
          await h.close(m2);
          expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${currency} ${close} closed again`).toBe(closed);
          owed.push(Number((await h.owed(s, currency))[1]));
        });
      }
      // The same dollars owed, to the cent the rounding of each part leaves (before, closed after the
      // payments, the second left the revaluation it took on what is owed: 5,58 $ here in francs).
      expect(Math.max(...owed) - Math.min(...owed), `${currency} ${owed}`).toBeLessThan(0.015);
    }
  }, 600_000);
});
