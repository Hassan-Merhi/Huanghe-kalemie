import { Decimal, MoneyError, allocateCents, cents, dec, sum, type DecimalInput } from "./money";

/**
 * Monthly partner settlement.
 *
 * Gross profit (sales − cost of goods sold − stock losses, container costs already inside
 * cost of goods sold) is split by each partner's share. Operating expenses (rent, salaries,
 * electricity…) are then charged only to the partners who bear them, in proportion to their
 * shares among the bearers. With the Kalemie setup that is 75% / 25% with every operating
 * expense on the 75% partner.
 *
 * A partner's result can be negative (expenses larger than their share); it is posted to their
 * current account and so carries forward.
 */

export interface PartnerShareInput {
  id: number;
  name?: string;
  sharePct: DecimalInput;
  bearsOperatingExpenses: boolean;
}

export interface PartnerSplitLine {
  partnerId: number;
  name?: string;
  sharePct: string;
  shareOfGrossProfit: string;
  operatingExpensesCharged: string;
  net: string;
}

export interface PartnerSplitResult {
  grossProfit: string;
  operatingExpenses: string;
  netProfit: string;
  partners: PartnerSplitLine[];
}

export function validatePartnerShares(partners: PartnerShareInput[]): void {
  if (partners.length === 0) throw new MoneyError("At least one partner is required", "Au moins un associé est requis");
  const total = sum(partners.map((p) => dec(p.sharePct, "share")));
  if (!total.equals(100)) throw new MoneyError(`Partner shares must add up to 100% (now ${total.toString()}%)`, `Les parts des associés doivent totaliser 100 % (actuellement ${total.toString()} %)`);
  for (const p of partners) {
    if (dec(p.sharePct).isNegative()) throw new MoneyError("A partner share cannot be negative", "La part d'un associé ne peut pas être négative");
  }
  if (!partners.some((p) => p.bearsOperatingExpenses)) {
    throw new MoneyError("At least one partner must bear the operating expenses", "Au moins un associé doit supporter les charges d'exploitation");
  }
}

export function splitProfit(
  grossProfit: DecimalInput,
  operatingExpenses: DecimalInput,
  partners: PartnerShareInput[],
): PartnerSplitResult {
  validatePartnerShares(partners);
  const gross = cents(grossProfit);
  const opex = cents(operatingExpenses);

  const grossShares = allocateCents(
    gross,
    partners.map((p) => dec(p.sharePct)),
  );
  const bearerWeights = partners.map((p) => (p.bearsOperatingExpenses ? dec(p.sharePct) : new Decimal(0)));
  // A bearer with a 0% share would get nothing; fall back to equal weights among bearers.
  const weights = sum(bearerWeights).isZero()
    ? partners.map((p) => (p.bearsOperatingExpenses ? new Decimal(1) : new Decimal(0)))
    : bearerWeights;
  const opexShares = allocateCents(opex, weights);

  return {
    grossProfit: gross.toFixed(2),
    operatingExpenses: opex.toFixed(2),
    netProfit: gross.minus(opex).toFixed(2),
    partners: partners.map((p, i) => ({
      partnerId: p.id,
      name: p.name,
      sharePct: dec(p.sharePct).toFixed(2),
      shareOfGrossProfit: grossShares[i].toFixed(2),
      operatingExpensesCharged: opexShares[i].toFixed(2),
      net: grossShares[i].minus(opexShares[i]).toFixed(2),
    })),
  };
}
