/** Shapes returned by the API (numbers that are money come back as strings). */

export interface Account {
  id: number;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "cost_of_sales" | "expense";
  systemKey: string | null;
  isMoney: boolean;
  currency: "USD" | "CDF";
  partnerId: number | null;
  active: boolean;
  debit?: string;
  credit?: string;
  balance?: string;
  nativeBalance?: string;
}

export interface Location {
  id: number;
  name: string;
  parentId: number | null;
  active: boolean;
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  active: boolean;
}

export interface VariantRow {
  id: number;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  label: string;
  sellPrice: string;
  stockQty: string;
  stockValue: string;
  avgCost: string;
  /** The cost per unit its latest receipt was typed at, when it still gives the value (see variantUnitCost). */
  keptUnitCost?: string | null;
  reorderLevel: string;
  productId: number;
  productName: string;
  unit: string;
  tracksSerials: boolean;
  categoryName: string | null;
  locationQty: string;
  /** One piece at the list price sells below cost: the till warns staff who may not sell below cost. */
  listBelowCost?: boolean;
  /** Found by a motorcycle's chassis number: that bike, which the till picks on the line. */
  matchedUnit?: { id: number; chassisNo: string | null; engineNo: string | null; color: string | null };
}

export interface ProductVariant {
  id: number;
  productId: number;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  label: string;
  sellPrice: string;
  reorderLevel: string;
  stockQty: string;
  stockValue: string;
  avgCost: string;
  active: boolean;
  levels: { variantId: number; locationId: number; qty: string }[];
}

export interface Product {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName?: string | null;
  brand: string;
  unit: string;
  description: string | null;
  tracksSerials: boolean;
  active: boolean;
  variants?: ProductVariant[];
  variantCount?: number;
  stockQty?: string;
  stockValue?: string;
  minPrice?: string | null;
  maxPrice?: string | null;
}

export interface MotorcycleUnit {
  id: number;
  variantId: number;
  locationId: number;
  chassisNo: string | null;
  engineNo: string | null;
  color: string | null;
  containerId: number | null;
  status: "in_stock" | "sold" | "reversed" | "removed";
  saleId: number | null;
  sku: string;
  productName: string;
  label: string;
}

export interface Party {
  id: number;
  type: "customer" | "supplier" | "agent" | "employee";
  name: string;
  phone: string | null;
  notes: string | null;
  position?: string | null;
  monthlySalary?: string | null;
  startDate?: string | null;
  active: boolean;
  /** Debit-positive: customers owe us when positive; we owe suppliers when negative. */
  balance: string;
  /** The part of the balance kept in francs or yuan. */
  foreign?: { currency: "CDF" | "CNY"; native: string; usd: string }[];
  /** Employees: advances given after the latest payroll was saved, already taken off the salary it owes. */
  advanceDeducted?: { month: string; usd: string } | null;
}

export interface Partner {
  id: number;
  name: string;
  sharePct: string;
  bearsOperatingExpenses: boolean;
  currentAccountId: number;
  capitalAccountId: number;
  currentBalance: string;
  capitalBalance: string;
}

export interface Settings {
  shopName?: string;
  defaultCdfRate?: string;
  receiptFooter?: string;
  rateTolerancePct?: string;
  /** Biggest line discount a cashier / manager may give, in % of the list price. */
  cashierDiscountPct?: string;
  managerDiscountPct?: string;
  /** Whether managers may sell below cost (cashiers never may). */
  managerBelowCost?: boolean;
  latestRate: { date: string; cdfPerUsd: string } | null;
  today: string;
}
