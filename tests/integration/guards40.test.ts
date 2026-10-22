import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals } from "@shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";

/**
 * Phase A45: what the fortieth accounting audit found after A44. The franc pool replays a supplier's francs
 * by date, so a month reopened after a bill's reversal undid its revaluation before that reversal, while the
 * reversal had already moved the bill's share of it to exchange differences and the reopening put it back
 * after: an unrelated undoing later booked that share a second time (G2), and two months closed in another
 * order booked another amount (G3). A payment that emptied the francs or yuan owed, undone once a bill since
 * was owed, gave back none of the month's revaluation it took (G1). A balance could be left at no francs with
 * dollars on it after a bill booked dated back or a payment of a cent (G4).
 * Each case on its own books, as each needs its own rates.
 */
describe.skipIf(!hasDb)("Guards found by the fortieth audit", async () => {
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
      const box = await must("POST", "/api/containers", { number: `A45-${n++}`, supplierId: s, locationId, currency, rateToUsd, status: "arrived" });
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

  it("G2: a month reopened after a bill's reversal, then a payment undone: the bill left owed keeps its own dollars, and closing again books as never reopened", async () => {
    // The audit's case: 5 000 000 FC and 333 300 FC billed in m3, m3 closed, the big bill reversed in m2.
    const rates: [string, string, string][] = [[`${m3}-01`, "2800", "7.1"], [`${m3}-18`, "2797", "7.1"], [`${m3}-24`, "2805", "7.1"], [m3End, "2898", "7.35"], [`${m2}-27`, "2890", "7.3"], [m2End, "2940", "7.4"], [`${m1}-08`, "2805", "7.1"], [`${m1}-24`, "2930", "7.38"], [today, "2848", "7.2"]];
    const results: Record<string, string> = {};
    for (const mode of ["never reopened", "reopened", "both months reopened"] as const) {
      await withBooks(rates, async (h) => {
        const s = await h.contact(`Fournisseur G2 ${mode}`);
        const big = await h.container(s, "CDF", "5", "1000000", (1 / 2797).toFixed(8));
        const small = await h.container(s, "CDF", "1", "333300", (1 / 2805).toFixed(8));
        await h.offload(big, `${m3}-18`);
        await h.offload(small, `${m3}-24`);
        await h.close(m3);
        await h.reverseOn(big, `${m2}-27`);
        if (mode === "both months reopened") {
          await h.close(m2);
          await h.reopen(m2);
        }
        if (mode !== "never reopened") {
          await h.reopen(m3);
          // Reopened, the bill left owed is at its own dollars.
          expect(await h.owed(s, "CDF"), mode).toEqual(["-333300.00", "-118.82"]);
        }
        const paid = await h.pay(s, "99.99", `${m1}-08`);
        await h.undo(paid.id, `${m1}-24`);
        // The undoing gives the payment's francs back as they left, and moves nothing else: before, 62,00 $ of
        // the big bill's share of the revaluation, which its reversal had already taken, went to exchange
        // differences again.
        expect(await h.kindLines(s, "settled_fx"), mode).toEqual([["container_reversal", "-62.00"]]);
        if (mode !== "never reopened") {
          expect(await h.owed(s, "CDF"), mode).toEqual(["-333300.00", "-118.82"]);
          await h.close(m3);
        }
        // Closed, the small bill keeps its share of the revaluation: 118,82 $ less 4,13 $.
        expect(await h.owed(s, "CDF"), mode).toEqual(["-333300.00", "-114.69"]);
        expect(await h.selfOk(), mode).toEqual([]);
        results[mode] = `${await h.trial()} fx ${await h.fxBooked()}`;
      });
    }
    expect(results.reopened).toBe(results["never reopened"]);
    expect(results["both months reopened"]).toBe(results["never reopened"]);
  }, 300_000);

  it("G2/G3: francs paid and undone after a bill's reversal and two months closed give back exactly what they took, whatever the order of the closes", async () => {
    const rates: [string, string, string][] = [[`${m3}-01`, "2800", "7.1"], [m3End, "2700", "6.9"], [`${m2}-13`, "2760", "7.0"], [`${m2}-20`, "2780", "7.05"], [m2End, "2650", "6.8"], [`${m1}-05`, "2660", "6.85"], [`${m1}-10`, "2690", "6.9"], [`${m1}-18`, "2720", "6.95"], [m1End, "2600", "6.7"], [today, "2740", "7.0"]];
    // Where the closes (C3, C2) and the reopenings (R2, R3) sit among the postings.
    const plans = {
      "closed first": ["C3", "pay", "C2", "rev", "fc", "undo"],
      "closed after the reversal": ["pay", "rev", "C3", "C2", "fc", "undo"],
      "closed last": ["pay", "rev", "fc", "undo", "C3", "C2"],
      "closed between": ["pay", "C3", "rev", "fc", "C2", "undo"],
      "both reopened": ["C3", "pay", "C2", "rev", "R2", "R3", "fc", "undo", "C3", "C2"],
    } as const;
    const results: Record<string, string> = {};
    for (const [mode, plan] of Object.entries(plans)) {
      for (const scale of [1, 10]) {
        await withBooks(rates, async (h) => {
          const s = await h.contact(`Fournisseur G3 ${mode} ${scale}`);
          const big = await h.container(s, "CDF", String(10 * scale));
          const small = await h.container(s, "CDF", String(2 * scale));
          await h.offload(big, `${m3}-04`);
          await h.offload(small, `${m3}-06`);
          let paid: { id: number } | null = null;
          for (const step of plan) {
            if (step === "C3") await h.close(m3);
            else if (step === "C2") await h.close(m2);
            else if (step === "R3") await h.reopen(m3);
            else if (step === "R2") await h.reopen(m2);
            else if (step === "pay") await h.pay(s, String(1000 * scale), `${m2}-13`);
            else if (step === "rev") await h.reverseOn(small, `${m1}-05`);
            else if (step === "fc") paid = await h.pay(s, String(2000000 * scale), `${m1}-10`, h.acc("cash_cdf"));
            else await h.undo(paid!.id, `${m1}-18`);
          }
          // As closed first: 7 240 000 FC at 2 732,07 $ (before, 2 691,35 $ to 2 772,79 $, by the order).
          expect(await h.owed(s, "CDF"), `${mode} ${scale}`).toEqual(scale === 1 ? ["-7240000.00", "-2732.07"] : ["-72400000.00", "-27320.75"]);
          // The undoing moved no exchange difference of its own.
          expect((await h.kindLines(s, "settled_fx")).filter(([type]) => type === "reversal"), `${mode} ${scale}`).toEqual([]);
          expect(await h.selfOk(), `${mode} ${scale}`).toEqual([]);
          results[`${mode} ${scale}`] = `${await h.owed(s, "CDF")} fx ${await h.fxBooked()}`;
        });
      }
    }
    for (const scale of [1, 10]) {
      const ref = results[`closed first ${scale}`];
      for (const mode of Object.keys(plans)) expect(results[`${mode} ${scale}`], `${mode} ${scale}`).toBe(ref);
    }
  }, 600_000);

  // The loss case of the audit's probes: the month's end at 2 700 FC (6,9 ¥), the francs and yuan dearer since.
  const lossRates = (): [string, string, string][] => [[`${m2}-01`, "2800", "7.1"], [m2End, "2700", "6.9"], [`${m1}-05`, "2740", "7.0"], [`${m1}-13`, "2760", "7.0"], [`${m1}-20`, "2780", "7.05"], [`${m1}-26`, "2750", "7.0"], [m1End, "2720", "7.0"], [today, "2740", "7.0"]];

  it("G1: a payment that emptied the month's bill, undone after a bill since, gives back the revaluation it took, wherever the month's close sits", async () => {
    const cases = {
      // 10 000 000 FC paid from the drawer; a bill since of 2 000 000 FC (714 $).
      francs: { currency: "CDF", pay: ["10000000", "cash_cdf"], owed: ["-12000000.00", "-4417.70"], reopened: ["-12000000.00", "-4284.00"], since: false },
      // The same paid in dollars.
      dollars: { currency: "CDF", pay: ["3623.19", "cash_usd"], owed: ["-12000000.00", "-4417.70"], reopened: ["-12000000.00", "-4284.00"], since: false },
      // 20 000 ¥ paid in dollars; a bill since of 4 000 ¥.
      yuan: { currency: "CNY", pay: ["2857.14", "cash_usd"], owed: ["-24000.00", "-3461.93"], reopened: ["-24000.00", "-3380.28"], since: false },
      // The bill since reversed before the undoing.
      "bill since reversed": { currency: "CDF", pay: ["10000000", "cash_cdf"], owed: ["-10000000.00", "-3703.70"], reopened: ["-10000000.00", "-3570.00"], since: true },
    } as const;
    for (const [name, c] of Object.entries(cases)) {
      const results: string[] = [];
      for (const close of [0, 1, 2, 3, "reopened"] as const) {
        await withBooks(lossRates(), async (h) => {
          const s = await h.contact(`Fournisseur G1 ${name} ${close}`);
          const currency = c.currency;
          await h.offload(await h.container(s, currency, "10"), `${m2}-04`);
          if (close === "reopened") {
            await h.close(m2);
            await h.reopen(m2);
          }
          if (close === 0) await h.close(m2);
          const paid = await h.pay(s, c.pay[0], `${m1}-13`, h.acc(c.pay[1]));
          if (close === 1) await h.close(m2);
          const since = await h.container(s, currency, "2");
          await h.offload(since, `${m1}-15`);
          if (c.since) await h.reverseOn(since, `${m1}-17`);
          if (close === 2) await h.close(m2);
          await h.undo(paid.id, `${m1}-20`);
          if (close === 3 || close === "reopened") await h.close(m2);
          // Owed again: the month's bill at the month-end rate, the bill since at its own.
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
  }, 900_000);

  it("G4: a cent paid on a few francs whose dollars a payment dated back left of the other sign leaves no dollars on no francs", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m1}-06`, "2774", "7.1"], [`${m1}-17`, "2940", "7.1"], [`${m1}-24`, "2940", "7.1"], [`${m1}-28`, "2900", "7.1"], [today, "2850", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur G4 centime");
      await h.offload(await h.container(s, "CDF", "1", "600026", (1 / 2940).toFixed(8)), `${m1}-17`);
      await h.pay(s, "147300", `${m1}-24`, h.acc("cash_cdf"));
      // Typed afterwards for a day before the bill, at that day's rate: 26 FC left owed, worth a cent, with
      // 9,20 $ the other way.
      await h.pay(s, "452700", `${m1}-06`, h.acc("cash_cdf"));
      expect((await h.owed(s, "CDF"))[0]).toBe("-26.00");
      const cent = await h.pay(s, "0.01", `${m1}-28`);
      // Before, 0 FC carrying 9,21 $ (the self-check red): the dollars the rates explain go to exchange differences.
      expect(await h.owed(s, "CDF")).toEqual(["0.00", "0.00"]);
      expect(await h.selfOk()).toEqual([]);
      // Undone, the cent takes them back with it.
      await h.undo(cent.id, `${m1}-28`);
      expect((await h.owed(s, "CDF"))[0]).toBe("-26.00");
      expect(await h.selfOk()).toEqual([]);
    });
  }, 120_000);

  it("G4: a bill booked again dated before the reversal and the undoing that left its francs claimed meets them on the day they leave none", async () => {
    await withBooks([[`${m2}-01`, "2800", "7.1"], [`${m2}-24`, "2756", "7.1"], [`${m2}-25`, "2756", "7.1"], [`${m2}-26`, "2756", "7.1"], [`${m2}-27`, "2756", "7.1"], [`${m1}-20`, "2780", "7.1"], [`${m1}-24`, "2790", "7.1"], [`${m1}-26`, "2800", "7.1"], [today, "2800", "7.1"]], async (h) => {
      const s = await h.contact("Fournisseur G4 rechargé");
      await h.offload(await h.container(s, "CDF", "1", "900039", (1 / 2756).toFixed(8)), `${m2}-24`);
      const box = await h.container(s, "CDF", "1", "2100000", (1 / 2756).toFixed(8));
      await h.offload(box, `${m2}-25`);
      // Paid from the drawer (at what its francs cost), 39 FC left, then a dollar deposit that pays them.
      await h.pay(s, "3000000", `${m2}-26`, h.acc("cash_cdf"));
      const deposit = await h.pay(s, "137.21", `${m2}-27`);
      // The bill reversed: its francs paid are claimed back at what was paid for them.
      await h.reverseOn(box, `${m1}-24`);
      await h.undo(deposit.id, `${m1}-26`);
      // Offloaded again, dated before both: by date the claim meets it only once the deposit's francs are undone.
      await h.offload(box, `${m1}-20`);
      // Before, 0 FC carrying 0,01 $ here, 24,35 $ in the audit's case (the self-check red).
      expect((await h.owed(s, "CDF"))[0]).toBe("0.00");
      expect((await h.owed(s, "CDF"))[1]).toBe("0.00");
      expect(await h.selfOk()).toEqual([]);
    });
  }, 120_000);
});
