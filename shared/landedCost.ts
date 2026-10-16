import { Decimal, MoneyError, allocateCents, cents, dec, sum, type DecimalInput } from "./money";
import { frNumber } from "./french";

/**
 * Landed cost allocation for a container offload.
 *
 * Every container expense (freight, duties, clearing, transport to Kalemie…) is split across
 * the container's lines by its own method, then each line's landed total is
 * FOB (in USD) + its share of every expense. All amounts are worked in cents with the
 * largest-remainder method, so the landed totals always add up to FOB total + expense total
 * exactly, and the inventory value posted to the ledger matches to the cent.
 */

export const ALLOCATION_METHODS = ["value", "quantity", "weight", "volume", "line"] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export interface LandedCostLineInput {
  key: string | number;
  quantity: DecimalInput;
  /** Purchase price per unit in the container's currency. */
  unitPrice: DecimalInput;
  weightKg?: DecimalInput | null;
  volumeCbm?: DecimalInput | null;
}

export interface LandedCostExpenseInput {
  key: string | number;
  /** Expense amount already converted to USD. */
  amountUsd: DecimalInput;
  method: AllocationMethod;
  /** Required when method is "line". */
  targetLineKey?: string | number | null;
}

export interface LandedCostLineResult {
  key: string | number;
  quantity: string;
  fobUsd: string;
  allocatedUsd: string;
  landedTotalUsd: string;
  /** Landed cost per unit, 6 decimals. */
  landedUnitCost: string;
  /** Allocated amount per expense key. */
  byExpense: Record<string, string>;
}

export interface LandedCostResult {
  lines: LandedCostLineResult[];
  fobTotalUsd: string;
  expensesTotalUsd: string;
  landedTotalUsd: string;
}

function weightFor(method: AllocationMethod, line: LandedCostLineInput, fobUsd: Decimal): Decimal {
  switch (method) {
    case "value":
      return fobUsd;
    case "quantity":
      return dec(line.quantity);
    case "weight":
      return dec(line.weightKg ?? 0);
    case "volume":
      return dec(line.volumeCbm ?? 0);
    default:
      return new Decimal(0);
  }
}

const METHOD_LABEL: Record<AllocationMethod, string> = {
  value: "purchase value",
  quantity: "quantity",
  weight: "weight",
  volume: "volume",
  line: "a single line",
};

const METHOD_LABEL_FR: Record<AllocationMethod, string> = {
  value: "valeur d'achat",
  quantity: "quantité",
  weight: "poids",
  volume: "volume",
  line: "ligne unique",
};

export function computeLandedCost(
  lines: LandedCostLineInput[],
  expenses: LandedCostExpenseInput[],
  rateToUsd: DecimalInput = 1,
): LandedCostResult {
  if (lines.length === 0) throw new MoneyError("The container has no lines", "Le conteneur n'a aucune ligne");
  const rate = dec(rateToUsd, "exchange rate");
  if (rate.lte(0)) throw new MoneyError("Exchange rate must be greater than zero", "Le taux de change doit être supérieur à zéro");

  const keys = new Set<string>();
  const fob = lines.map((line) => {
    const k = String(line.key);
    if (keys.has(k)) throw new MoneyError(`Duplicate line key ${k}`, `Clé de ligne en double ${k}`);
    keys.add(k);
    const q = dec(line.quantity, "quantity");
    if (q.lte(0)) throw new MoneyError("Every line needs a quantity greater than zero", "Chaque ligne doit avoir une quantité supérieure à zéro");
    const p = dec(line.unitPrice, "unit price");
    if (p.isNegative()) throw new MoneyError("Unit price cannot be negative", "Le prix unitaire ne peut pas être négatif");
    const value = cents(q.times(p).times(rate));
    // A priced line worth less than half a cent would go into stock at nothing.
    if (p.gt(0) && value.isZero()) {
      throw new MoneyError(
        `A line of ${q.toFixed()} at ${p.toFixed()} is worth less than one cent: enter 0 for a free item, or the real price`,
        `Une ligne de ${frNumber(q.toFixed())} à ${frNumber(p.toFixed())} vaut moins d'un centime : saisissez 0 pour un article gratuit, ou le vrai prix`,
      );
    }
    return value;
  });

  const allocated: Decimal[][] = expenses.map((expense) => {
    const amount = cents(expense.amountUsd);
    if (amount.isNegative()) throw new MoneyError("Container expenses cannot be negative", "Les dépenses du conteneur ne peuvent pas être négatives");
    if (expense.method === "line") {
      const idx = lines.findIndex((l) => String(l.key) === String(expense.targetLineKey));
      if (idx < 0) throw new MoneyError("An expense charged to a single line must name that line", "Une dépense imputée à une seule ligne doit indiquer cette ligne");
      return lines.map((_, i) => (i === idx ? amount : new Decimal(0)));
    }
    if (!ALLOCATION_METHODS.includes(expense.method)) {
      throw new MoneyError(`Unknown allocation method ${expense.method}`, `Méthode de répartition inconnue ${expense.method}`);
    }
    const weights = lines.map((line, i) => weightFor(expense.method, line, fob[i]));
    if (!amount.isZero() && sum(weights).isZero()) {
      throw new MoneyError(
        `Cannot split an expense by ${METHOD_LABEL[expense.method]}: no line has a ${METHOD_LABEL[expense.method]}`,
        `Impossible de répartir une dépense par ${METHOD_LABEL_FR[expense.method]} : aucune ligne n'a de ${METHOD_LABEL_FR[expense.method]}`,
      );
    }
    return allocateCents(amount, weights);
  });

  const resultLines: LandedCostLineResult[] = lines.map((line, i) => {
    const byExpense: Record<string, string> = {};
    expenses.forEach((e, j) => {
      byExpense[String(e.key)] = allocated[j][i].toFixed(2);
    });
    const alloc = sum(allocated.map((a) => a[i]));
    const landed = fob[i].plus(alloc);
    const q = dec(line.quantity);
    return {
      key: line.key,
      quantity: q.toFixed(3),
      fobUsd: fob[i].toFixed(2),
      allocatedUsd: alloc.toFixed(2),
      landedTotalUsd: landed.toFixed(2),
      landedUnitCost: landed.dividedBy(q).toDecimalPlaces(6).toFixed(6),
      byExpense,
    };
  });

  const fobTotal = sum(fob);
  const expTotal = sum(expenses.map((e) => cents(e.amountUsd)));
  return {
    lines: resultLines,
    fobTotalUsd: fobTotal.toFixed(2),
    expensesTotalUsd: expTotal.toFixed(2),
    landedTotalUsd: fobTotal.plus(expTotal).toFixed(2),
  };
}
