import { describe, expect, it } from "vitest";

describe("forty-fifth UI audit: the reprint of a cancelled franc sale", async () => {
  const { receiptFcRoundingUsd } = await import("../../client/src/lib/saleRows");
  const { fcRounding, setFormatLang } = await import("../../client/src/lib/format");
  const fr = (_en: string, f: string) => f;

  it("keeps the till's rounding dollars on a cancelled sale, where the reversal nets saleFcRoundingUsd to zero", () => {
    // 75 800 FC on 27,00 $ at 2 808: 26,99 $ kept, −0,01 $ for the shop; cancelled, the server's own figure is 0,00.
    expect(receiptFcRoundingUsd({ status: "voided", paidUsd: "27.00", saleFcRoundingUsd: "0.00", paidKeptUsd: "26.99" })?.toFixed(2)).toBe("-0.01");
    // A live or completed sale reads the server's figure as before.
    expect(receiptFcRoundingUsd({ status: "completed", paidUsd: "27.00", saleFcRoundingUsd: "-0.01", paidKeptUsd: "26.99" })?.toFixed(2)).toBe("-0.01");
    expect(receiptFcRoundingUsd({ status: "completed", paidUsd: "27.00", saleFcRoundingUsd: "0.02", paidKeptUsd: "27.02" })?.toFixed(2)).toBe("0.02");
    // A cancelled sale from a server without "Payé" falls back to the figure given, and an old one to the caller's own sum.
    expect(receiptFcRoundingUsd({ status: "voided", paidUsd: "27.00", saleFcRoundingUsd: "0.00" })?.toFixed(2)).toBe("0.00");
    expect(receiptFcRoundingUsd({ status: "completed", paidUsd: "27.00" })).toBeNull();
  });

  it("so both receipts read \"−40 FC (−0,01 $)\"", () => {
    setFormatLang("fr");
    const kept = receiptFcRoundingUsd({ status: "voided", paidUsd: "27.00", saleFcRoundingUsd: "0.00", paidKeptUsd: "26.99" });
    expect(fcRounding(fr, kept, -40)?.figure).toBe("−40\u00a0FC (−0,01\u00a0$)");
    expect(fcRounding(fr, "0.00", -40)?.figure).toBe("−40\u00a0FC");
  });
});

describe("forty-fifth UI audit: a container's unit price is shown with every decimal it has", async () => {
  const { exactMoney, money, setFormatLang } = await import("../../client/src/lib/format");
  it("reads 4,125 ¥ l'unité as on the invoice, the line total to the cent", () => {
    setFormatLang("fr");
    expect(exactMoney("4.125", "CNY")).toBe("4,125\u00a0¥");
    expect(exactMoney("4.125", "USD")).toBe("4,125\u00a0$");
    expect(exactMoney("4.1", "CNY")).toBe("4,10\u00a0¥");
    expect(money("4.13", "CNY")).toBe("4,13\u00a0¥");
  });
});
