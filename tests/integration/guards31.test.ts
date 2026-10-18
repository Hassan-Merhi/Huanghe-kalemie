import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines } from "@shared/schema";
import { Decimal } from "@shared/money";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A36: what the thirty-first accounting audit found after A35 (all in or around the YuanPool). */
describe.skipIf(!hasDb)("Guards found by the thirty-first audit", async () => {
  const { createApp } = await import("../../server/index");
  const checks = await import("../../server/services/checks");
  const ledger = await import("../../server/services/ledger");
  let db: Db;
  let server: Server;
  let base = "";
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
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  // Last month: francs at 2 800 on the 20th and 2 900 on the 28th, yuan at 7,2; today 2 790 and 7,1.
  const [ty, tm] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  const [in20, in28] = [`${prev}-20`, `${prev}-28`];
  let cashUsd: number, cashCdf: number, openingEquity: number, fx: number, payables: number, receivables: number, locationId: number;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${n++}`;

  beforeAll(async () => {
    db = await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "test-password-123" })).status).toBe(200);
    expect((await call("POST", "/api/users", { username: "gerant", fullName: "Jean Gérant", role: "manager", password: "gerant12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "gerant", password: "gerant12345" }, "gerant")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    fx = accs.find((a) => a.systemKey === "fx")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    receivables = accs.find((a) => a.systemKey === "receivables")!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of [
      [`${prev}-01`, "2800", "7.2"],
      [in20, "2800", "7.2"],
      [in28, "2900", "7.2"],
      [today, "2790", "7.1"],
    ]) {
      expect((await call("POST", "/api/exchange-rates", { date, cdfPerUsd, cnyPerUsd })).status).toBeLessThan(300);
    }
    const opening = await call("POST", "/api/journals", {
      date: `${prev}-01`,
      memo: "Ouverture",
      type: "opening",
      lines: [
        { accountId: cashUsd, debit: "10000" },
        { accountId: cashCdf, debit: "1000", nativeAmount: "2800000", rate: "2800" },
        { accountId: openingEquity, credit: "11000" },
      ],
    });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });

  async function contact(type: "customer" | "supplier", name: string) {
    const r = await call("POST", "/api/parties", { type, name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** A contact's balance on an account in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CDF" | "CNY", accountId: number) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, accountId), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  async function drawer(accountId: number) {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId));
    return [r.native, r.usd];
  }
  const linesOf = (journalId: number) => db.select().from(journalLines).where(eq(journalLines.journalId, journalId));
  const foreignCheck = async () => (await checks.selfCheck(db)).checks.find((c) => c.key === "foreign_balances")!;

  /** A supplier's yuan container of `yuan` ¥ at 0,140845, offloaded on `offload`. */
  async function container(s: number, yuan: number, offload = in20) {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const box = await call("POST", "/api/containers", { number: `A36-${uniq()}`, supplierId: s, locationId, currency: "CNY", rateToUsd: "0.140845", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: String(yuan / 1000), unitPrice: "1000" }] })).status).toBe(200);
    const off = await call("POST", `/api/containers/${box.body.id}/finalize`, { offloadDate: offload });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    return box.body.id as number;
  }
  const pay = async (s: number, amount: string, settleNative: string, date = in28) => {
    const r = await call("POST", "/api/money/party-payment", { date, partyId: s, accountId: cashUsd, amount, settleNative }, "gerant");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const reverse = async (box: number, date = today) => {
    const r = await call("POST", `/api/containers/${box}/reverse`, { date });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const undo = async (journal: number, date = today) => {
    const r = await call("POST", `/api/journals/${journal}/reverse`, { date });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const receive = (partyId: number, amount: string, opts: { date?: string; settleNative?: string; who?: string } = {}) =>
    call("POST", "/api/vouchers/receipt", { date: opts.date ?? today, accountId: cashUsd, lines: [{ partyId, amount, ...(opts.settleNative ? { settleNative: opts.settleNative } : {}) }] }, opts.who ?? "gerant");
  const fxNow = async () => Number((await drawer(fx))[1]);
  /** Refunding exactly `paid` closes the supplier: no yuan, no dollars, no exchange difference left. */
  async function refundCloses(s: number, paid: string, fx0: number, cash0: number) {
    const back = await receive(s, paid);
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect(Number((await drawer(cashUsd))[1]) - cash0).toBeCloseTo(0, 2);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  }

  it("F1: yuan paid in one voucher with another supplier's yuan come back claimed at what each was paid", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s1 = await contact("supplier", "Fournisseur F1 a");
    const s2 = await contact("supplier", "Fournisseur F1 b");
    const b1 = await container(s1, 3000);
    const b2 = await container(s2, 3000);
    // 3 000 ¥ at the day's 7,2 for each: 416,67 $ for yuan booked at 422,54 $, a 5,87 $ gain each.
    const v = await call("POST", "/api/vouchers/payment", { date: in28, accountId: cashUsd, lines: [{ partyId: s1, amount: "416.67" }, { partyId: s2, amount: "416.67" }] }, "gerant");
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const lines = await linesOf(v.body.id);
    // Each supplier's yuan line keeps its own exchange difference.
    expect(lines.filter((l) => l.currency === "CNY").map((l) => l.fxUsd)).toEqual(["5.87", "5.87"]);
    expect(lines.find((l) => l.accountId === fx)).toMatchObject({ kind: "cost_fx", credit: "11.74" });
    await reverse(b1);
    await reverse(b2);
    for (const s of [s1, s2]) expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "416.67"]);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    for (const s of [s1, s2]) expect((await receive(s, "416.67")).status).toBe(201);
    for (const s of [s1, s2]) {
      expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
      expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    }
    expect(Number((await drawer(cashUsd))[1]) - cash0).toBeCloseTo(0, 2);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F1: yuan paid from the franc box come back claimed at what was paid, apart from the drawer's own difference", async () => {
    const s = await contact("supplier", "Fournisseur F1 francs");
    const box = await container(s, 3000);
    const fx0 = await fxNow();
    // 416,67 $ at the day's 2 900 FC: the francs leave the drawer at their own average cost (2 800).
    const v = await call("POST", "/api/vouchers/payment", { date: in28, accountId: cashCdf, lines: [{ partyId: s, amount: "1208343" }] }, "gerant");
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const lines = await linesOf(v.body.id);
    const yuan = lines.find((l) => l.currency === "CNY")!;
    const francs = lines.find((l) => l.accountId === cashCdf)!;
    expect(yuan.fxUsd).toBe("5.87");
    const drawerFx = Number(francs.fxUsd);
    expect(drawerFx).not.toBe(0);
    await reverse(box);
    // Claimed at the 416,67 $ paid: only the drawer's own difference stays in exchange differences.
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "416.67"]);
    expect((await fxNow()) - fx0).toBeCloseTo(-drawerFx, 2);
    expect((await receive(s, "416.67")).status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F2: the books' own labels cannot be typed on a voucher or journal line", async () => {
    const s = await contact("supplier", "Fournisseur F2 libellé");
    for (const memo of [ledger.SETTLED_FX_MEMO, ledger.REVALUED_MEMO, ledger.RESIDUE_MEMO, ledger.COST_FX_MEMO, "  ecart de change du reglement repris a l’annulation "]) {
      for (const kind of ["payment", "receipt"]) {
        const r = await call("POST", `/api/vouchers/${kind}`, { date: today, accountId: cashUsd, lines: [{ partyId: s, amount: "10", memo }] }, "gerant");
        expect(r.status, memo).toBe(400);
        expect(r.body.messageFr).toContain("libellé d'une écriture que la comptabilité passe elle-même");
      }
    }
    const journal = await call("POST", "/api/journals", {
      date: today,
      memo: "Correction",
      lines: [
        { accountId: cashUsd, debit: "1", memo: ledger.REVALUED_MEMO },
        { accountId: openingEquity, credit: "1" },
      ],
    });
    expect(journal.status).toBe(400);
    // Another note is fine.
    expect((await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: s, amount: "10", memo: "Écart de prix" }] }, "gerant")).status).toBe(201);
  });

  it("F2: a payment or refund whose line memo reads like the books' own still counts (membership by kind, never memo)", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur F2 mémo");
    const box = await container(s, 3000);
    const paid = await call("POST", "/api/vouchers/payment", { date: in28, accountId: cashUsd, lines: [{ partyId: s, amount: "416.67" }] }, "gerant");
    expect(paid.status).toBe(201);
    // As a hand-typed memo before A36 left it (or a backup restored): the line has the takeback's memo.
    await db.update(journalLines).set({ memo: ledger.SETTLED_FX_MEMO }).where(and(eq(journalLines.journalId, paid.body.id), eq(journalLines.partyId, s)));
    await reverse(box);
    // Still a payment: its yuan come back claimed at what was paid.
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "416.67"]);
    const back = await receive(s, "416.67");
    expect(back.status).toBe(201);
    await db.update(journalLines).set({ memo: ledger.REVALUED_MEMO }).where(and(eq(journalLines.journalId, back.body.id), eq(journalLines.partyId, s)));
    // Still a refund: the payment cannot be undone before it.
    const refused = await call("POST", `/api/journals/${paid.body.id}/reverse`, { date: today });
    expect(refused.status).toBe(409);
    expect(refused.body.messageFr).toContain("Annulez d'abord ce remboursement");
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    expect(Number((await drawer(cashUsd))[1]) - cash0).toBeCloseTo(0, 2);
    expect((await fxNow()) - fx0).toBeCloseTo(0, 2);
    // A backup made before lines kept their kind: the books' own lines get it back, the typed ones do not.
    const own = await db.select({ id: journalLines.id, kind: journalLines.kind }).from(journalLines).where(and(eq(journalLines.partyId, s), sql`${journalLines.kind} is not null`));
    expect(own.map((l) => l.kind)).toContain("settled_fx");
    const ids = (await db.select({ journalId: journalLines.journalId }).from(journalLines).where(eq(journalLines.partyId, s))).map((l) => l.journalId);
    await db.update(journalLines).set({ kind: null }).where(inArray(journalLines.journalId, ids));
    await db.transaction((tx) => ledger.markSystemLines(tx));
    const again = await db.select({ id: journalLines.id, kind: journalLines.kind }).from(journalLines).where(and(inArray(journalLines.journalId, ids), sql`${journalLines.kind} is not null`));
    expect(new Set(again.map((l) => `${l.id}:${l.kind}`))).toEqual(new Set((await db.select({ id: journalLines.id, kind: journalLines.kind }).from(journalLines).where(and(inArray(journalLines.journalId, ids), sql`${journalLines.kind} is not null`))).map((l) => `${l.id}:${l.kind}`)));
    expect(again.length).toBeGreaterThanOrEqual(own.filter((l) => l.kind !== "cost_fx").length);
    const typed = await db.select({ kind: journalLines.kind }).from(journalLines).where(and(inArray(journalLines.journalId, [paid.body.id, back.body.id]), eq(journalLines.partyId, s)));
    expect(typed.map((l) => l.kind)).toEqual([null, null]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F3: no yuan of a supplier move dated before their latest yuan entry, the owner's included", async () => {
    const s = await contact("supplier", "Fournisseur F3");
    await container(s, 2000);
    await container(s, 2000, `${prev}-24`);
    await pay(s, "270.42", "2000", in28);
    // Dated back before the second bill and the payment: costed against yuan a later entry already took.
    for (const who of ["gerant", "admin"]) {
      const back = await call("POST", "/api/money/party-payment", { date: `${prev}-22`, partyId: s, accountId: cashUsd, amount: "277.78", settleNative: "2000" }, who);
      expect(back.status, JSON.stringify(back.body)).toBe(409);
      expect(back.body.code).toBe("YUAN_DATE_ORDER");
      expect(back.body.messageFr).toContain(`datée du 28/${prev.slice(5, 7)}/${prev.slice(0, 4)}`);
    }
    const voucher = await call("POST", "/api/vouchers/payment", { date: `${prev}-22`, accountId: cashUsd, lines: [{ partyId: s, amount: "100" }] }, "gerant");
    expect(voucher.status).toBe(409);
    // On the latest one's day, and later, they do.
    await pay(s, "140.00", "1000", in28);
    await pay(s, "140.00", "1000", today);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    expect((await foreignCheck()).ok).toBe(true);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F3: in-order work, back-dated in order, still goes through", async () => {
    const fx0 = await fxNow();
    const cash0 = Number((await drawer(cashUsd))[1]);
    const s = await contact("supplier", "Fournisseur F3 en ordre");
    const box = await container(s, 3000, `${prev}-21`);
    await pay(s, "201.76", "1500", `${prev}-22`);
    await pay(s, "201.76", "1500", `${prev}-22`);
    await reverse(box, `${prev}-23`);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "403.52"]);
    await refundCloses(s, "403.52", fx0, cash0);
  });

  it("F4: undoing a voucher that pays a yuan supplier and a contact with a lower id takes their locks in order", async () => {
    const low = await contact("supplier", "Fournisseur F4 dollars");
    const s = await contact("supplier", "Fournisseur F4 yuans");
    expect(low).toBeLessThan(s);
    await container(s, 3000, today);
    process.env.HK_LOCK_ORDER = "strict";
    try {
      const v = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: s, amount: "100" }, { partyId: low, amount: "50" }] }, "gerant");
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      const r = await call("POST", `/api/journals/${v.body.id}/reverse`, { date: today });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // Several undos and vouchers on both at once: no lock out of order, no deadlock.
      const vs: number[] = [];
      for (let i = 0; i < 4; i++) {
        const x = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: s, amount: "10" }, { partyId: low, amount: "5" }] }, "gerant");
        expect(x.status).toBe(201);
        vs.push(x.body.id);
      }
      const all = await Promise.all([
        ...vs.map((id) => call("POST", `/api/journals/${id}/reverse`, { date: today })),
        ...vs.map(() => call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ partyId: low, amount: "5" }, { partyId: s, amount: "10" }] }, "gerant")),
      ]);
      expect(all.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 201, 201, 201, 201]);
    } finally {
      delete process.env.HK_LOCK_ORDER;
    }
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F6: a dollar advance a receipt took off since cannot be undone before that receipt", async () => {
    const s = await contact("supplier", "Fournisseur F6");
    const box = await container(s, 3000);
    await pay(s, "422.54", "3000");
    await reverse(box);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    const advance = await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashUsd, amount: "200" }, "gerant");
    expect(advance.status).toBe(201);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "200.00"]);
    // The receipt settles the advance first, then the yuan.
    const back = await receive(s, "622.54");
    expect(back.status).toBe(201);
    expect(await owed(s, "CNY", payables)).toEqual(["0.00", "0.00"]);
    const refused = await call("POST", `/api/journals/${advance.body.id}/reverse`, { date: today });
    expect(refused.status).toBe(409);
    expect(refused.body.messageFr).toContain("Annulez d'abord ce remboursement");
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    await undo(back.body.id);
    await undo(advance.body.id);
    expect(await owed(s, "CNY", payables)).toEqual(["3000.00", "422.54"]);
    expect(await owed(s, "USD", payables)).toEqual(["0.00", "0.00"]);
    // An advance no receipt took anything off is undone as before.
    const other = await call("POST", "/api/money/party-payment", { date: today, partyId: s, accountId: cashUsd, amount: "50" }, "gerant");
    await undo(other.body.id);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F5: the yuan replay stays quick for a supplier with thousands of payments", async () => {
    const s = await contact("supplier", "Fournisseur F5");
    const box = await container(s, 60000, in20);
    // 6 000 payments of 10 ¥, written straight into the books (through the routes it would take minutes).
    const lots = 6000;
    await db.execute(sql`
      with j as (
        insert into journals (number, date, type, memo)
        select ${"F5-" + uniq() + "-"} || g, ${in28}::date, 'supplier_payment', 'F5' from generate_series(1, ${lots}::int) g
        returning id
      )
      insert into journal_lines (journal_id, account_id, debit, credit, party_id, currency, native_amount, rate, fx_usd)
      select id, ${payables}::int, 1.41, 0, ${s}::int, 'CNY', 10, 7.0922, 0 from j
      union all select id, ${openingEquity}::int, 0, 1.41, null, 'USD', null, null, null from j`);
    const [first] = await db.select({ id: journalLines.journalId }).from(journalLines).where(and(eq(journalLines.partyId, s), eq(journalLines.debit, "1.41"))).limit(1);
    let t = Date.now();
    await undo(first.id);
    expect(Date.now() - t).toBeLessThan(2000);
    t = Date.now();
    await reverse(box);
    expect(Date.now() - t).toBeLessThan(2000);
    expect((await owed(s, "CNY", payables))[0]).toBe(`${(lots - 1) * 10}.00`);
  });
});
