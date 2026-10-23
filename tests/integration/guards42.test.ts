import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A47: what the forty-second accounting audit found after A46. A payment undone and another posted the
 * same day after it: what closing the month after moved on that day gave the undone payment's share of the
 * revaluation all to the month's bills still owed, none to the bill since the second payment's average cost
 * leaves some on, so a month's bill reversed after took too much of it (N-A: 16,64 $ on 18 000 000 FC, 9,59 $
 * on 36 360 ¥). A month's bill reversed while the month was reopened, after a payment of its bills made with
 * it closed: closing it again left on the balance a share of the revaluation for the francs or yuan that
 * payment paid, which took theirs as they were paid (N-C: 7,29 $, 4,27 $). A payment of all a supplier's
 * francs owed and more (a claim): what closing or reopening the month moves on its day restated the claim,
 * paid for at what was paid, so a bill reversed after (or the payment undone) left it at other dollars than
 * when the month was closed first (N-B: 30,96 $ on 1 733 374 FC, 22,42 $ on 2 000 000 FC, 21,75 $).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the forty-second audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A47-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
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

  it("N-A: a payment undone and another posted after it that day, a month's bill reversed after takes its share of the revaluation as when the month was closed first, wherever the close sits", async () => {
    const cases = {
      // 1 000 000 FC and 10 000 000 FC billed in the month, all paid from the drawer, 20 000 000 FC billed
      // since; the payment undone and 3 000 000 FC paid the same day; the 10 000 000 FC bill reversed.
      // Before, 6 426,00 $ owed when closed after the second payment.
      francs: { currency: "CDF", pay: ["11000000", "3000000"], account: "cash_cdf", owed: ["-18000000.00", "-6442.64"] },
      // 2 000 ¥ and 20 000 ¥ paid in dollars, 40 000 ¥ billed since. Before, 5 121,12 $.
      yuan: { currency: "CNY", pay: ["3142.86", "800"], account: "cash_usd", owed: ["-36360.00", "-5130.71"] },
    } as const;
    for (const [name, c] of Object.entries(cases)) {
      for (const close of [0, 3, 4, 5, "reopened"] as const) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur N-A ${name} ${close}`);
          const currency = c.currency;
          const boxes: number[] = [];
          for (const [i, quantity] of ["1", "10"].entries()) {
            boxes.push(await h.container(s, currency, quantity));
            await h.offload(boxes[i], `${m2}-0${4 + 4 * i}`);
          }
          if (close === 0) await h.close(m2);
          const paid = await h.pay(s, c.pay[0], `${m1}-13`, h.acc(c.account));
          await h.offload(await h.container(s, currency, "20"), `${m1}-15`);
          await h.undo(paid.id, `${m1}-20`);
          if (close === 3) await h.close(m2);
          await h.pay(s, c.pay[1], `${m1}-20`, h.acc(c.account));
          if (close === 4) await h.close(m2);
          if (close === "reopened") {
            await h.close(m2);
            await h.reopen(m2);
          }
          await h.reverseOn(boxes[1], `${m1}-22`);
          if (close === 5 || close === "reopened") await h.close(m2);
          // To the cent the rounding of each part leaves.
          const [native, usd] = await h.owed(s, currency);
          expect(native, `${name} ${close}`).toBe(c.owed[0]);
          expect(Math.abs(Number(usd) - Number(c.owed[1])), `${name} ${close} ${usd}`).toBeLessThan(0.015);
          expect(await h.selfOk(), `${name} ${close}`).toEqual([]);
          const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
          await h.reopen(m2);
          await h.close(m2);
          expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${name} ${close} closed again`).toBe(closed);
        });
      }
    }
  }, 1_200_000);

  it("N-C: a month's bill reversed while it is reopened, after a payment of its bills made with it closed, leaves none of the revaluation that payment took once closed again", async () => {
    const cases = {
      // 5 000 000 FC paid with the month closed, 6 000 000 FC paid and undone, the 10 000 000 FC bill reversed.
      // Before, 5 719,29 $ owed.
      francs: { currency: "CDF", pay: ["5000000", "6000000"], account: "cash_cdf", reversed: 1, owed: ["-16000000.00", "-5712.00"] },
      yuan: { currency: "CNY", pay: ["1500", "1642.86"], account: "cash_usd", reversed: 1, owed: ["-31500.00", "-4436.62"] },
      // The bill the first payment paid off reversed instead: its francs pay the other, which keeps its share.
      "francs, the paid bill reversed": { currency: "CDF", pay: ["5000000", "6000000"], account: "cash_cdf", reversed: 0, owed: ["-25000000.00", "-8991.85"] },
    } as const;
    for (const [name, c] of Object.entries(cases)) {
      for (const reopenAt of [null, 0, 1, 2, 3] as const) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur N-C ${name} ${reopenAt}`);
          const currency = c.currency;
          const boxes: number[] = [];
          for (const [i, quantity] of ["1", "10"].entries()) {
            boxes.push(await h.container(s, currency, quantity));
            await h.offload(boxes[i], `${m2}-0${4 + 4 * i}`);
          }
          await h.close(m2);
          await h.pay(s, c.pay[0], `${m1}-10`, h.acc(c.account));
          if (reopenAt === 0) await h.reopen(m2);
          const second = await h.pay(s, c.pay[1], `${m1}-13`, h.acc(c.account));
          if (reopenAt === 1) await h.reopen(m2);
          await h.offload(await h.container(s, currency, "20"), `${m1}-15`);
          if (reopenAt === 2) await h.reopen(m2);
          await h.undo(second.id, `${m1}-20`);
          if (reopenAt === 3) await h.reopen(m2);
          await h.reverseOn(boxes[c.reversed], `${m1}-22`);
          if (reopenAt !== null) await h.close(m2);
          expect(await h.owed(s, currency), `${name} ${reopenAt}`).toEqual(c.owed);
          expect(await h.selfOk(), `${name} ${reopenAt}`).toEqual([]);
          const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
          await h.reopen(m2);
          await h.close(m2);
          expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${name} ${reopenAt} closed again`).toBe(closed);
        });
      }
    }
  }, 1_200_000);

  it("N-B: a payment of all a supplier's francs owed and more keeps the claim at what was paid, the bill reversed after, wherever the close sits", async () => {
    // 1 234 500 FC billed in the month, 2 000 000 FC paid from the drawer, the bill reversed: the claim is the
    // 2 000 000 FC paid, at what was paid (before, 22,42 $ more with the month closed between them).
    for (const close of [0, 1, 2, "reopened"] as const) {
      await withBooks(lossRates(), async (h) => {
        const s = await h.contact(`Fournisseur N-B ${close}`);
        const box = await h.container(s, "CDF", "1", "1234500");
        await h.offload(box, `${m2}-21`);
        if (close === 0) await h.close(m2);
        await h.pay(s, "2000000", `${m1}-05`, h.acc("cash_cdf"));
        if (close === 1) await h.close(m2);
        if (close === "reopened") {
          await h.close(m2);
          await h.reopen(m2);
        }
        await h.reverseOn(box, `${m1}-17`);
        if (close === 2 || close === "reopened") await h.close(m2);
        expect(await h.owed(s, "CDF"), `${close}`).toEqual(["2000000.00", "729.93"]);
        expect(await h.selfOk(), `${close}`).toEqual([]);
        const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
        await h.reopen(m2);
        await h.close(m2);
        expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${close} closed again`).toBe(closed);
      });
    }
  }, 1_200_000);
});
