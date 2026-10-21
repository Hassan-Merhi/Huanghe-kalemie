import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A43: what the thirty-eighth accounting audit found after A42. A month closed late left the whole
 * revaluation on the francs or yuan still owed, none on the part paid between the month's end and the close
 * (F1); the franc true-up was skipped once a residue line was on the supplier (F2); a franc payment the
 * supplier had refunded since a container was undone could be undone again (F3); employees' francs got the
 * supplier marks in restateSettled but no true-up, so the reopened state kept half a cancelled run's
 * revaluation and the closed state depended on the order (F4); undoing a franc payment dated before its
 * bill, after the container was reversed, cleared the francs-met gap twice (F5).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the thirty-eighth audit", async () => {
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
    const container = async (s: number, currency: "CNY" | "CDF", quantity = "2", unitPrice = currency === "CNY" ? "1000" : "300000") => {
      const product = await must("POST", "/api/products", { name: `Pièce ${n++}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
      const box = await must("POST", "/api/containers", { number: `A43-${n++}`, supplierId: s, locationId, currency, rateToUsd: currency === "CNY" ? "0.140845" : "0.000357", status: "arrived" });
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

  it("F1: a month closed after part of its bill was paid books the same as one closed before: each part paid releases its share of the revaluation", async () => {
    for (const currency of ["CDF", "CNY"] as const) {
      const results: Record<string, string> = {};
      for (const mode of ["late", "early"] as const) {
        await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-13`, "2760", "7.0"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]], async (h) => {
          const s = await h.contact(`Fournisseur F1 ${currency} ${mode}`);
          const box = currency === "CNY" ? await h.container(s, "CNY", "10", "2000") : await h.container(s, "CDF", "10", "1000000");
          await h.offload(box, `${m2}-04`);
          if (mode === "early") await h.close(m2);
          await h.pay(s, "1000", `${m1}-13`);
          await h.pay(s, "1000", `${m1}-18`);
          if (mode === "late") await h.close(m2);
          // What is still owed is at the month-end rate: 4 480 000 FC at 2 700, or 6 000 ¥ at 6,9.
          const [native, usd] = await h.owed(s, currency);
          // (A cent of rounding apart between the two: each part paid after the close leaves at the revalued average cost, to the cent.)
          expect(native, `${currency} ${mode}`).toBe(currency === "CDF" ? "-4480000.00" : "-6000.00");
          expect(Number(usd), `${currency} ${mode}`).toBeCloseTo(currency === "CDF" ? -4480000 / 2700 : -6000 / 6.9, 1);
          if (mode === "late") {
            // Each part released its share: 2 760 000 / 10 000 000 of −133,70 (or 7 000 / 20 000 of −81,65).
            const settled = await h.kindLines(s, "revalued");
            expect(settled, currency).toEqual([]);
            const [r] = await h.db
              .select({ usd: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})::numeric(20,2)::text`, count: sql<number>`count(*)::int` })
              .from(journalLines)
              .innerJoin(journals, eq(journals.id, journalLines.journalId))
              .where(and(eq(journalLines.partyId, s), eq(journals.sourceType, "period_settled")));
            expect([r.count, r.usd], currency).toEqual([2, currency === "CDF" ? "73.80" : "57.16"]);
          }
          expect(await h.selfOk(), `${currency} ${mode}`).toEqual([]);
          // The manager pays the dollars shown: the advance beyond is only the rate's move since the month's end.
          await h.pay(s, String(-Number(usd)), `${m1}-26`);
          expect(await h.owed(s, currency), `${currency} ${mode}`).toEqual(["0.00", "0.00"]);
          const [, advance] = await h.owed(s, "USD");
          expect(Number(advance), `${currency} ${mode}`).toBeCloseTo(currency === "CDF" ? 4480000 / 2700 - 4480000 / 2750 : 6000 / 6.9 - 6000 / 7, 1);
          await h.close(m1);
          expect(await h.selfOk(), `${currency} ${mode}`).toEqual([]);
          const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
          await h.reopen(m1);
          await h.reopen(m2);
          expect(await h.selfOk(), `${currency} ${mode} reopened`).toEqual([]);
          await h.close(m2);
          await h.close(m1);
          expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${currency} ${mode} closed again`).toBe(closed);
          results[mode] = `${await h.owed(s, currency)} ${await h.owed(s, "USD")} fx ${await h.fxBooked()}`;
        });
      }
      const [late, early] = [results.late, results.early].map((r) => r.replace(/-?\d+\.\d\d/g, (x) => x.slice(0, -1)));
      expect(late, currency).toBe(early);
    }
  });

  it("F1: a part payment made before the close, undone after it, brings its share of the revaluation back; the claim after the bills are reversed is what was paid", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2800", "7.3"], [`${m1}-02`, "2800", "7.2"], [today, "2800", "7.2"]], async (h) => {
      const s = await h.contact("Fournisseur F1 annulé");
      const b1 = await h.container(s, "CNY", "1");
      const b2 = await h.container(s, "CNY", "3");
      await h.offload(b1, `${m2}-10`);
      await h.offload(b2, `${m2}-12`);
      const first = await h.pay(s, "200", `${m1}-02`);
      await h.close(m2);
      // 1 440 of 4 000 ¥ paid before the close: 1 440 / 4 000 of the 15,44 gain released.
      expect(await h.owed(s, "CNY")).toEqual(["-2560.00", "-350.69"]);
      await h.pay(s, "100", `${m1}-05`);
      expect((await h.undo(first.id, `${m1}-07`)).status).toBe(200);
      // The 1 440 ¥ owed again carry their part of the revaluation once more: 3 280 ¥ at their cost less
      // 3 280 / 4 000 of the gain (461,97 − 12,66, a cent of rounding from the 720 ¥ paid at average cost).
      expect(await h.owed(s, "CNY")).toEqual(["-3280.00", "-449.32"]);
      expect(await h.selfOk()).toEqual([]);
      await h.pay(s, "150", `${m1}-08`);
      await h.reverseOn(b1, today);
      await h.reverseOn(b2, today);
      // 1 800 ¥ claimed back at the 250 $ paid, closed or reopened, and closing again books the same.
      expect(await h.owed(s, "CNY")).toEqual(["1800.00", "250.00"]);
      expect(await h.selfOk()).toEqual([]);
      const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
      await h.reopen(m2);
      expect(await h.owed(s, "CNY")).toEqual(["1800.00", "250.00"]);
      expect(await h.fxBooked()).toBe("0.00");
      expect(await h.selfOk()).toEqual([]);
      await h.close(m2);
      expect(`${await h.trial()} fx ${await h.fxBooked()}`).toBe(closed);
    });
  });

  it("F1: a supplier's franc claim refunded in part with the month closed, then reopened: what is left is at what was paid, and refunding it leaves nothing", async () => {
    for (const mode of ["refunded closed", "refunded before the close"] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2760", "7.0"], [today, "2740", "7.0"]], async (h) => {
        const s = await h.contact(`Fournisseur F1 créance ${mode}`);
        const box = await h.container(s, "CDF", "2", "300000");
        await h.offload(box, `${m2}-10`);
        await h.pay(s, "600000", `${m2}-12`, h.acc("cash_cdf"));
        await h.reverseOn(box, `${m2}-20`);
        // 600 000 FC claimed back at what the drawer paid for them.
        const [, paid] = await h.owed(s, "CDF");
        if (mode === "refunded closed") await h.close(m2);
        const refund = await h.call("POST", "/api/vouchers/receipt", { date: `${m1}-05`, accountId: h.acc("cash_cdf"), lines: [{ partyId: s, amount: "300000" }] }, "gerant");
        expect(refund.status, mode).toBe(201);
        if (mode === "refunded before the close") await h.close(m2);
        // Closed: the 300 000 FC left at the month-end rate, whichever came first.
        expect(await h.owed(s, "CDF"), mode).toEqual(["300000.00", cents(300000 / 2700)]);
        expect(await h.selfOk(), mode).toEqual([]);
        await h.reopen(m2);
        // Reopened: half of what was paid, with no revaluation left on it.
        const [left, usd] = await h.owed(s, "CDF");
        expect(left, mode).toBe("300000.00");
        expect(Number(usd), mode).toBeCloseTo(Number(paid) / 2, 1);
        expect(await h.selfOk(), `${mode} reopened`).toEqual([]);
        await h.call("POST", "/api/vouchers/receipt", { date: `${m1}-06`, accountId: h.acc("cash_cdf"), lines: [{ partyId: s, amount: "300000" }] }, "gerant").then((r) => expect(r.status, mode).toBe(201));
        expect(await h.owed(s, "CDF"), mode).toEqual(["0.00", "0.00"]);
        expect(await h.owed(s, "USD"), mode).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk(), mode).toEqual([]);
      });
    }
  });

  it("F2: a franc bill paid to the franc, a residue cleared, then reversed after the close: the claim carries the takeback, as with no residue", async () => {
    for (const [label, quantity, unitPrice] of [["residue", "1", "5003413"], ["fractional", "3", "1667804.33"]] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-10`, "2760", "7.0"], [`${m1}-20`, "2750", "7.0"], [today, "2740", "7.0"]], async (h) => {
        const s = await h.contact(`Fournisseur F2 ${label}`);
        const box = await h.container(s, "CDF", quantity, unitPrice);
        await h.offload(box, `${m2}-16`);
        await h.close(m2);
        // 13 FC (or 12,99) are left, worth under half a cent: cleared with the payment.
        await h.pay(s, "5003400", `${m1}-10`, h.acc("cash_cdf"));
        expect(await h.owed(s, "CDF"), label).toEqual(["0.00", "0.00"]);
        expect((await h.kindLines(s, "residue")).length, label).toBe(1);
        await h.reverseOn(box, `${m1}-20`);
        // The francs come back as a claim at the day's rate (what the francs are worth), not at the bill's own dollars.
        const [claim, usd] = await h.owed(s, "CDF");
        expect(claim, label).toBe(label === "residue" ? "5003413.00" : "5003412.99");
        expect(usd, label).toBe(cents(Number(claim) / 2760));
        expect(await h.kindLines(s, "settled_fx"), label).toEqual([["container_reversal", "26.61"]]);
        expect(await h.selfOk(), label).toEqual([]);
        await h.reopen(m2);
        expect(await h.selfOk(), `${label} reopened`).toEqual([]);
        await h.close(m2);
        expect(await h.owed(s, "CDF"), `${label} closed again`).toEqual([claim, usd]);
      });
    }
  });

  it("F3: undoing a franc payment the supplier has refunded since a container was undone is refused, as a yuan one is", async () => {
    for (const mode of ["francs", "dollars-paid", "dollars-refunded"] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m1}-10`, "2760", "7.0"], [today, "2740", "7.0"]], async (h) => {
        const s = await h.contact(`Fournisseur F3 ${mode}`);
        const box = await h.container(s, "CDF", "1", "300000");
        await h.offload(box, `${m2}-16`);
        const p = mode === "dollars-paid" ? await h.pay(s, "107.14", `${m2}-20`) : await h.pay(s, "300000", `${m2}-20`, h.acc("cash_cdf"));
        expect(await h.owed(s, "CDF"), mode).toEqual(["0.00", "0.00"]);
        await h.reverseOn(box, `${m1}-10`);
        const [claim, usd] = await h.owed(s, "CDF");
        expect(claim, mode).toBe("300000.00");
        const refund =
          mode === "dollars-refunded"
            ? await h.call("POST", "/api/vouchers/receipt", { date: `${m1}-12`, accountId: h.acc("cash_usd"), lines: [{ partyId: s, amount: usd }] }, "gerant")
            : await h.call("POST", "/api/vouchers/receipt", { date: `${m1}-12`, accountId: h.acc("cash_cdf"), lines: [{ partyId: s, amount: "300000" }] }, "gerant");
        expect(refund.status, mode).toBe(201);
        const r = await h.undo(p.id, `${m1}-15`);
        expect(r.status, mode).toBe(409);
        expect(r.body.message, mode).toMatch(/^The supplier has refunded [\d.]+ FC of this payment's francs since a container was undone\. Undo that refund first/);
        expect(r.body.messageFr, mode).toMatch(/^Le fournisseur a remboursé [\d\s]+FC des francs de ce paiement depuis l'annulation d'un conteneur\. Annulez d'abord ce remboursement/);
        // The refund undone first, the payment can be: the francs are owed again as the bill booked them.
        expect((await h.undo(refund.body.id, `${m1}-15`)).status, mode).toBe(200);
        expect((await h.undo(p.id, `${m1}-16`)).status, mode).toBe(200);
        expect(await h.owed(s, "CDF"), mode).toEqual(["0.00", "0.00"]);
        expect(await h.selfOk(), mode).toEqual([]);
      });
    }
  });

  it("F4: an employee's run cancelled after the close: the closed state is the same cancelled closed or reopened, and reopening leaves the francs at cost", async () => {
    const rates: [string, string, string][] = [[`${m3}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-10`, "2760", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];
    const results: Record<string, string> = {};
    for (const mode of ["closed", "reopened"] as const) {
      await withBooks(rates, async (h) => {
        const e = await h.contact(`Employé F4 ${mode}`, "employee");
        const salaryAcc = (await h.must("GET", "/api/payroll")).salaryAccountId;
        await h.must("POST", "/api/payroll/runs", { month: m3, date: m3End, accountId: salaryAcc, currency: "CDF", lines: [{ partyId: e, salary: "1000000" }] }, "gerant");
        await h.must("POST", "/api/payroll/runs", { month: m2, date: m2End, accountId: salaryAcc, currency: "CDF", lines: [{ partyId: e, salary: "1000000" }] }, "gerant");
        await h.close(m3);
        await h.close(m2);
        expect(await h.owed(e, "CDF")).toEqual(["-2000000.00", `-${cents(2000000 / 2700)}`]);
        if (mode === "reopened") await h.reopen(m2);
        await h.must("POST", `/api/payroll/runs/${m3}/cancel`, { date: `${m1}-05` }, "gerant");
        if (mode === "reopened") await h.close(m2);
        // Employees keep the rules from before A42 (no supplier marks): the 1 000 000 FC left keep the month's
        // −13,23 revaluation, whichever order the run was cancelled and the month reopened in.
        expect(await h.owed(e, "CDF"), mode).toEqual(["-1000000.00", `-${cents(1000000 / 2700 + 13.23)}`]);
        expect(await h.selfOk(), mode).toEqual([]);
        const closed = `${await h.trial()} fx ${await h.fxBooked()}`;
        await h.reopen(m2);
        await h.reopen(m3);
        // Reopened, nothing of the revaluation: the francs at what the run booked them.
        expect(await h.owed(e, "CDF"), `${mode} reopened`).toEqual(["-1000000.00", `-${cents(1000000 / 2700)}`]);
        expect(await h.fxBooked(), `${mode} reopened`).toBe("0.00");
        expect(await h.selfOk(), `${mode} reopened`).toEqual([]);
        await h.close(m3);
        await h.close(m2);
        expect(`${await h.trial()} fx ${await h.fxBooked()}`, `${mode} closed again`).toBe(closed);
        results[mode] = `${await h.owed(e, "CDF")} fx ${await h.fxBooked()}`;
      });
    }
    expect(results.reopened).toBe(results.closed);
  });

  it("F5: a franc payment dated before its bill, undone after the container was reversed, leaves no dollars on no francs", async () => {
    for (const mode of ["one bill", "two bills"] as const) {
      await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m1}-03`, "2770", "7.0"], [`${m1}-08`, "2810", "7.0"], [`${m1}-20`, "2790", "7.0"], [today, "2800", "7.0"]], async (h) => {
        const s = await h.contact(`Fournisseur F5 ${mode}`);
        const box = await h.container(s, "CDF", "1", "5003400");
        await h.offload(box, `${m1}-08`);
        if (mode === "two bills") await h.offload(await h.container(s, "CDF", "1", "300000"), `${m1}-09`);
        // Paid dated before the bill, posted after it: the francs-met journal books the cost gap.
        const p = await h.pay(s, "5003400", `${m1}-03`, h.acc("cash_cdf"));
        expect(await h.owed(s, "CDF"), mode).toEqual(mode === "one bill" ? ["0.00", "0.00"] : ["-300000.00", "-107.10"]);
        await h.reverseOn(box, `${m1}-20`);
        expect((await h.undo(p.id, today)).status, mode).toBe(200);
        expect(await h.owed(s, "CDF"), mode).toEqual(mode === "one bill" ? ["0.00", "0.00"] : ["-300000.00", "-107.10"]);
        expect(await h.owed(s, "USD"), mode).toEqual(["0.00", "0.00"]);
        expect(await h.kindLines(s, "revalued"), mode).toEqual([]);
        expect(await h.fxBooked(), mode).toBe("0.00");
        expect(await h.selfOk(), mode).toEqual([]);
      });
    }
  });
});
