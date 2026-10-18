import { describe, expect, it } from "vitest";

describe("twenty-fifth UI audit: today's sales net of returns and avoirs", async () => {
  const { creditSplit, dailyFigures, netOf } = await import("../../client/src/lib/saleRows");
  const row = (over: Record<string, unknown>) => ({ id: 1, number: "S-1", date: "2026-10-18", status: "completed" as const, total: "0", paidUsd: "0", creditUsd: "0", customerName: null, cashier: null, ...over });

  it("reads a sale paid from an avoir as such, and a returned credit sale as cleared", () => {
    // S-000036: 28,50 $ on credit, 22 $ of it from the customer's avoir.
    const onAvoir = creditSplit(row({ total: "28.50", creditUsd: "28.50", creditLeftUsd: "28.50", avoirUsedUsd: "22.00", avoirAtSaleUsd: "22.00" }));
    expect(onAvoir.onAvoir.toFixed(2)).toBe("22.00");
    expect(onAvoir.owed.toFixed(2)).toBe("6.50");
    expect(onAvoir.avoirBefore).toBeNull();
    // S-000034: 17 $ on credit, brought back: nothing is left to pay.
    const returned = row({ total: "17.00", creditUsd: "17.00", creditLeftUsd: "0.00", returnedTotal: "17.00" });
    expect(creditSplit(returned).owed.toFixed(2)).toBe("0.00");
    expect(netOf(returned).total.toFixed(2)).toBe("0.00");
  });

  it("takes the cash refunded off what was paid", () => {
    const n = netOf(row({ total: "45.00", paidUsd: "45.00", returnedTotal: "21.97", refundedUsd: "21.97" }));
    expect(n.total.toFixed(2)).toBe("23.03");
    expect(n.paid.toFixed(2)).toBe("23.03");
    expect(n.refunded.toFixed(2)).toBe("21.97");
    // The cash really kept, when the server says it.
    expect(netOf(row({ total: "10.00", paidUsd: "10.00", paidKeptUsd: "10.03" })).paid.toFixed(2)).toBe("10.03");
  });

  it("gives the Ventes du jour tab the Aujourd'hui card's figures", () => {
    const f = dailyFigures({
      date: "2026-10-18",
      count: 12,
      total: "240.50",
      netCount: 11,
      netTotal: "176.50",
      credit: "36.50",
      creditOnAvoirUsd: "22.00",
      voidsCount: 1,
      voidsTotal: "10.00",
      returnsCount: 5,
      returnsTotal: "54.00",
      byAccount: [
        { account_id: 1, name: "Caisse USD", currency: "USD", usd: "111.03", native: "111.03", refund_usd: "21.97", refund_native: "21.97" },
        { account_id: 2, name: "Caisse FC", currency: "CDF", usd: "22.00", native: "61600" },
      ],
    });
    expect(f.count).toBe(11);
    expect(f.total.toFixed(2)).toBe("176.50");
    expect(f.paid.toFixed(2)).toBe("133.03");
    expect(f.refunded.toFixed(2)).toBe("21.97");
    expect(f.onAvoir.toFixed(2)).toBe("22.00");
    expect(f.owedCredit.toFixed(2)).toBe("14.50");
    // An older report without the net figures: the day's sales less cancellations and returns.
    const old = dailyFigures({ date: "2026-10-18", count: 3, total: "100.00", credit: "10.00", creditOnAvoirUsd: "15.00", voidsCount: 1, voidsTotal: "20.00", returnsTotal: "5.00", byAccount: [] });
    expect(old.total.toFixed(2)).toBe("75.00");
    // The avoir's part is never more than the credit.
    expect(old.onAvoir.toFixed(2)).toBe("10.00");
    expect(old.owedCredit.toFixed(2)).toBe("0.00");
  });
});
