import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { accounts, journalLines, journals, stockMovements } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasDb, resetDatabase } from "./helpers";
import type { Db } from "../../server/db";

/** Phase A38: what the thirty-third accounting audit found after A37 (several deposits on a back-dated bill, a cost shown, memos). */
describe.skipIf(!hasDb)("Guards found by the thirty-third audit", async () => {
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
  // Last month: yuan at 7,2 (the containers are billed at 0,140845, about 7,1), so its close revalues them.
  const [ty, tm] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  let cashUsd: number, cashCdf: number, openingEquity: number, payables: number, rent: number, locationId: number;
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
    expect((await call("POST", "/api/users", { username: "caisse", fullName: "Paul Caisse", role: "cashier", password: "caisse12345" })).status).toBe(201);
    expect((await call("POST", "/api/auth/login", { username: "caisse", password: "caisse12345" }, "caisse")).status).toBe(200);
    locationId = (await call<any[]>("GET", "/api/locations")).body[0].id;
    const accs = await db.select().from(accounts);
    cashUsd = accs.find((a) => a.systemKey === "cash_usd")!.id;
    cashCdf = accs.find((a) => a.systemKey === "cash_cdf")!.id;
    openingEquity = accs.find((a) => a.systemKey === "opening_equity")!.id;
    payables = accs.find((a) => a.systemKey === "payables")!.id;
    rent = accs.find((a) => a.type === "expense" && !a.systemKey)!.id;
    for (const [date, cdfPerUsd, cnyPerUsd] of [
      [`${prev}-01`, "2800", "7.1"],
      [`${prev}-28`, "2800", "7.2"],
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

  async function contact(name: string) {
    const r = await call("POST", "/api/parties", { type: "supplier", name: `${name} ${uniq()}` });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }
  /** A contact's balance on payables in one currency: [native, usd]. */
  async function owed(partyId: number, currency: "USD" | "CNY" | "CDF") {
    const [r] = await db
      .select({ native: sql<string>`coalesce(sum(${journalLines.nativeAmount}), 0)::numeric(20,2)::text`, usd: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(20,2)::text` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, payables), eq(journalLines.partyId, partyId), eq(journalLines.currency, currency)));
    return [r.native, r.usd];
  }
  /** A supplier's container of 3 000 ¥ at 0,140845 (or 1 500 000 FC at 0,000357), not offloaded yet. */
  async function container(s: number, currency: "CNY" | "CDF" = "CNY") {
    const product = await call("POST", "/api/products", { name: `Pièce ${uniq()}`, unit: "pcs", variants: [{ attributes: {}, sellPrice: "900" }] });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const box = await call("POST", "/api/containers", { number: `A38-${uniq()}`, supplierId: s, locationId, currency, rateToUsd: currency === "CNY" ? "0.140845" : "0.000357", status: "arrived" });
    expect(box.status, JSON.stringify(box.body)).toBe(201);
    expect((await call("PUT", `/api/containers/${box.body.id}/lines`, { lines: [{ variantId: product.body.variants[0].id, quantity: "3", unitPrice: currency === "CNY" ? "1000" : "500000" }] })).status).toBe(200);
    return box.body.id as number;
  }
  const offload = async (box: number, offloadDate: string) => {
    const r = await call("POST", `/api/containers/${box}/finalize`, { offloadDate });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const pay = (s: number, amount: string, date: string, settleNative?: string, who = "gerant") =>
    call("POST", "/api/money/party-payment", { date, partyId: s, accountId: cashUsd, amount, ...(settleNative ? { settleNative } : {}) }, who);
  /** No supplier left with no yuan but some dollars on their yuan. */
  const noResidue = async () =>
    (
      await db.execute(sql`select party_id from journal_lines where account_id = ${payables} and currency = 'CNY' group by party_id having sum(native_amount) = 0 and sum(debit - credit) <> 0`)
    ).rows;


  /** The journals by which a bill took its supplier's advance: [date, usd applied]. */
  const applied = async (box: number) =>
    (
      await db.execute<{ date: string; usd: string }>(
        sql`select j.date::text, sum(l.credit)::text as usd from journals j join journal_lines l on l.journal_id = j.id where j.source_type = 'advance_container' and j.source_id = ${box} and l.account_id = ${payables} and l.currency = 'USD' and j.reverses_journal_id is null and j.reversed_by_journal_id is null group by j.id, j.date order by j.id`,
      )
    ).rows.map((r) => [r.date, r.usd]);
  const receipt = (s: number, amount: string, date: string) => call("POST", "/api/vouchers/receipt", { date, accountId: cashUsd, lines: [{ partyId: s, amount }] }, "gerant");

  for (const currency of ["CNY", "CDF"] as const) {
    it(`F1: every deposit paid after a back-dated ${currency === "CNY" ? "yuan" : "franc"} bill is applied, each on its own day`, async () => {
      const s = await contact(`Fournisseur F1 ${currency}`);
      const box = await container(s, currency);
      const deposits: number[] = [];
      for (const d of ["06", "08"]) {
        const r = await pay(s, "100", `${prev}-${d}`);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        deposits.push(r.body.id);
      }
      await offload(box, `${prev}-05`);
      // Both, not the first alone: no dollar advance is left while the bill is still owed.
      expect(await applied(box)).toEqual([
        [`${prev}-06`, "100.00"],
        [`${prev}-08`, "100.00"],
      ]);
      expect(await owed(s, "USD")).toEqual(["0.00", "0.00"]);
      const [native] = await owed(s, currency);
      expect(native).toBe(currency === "CNY" ? "-1580.00" : "-940000.00");
      if (currency === "CNY") {
        // Yuan work dated after the last deposit, before today, is not refused for a date the books chose.
        const r = await pay(s, "140.85", `${prev}-09`, "1000");
        expect(r.status, JSON.stringify(r.body)).toBe(201);
      }
      // Undone, the bill gives both parts back.
      const back = await call("POST", `/api/containers/${box}/reverse`, { date: `${prev}-15` });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(await applied(box)).toEqual([]);
      expect((await owed(s, "USD"))[1]).toBe("200.00");
      // The yuan paid on the 9th are claimed back from the supplier.
      expect((await owed(s, currency))[0]).toBe(currency === "CNY" ? "1000.00" : "0.00");
      // A refund since took off the advance: neither deposit can be undone before it (see assertUndoKeepsAdvanceRefunds).
      const refund = await receipt(s, "150", `${prev}-16`);
      expect(refund.status, JSON.stringify(refund.body)).toBe(201);
      for (const id of deposits) {
        const undo = await call("POST", `/api/journals/${id}/reverse`, { date: `${prev}-17` });
        expect(undo.status, JSON.stringify(undo.body)).toBe(409);
        expect(undo.body.messageFr).toContain("Annulez d'abord ce remboursement");
      }
      expect((await call("POST", `/api/journals/${refund.body.id}/reverse`, { date: `${prev}-17` })).status).toBe(200);
      for (const id of deposits) {
        const undo = await call("POST", `/api/journals/${id}/reverse`, { date: `${prev}-17` });
        expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      }
      expect((await owed(s, "USD"))[1]).toBe("0.00");
      expect(await noResidue()).toEqual([]);
      expect((await checks.selfCheck(db)).ok).toBe(true);
    });
  }

  it("F1: a deposit undone while applied leaves its dollars owed, the bill's yuan settled; the bill undone, nothing is left", async () => {
    for (const which of [0, 1]) {
      const s = await contact(`Fournisseur F1 undo ${which}`);
      const box = await container(s);
      const deposits: number[] = [];
      for (const d of ["06", "08"]) deposits.push((await pay(s, "100", `${prev}-${d}`)).body.id);
      await offload(box, `${prev}-05`);
      const undo = await call("POST", `/api/journals/${deposits[which]}/reverse`, { date: `${prev}-10` });
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      expect(await owed(s, "USD")).toEqual(["0.00", "-100.00"]);
      expect((await owed(s, "CNY"))[0]).toBe("-1580.00");
      const back = await call("POST", `/api/containers/${box}/reverse`, { date: `${prev}-15` });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(await owed(s, "USD")).toEqual(["0.00", "100.00"]);
      expect(await owed(s, "CNY")).toEqual(["0.00", "0.00"]);
      expect((await call("POST", `/api/journals/${deposits[1 - which]}/reverse`, { date: `${prev}-16` })).status).toBe(200);
      expect(await owed(s, "USD")).toEqual(["0.00", "0.00"]);
    }
    expect(await noResidue()).toEqual([]);
    expect((await checks.selfCheck(db)).ok).toBe(true);
  });

  it("F2: stock counted or found with no cost typed keeps showing the cost typed before (0,125 $, not 0,124444 $)", async () => {
    /** 2,25 L at 0,125 $ (0,28 $), then one line: [qty, value, cost shown] and the costs kept on its movements. */
    const after = async (kind: string, unitCost: string | undefined, who: string) => {
      const product = await call("POST", "/api/products", { name: `Huile F2 ${uniq()}`, unit: "litre", variants: [{ attributes: {}, sellPrice: "1" }] });
      expect(product.status, JSON.stringify(product.body)).toBe(201);
      const variantId = product.body.variants[0].id as number;
      for (const [k, qtyChange, cost, by] of [["opening", "2.25", "0.125", "admin"], [kind, "0.5", unitCost, who]] as const) {
        const r = await call("POST", "/api/stock/adjustments", { date: today, locationId, kind: k, reason: k, lines: [{ variantId, qtyChange, ...(cost ? { unitCost: cost } : {}) }] }, by);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
      }
      const item = (await call<any>("GET", "/api/stock")).body.items.find((i: any) => i.variantId === variantId);
      const moved = await db.select({ unitCost: stockMovements.unitCost }).from(stockMovements).where(eq(stockMovements.variantId, variantId)).orderBy(stockMovements.id);
      return [item.qty, item.value, item.avgCost, moved.map((m) => m.unitCost)];
    };
    // The owner's count with no cost: in at the running average, which is not kept as a cost typed.
    expect(await after("count", undefined, "admin")).toEqual(["2.750", "0.34", "0.125000", ["0.125000", null]]);
    // The manager's found stock: held to the average whatever was typed, so not kept either.
    expect(await after("found", "0.125", "gerant")).toEqual(["2.750", "0.34", "0.125000", ["0.125000", null]]);
    expect(await after("found", undefined, "gerant")).toEqual(["2.750", "0.34", "0.125000", ["0.125000", null]]);
    // A cost typed by the owner is kept, as before.
    expect(await after("found", "0.2", "admin")).toEqual(["2.750", "0.38", "0.138000", ["0.125000", "0.200000"]]);
    expect((await call<any>("GET", "/api/stock")).body.reconciled).toBe(true);
  });

  it("F3: a books' own memo typed with look-alike letters of another alphabet, or the settled revaluation's, is refused", async () => {
    for (const memo of [
      "Есart de change (coût moyen des devises)", // Cyrillic Е and с
      "Écart de change (cοût moyen des devises)", // Greek ο
      "Ecаrt de chаnge à l'аnnulаtion", // Cyrillic а
      "Rеstе dе moins d'un dеmi-cеntimе soldé еn écart dе changе",
      ledger.REVALUATION_SETTLED_MEMO,
      "Reevaluation soldee : devises reglees apres la fin du mois",
      "Réévaluation soldée : dеvisеs réglées après la fin du mois",
    ]) {
      expect(() => ledger.assertMemoNotReserved(memo, 1), memo).toThrow(/books make themselves/);
    }
    for (const memo of ["Réévaluation soldée", "Écart de change du mois", "Оплата поставщику", "Écart de change (coût moyen des devises) 2", "Loyer"]) {
      expect(() => ledger.assertMemoNotReserved(memo, 1), memo).not.toThrow();
    }
    // Notes in another alphabet as long as a label folds to are not taken for it.
    for (const memo of ["货".repeat(32), "д".repeat(32), "Оплата поставщику за запчасти мотоци"]) {
      expect(() => ledger.assertMemoNotReserved(memo, 1), memo).not.toThrow();
    }
    const r = await call("POST", "/api/vouchers/payment", { date: today, accountId: cashUsd, lines: [{ accountId: rent, amount: "5", memo: "Есart de change (coût moyen des devises)" }] }, "gerant");
    expect(r.status).toBe(400);
    expect(r.body.messageFr).toContain("libellé d'une écriture");
  });
});
