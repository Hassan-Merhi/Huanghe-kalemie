import { afterEach, describe, expect, it } from "vitest";

describe("thirty-fourth UI audit: what a cancelled sale gave back", async () => {
  const { voidedParts, voidedRefunds, voidedSplit } = await import("../../client/src/lib/saleRows");
  const { setFormatLang } = await import("../../client/src/lib/format");
  afterEach(() => setFormatLang("fr"));
  const NB = "\u00a0";
  const fr = (_en: string, f: string) => f;
  const en = (e: string) => e;
  const names: Record<number, string> = { 1: "Caisse USD", 2: "Caisse FC" };
  const name = (id: number) => names[id];

  it("splits a cancelled sale into money refunded, avoir given back and credit cancelled", () => {
    // S-000026: 130 $, 20 $ in cash, 110 $ from the avoir. No credit was cancelled.
    expect(voidedParts(fr, voidedSplit({ paidUsd: "20.00", paidKeptUsd: "20.00", creditUsd: "110.00", avoirGivenBackUsd: "110.00" }))).toEqual([`20,00${NB}$ remboursés`, `110,00${NB}$ rendus à l'avoir`]);
    // S-000025: 10 $ credit and 100 $ avoir, nothing paid.
    expect(voidedParts(fr, voidedSplit({ paidUsd: "0.00", creditUsd: "110.00", avoirGivenBackUsd: "100.00" }))).toEqual([`10,00${NB}$ de crédit annulé`, `100,00${NB}$ rendus à l'avoir`]);
    // A plain credit sale, and one paid in full.
    expect(voidedParts(fr, voidedSplit({ paidUsd: "0.00", creditUsd: "50.00", avoirGivenBackUsd: null }))).toEqual([`50,00${NB}$ de crédit annulé`]);
    expect(voidedParts(fr, voidedSplit({ paidUsd: "1.50", creditUsd: "0.00" }))).toEqual([`1,50${NB}$ remboursé`]);
    setFormatLang("en");
    expect(voidedParts(en, voidedSplit({ paidUsd: "20.00", creditUsd: "110.00", avoirGivenBackUsd: "110.00" }))).toEqual(["$20.00 refunded", "$110.00 back to the customer's credit"]);
  });

  it("says the money handed back drawer by drawer, francs in francs, change netted", () => {
    expect(voidedRefunds(fr, [{ accountId: 1, currency: "USD", amountNative: "20.00", amountUsd: "20.00" }], name)).toEqual([
      { accountId: 1, name: "Caisse USD", text: `20,00${NB}$ remboursés depuis Caisse USD`, amount: `−20,00${NB}$` },
    ]);
    const francs = voidedRefunds(fr, [
      { accountId: 2, currency: "CDF", amountNative: "80000", amountUsd: "28.49" },
      { accountId: 2, currency: "CDF", amountNative: "-4200", amountUsd: "-1.50" },
    ], name);
    expect(francs).toEqual([{ accountId: 2, name: "Caisse FC", text: `75${NB}800${NB}FC remboursés depuis Caisse FC`, amount: `−75${NB}800${NB}FC (−26,99${NB}$)` }]);
    // Paid in francs, change in dollars: the dollar drawer takes its change back.
    const mixed = voidedRefunds(fr, [
      { accountId: 2, currency: "CDF", amountNative: "100000", amountUsd: "35.61" },
      { accountId: 1, currency: "USD", amountNative: "-5.00", amountUsd: "-5.00" },
    ], name);
    expect(mixed[1]).toEqual({ accountId: 1, name: "Caisse USD", text: `5,00${NB}$ de monnaie reprise dans Caisse USD`, amount: `+5,00${NB}$` });
    expect(voidedRefunds(fr, [], name)).toEqual([]);
  });
});
