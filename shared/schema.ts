import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/*
 * Money conventions
 * - Base currency is USD. Every ledger amount is stored in USD with 2 decimals.
 * - Money accounts in CDF also keep the native CDF amount and the rate used on each line.
 * - Quantities use 3 decimals (oil by the litre, cable by the metre); unit costs use 6.
 */

const money = (name: string) => numeric(name, { precision: 20, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 15, scale: 3 });
const unitCost = (name: string) => numeric(name, { precision: 20, scale: 6 });

export const ROLES = ["owner", "manager", "cashier", "partner"] as const;
export type Role = (typeof ROLES)[number];

export const CURRENCIES = ["USD", "CDF"] as const;
export type Currency = (typeof CURRENCIES)[number];
/** Journal lines also carry yuan: a supplier's balance from a CNY container invoice. */
export type LineCurrency = Currency | "CNY";

// ---------------------------------------------------------------- Users & settings

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 60 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  role: varchar("role", { length: 20 }).$type<Role>().notNull(),
  partnerId: integer("partner_id"),
  language: varchar("language", { length: 2 }).notNull().default("fr"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Daily CDF per 1 USD rate. */
export const exchangeRates = pgTable("exchange_rates", {
  date: date("date").primaryKey(),
  cdfPerUsd: numeric("cdf_per_usd", { precision: 14, scale: 4 }).notNull(),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const counters = pgTable("counters", {
  key: varchar("key", { length: 40 }).primaryKey(),
  value: integer("value").notNull().default(0),
});

/** One row per Idempotency-Key the browser sent, so a double tap or a retry posts only once. */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: varchar("key", { length: 100 }).primaryKey(),
  userId: integer("user_id").notNull(),
  method: varchar("method", { length: 10 }).notNull(),
  path: text("path").notNull(),
  /** Null while the first request is still running. */
  status: integer("status"),
  response: jsonb("response"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id"),
    action: varchar("action", { length: 60 }).notNull(),
    entity: varchar("entity", { length: 40 }).notNull(),
    entityId: integer("entity_id"),
    data: jsonb("data"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ entityIdx: index("audit_log_entity_idx").on(t.entity, t.entityId) }),
);

export const locations = pgTable("locations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
});

// ---------------------------------------------------------------- Catalog

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
  active: boolean("active").notNull().default(true),
});

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    categoryId: integer("category_id").references(() => categories.id),
    brand: text("brand").notNull().default("Huanghe"),
    unit: varchar("unit", { length: 20 }).notNull().default("pcs"),
    description: text("description"),
    /** Motorcycles: each unit has its own chassis / engine number. */
    tracksSerials: boolean("tracks_serials").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ nameIdx: index("products_name_idx").on(t.name) }),
);

/**
 * A sellable variant of a product (size, colour, fitment…). Stock and cost live here.
 * stockQty / stockValue are the totals across all locations; average cost = value / qty.
 * Keeping the value (not only the average) makes the Inventory account equal the sum of
 * variant values to the cent.
 */
export const variants = pgTable(
  "variants",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    sku: varchar("sku", { length: 60 }).notNull().unique(),
    barcode: varchar("barcode", { length: 64 }).unique(),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    sellPrice: money("sell_price").notNull().default("0"),
    reorderLevel: qty("reorder_level").notNull().default("0"),
    stockQty: qty("stock_qty").notNull().default("0"),
    stockValue: money("stock_value").notNull().default("0"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index("variants_product_idx").on(t.productId),
    nonNegative: check("variants_stock_non_negative", sql`${t.stockQty} >= 0`),
  }),
);

export const stockLevels = pgTable(
  "stock_levels",
  {
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id),
    qty: qty("qty").notNull().default("0"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.variantId, t.locationId] }),
    nonNegative: check("stock_levels_non_negative", sql`${t.qty} >= 0`),
  }),
);

export const MOVEMENT_TYPES = [
  "opening",
  "container_in",
  "container_reversal",
  "sale",
  "sale_void",
  "sale_return",
  "adjustment",
  "transfer_in",
  "transfer_out",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: serial("id").primaryKey(),
    date: date("date").notNull(),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id),
    type: varchar("type", { length: 30 }).$type<MovementType>().notNull(),
    /** Signed: positive in, negative out. */
    qty: qty("qty").notNull(),
    /** Signed value moved in or out of stock, in USD. */
    value: money("value").notNull(),
    sourceType: varchar("source_type", { length: 30 }),
    sourceId: integer("source_id"),
    journalId: integer("journal_id"),
    note: text("note"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    variantIdx: index("stock_movements_variant_idx").on(t.variantId, t.date),
    sourceIdx: index("stock_movements_source_idx").on(t.sourceType, t.sourceId),
  }),
);

/** "reversed": the container offload was undone; the record keeps its chassis number for the next offload. */
export const UNIT_STATUSES = ["in_stock", "sold", "reversed"] as const;

export const motorcycleUnits = pgTable(
  "motorcycle_units",
  {
    id: serial("id").primaryKey(),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id),
    chassisNo: varchar("chassis_no", { length: 60 }).unique(),
    engineNo: varchar("engine_no", { length: 60 }),
    color: text("color"),
    containerId: integer("container_id"),
    status: varchar("status", { length: 20 }).notNull().default("in_stock"),
    saleId: integer("sale_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ variantIdx: index("motorcycle_units_variant_idx").on(t.variantId, t.status) }),
);

// ---------------------------------------------------------------- Parties

export const PARTY_TYPES = ["customer", "supplier", "agent", "employee"] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

/** Customers, suppliers, agents (clearing, transport) and employees (salaries owed). Balances come from the ledger. */
export const parties = pgTable(
  "parties",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 20 }).$type<PartyType>().notNull(),
    name: text("name").notNull(),
    phone: varchar("phone", { length: 40 }),
    notes: text("notes"),
    /** Employees: job title, monthly salary in USD and start date, used by payroll. */
    position: text("position"),
    monthlySalary: money("monthly_salary"),
    startDate: date("start_date"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ typeIdx: index("parties_type_idx").on(t.type, t.name) }),
);

// ---------------------------------------------------------------- Accounting

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "cost_of_sales", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Chart of accounts.
 * - income − cost_of_sales = gross profit, shared between partners by share.
 * - expense = operating expenses, charged to the partner(s) who bear them.
 * - systemKey marks accounts the app posts to automatically.
 */
export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: text("name").notNull(),
  type: varchar("type", { length: 20 }).$type<AccountType>().notNull(),
  systemKey: varchar("system_key", { length: 40 }).unique(),
  /** Cash box, bank or mobile money wallet that can receive or pay money. */
  isMoney: boolean("is_money").notNull().default(false),
  currency: varchar("currency", { length: 3 }).$type<Currency>().notNull().default("USD"),
  partnerId: integer("partner_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const JOURNAL_TYPES = [
  "opening",
  "manual",
  "sale",
  "sale_void",
  "sale_return",
  "customer_receipt",
  "supplier_payment",
  "container_expense",
  "container_finalize",
  "container_reversal",
  "expense",
  "transfer",
  "partner_contribution",
  "partner_withdrawal",
  "stock_adjustment",
  "payment",
  "receipt",
  "payroll",
  "revaluation",
  "period_close",
  "reversal",
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const journals = pgTable(
  "journals",
  {
    id: serial("id").primaryKey(),
    number: varchar("number", { length: 20 }).notNull().unique(),
    date: date("date").notNull(),
    type: varchar("type", { length: 30 }).$type<JournalType>().notNull(),
    memo: text("memo"),
    sourceType: varchar("source_type", { length: 30 }),
    sourceId: integer("source_id"),
    reversesJournalId: integer("reverses_journal_id"),
    reversedByJournalId: integer("reversed_by_journal_id"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dateIdx: index("journals_date_idx").on(t.date),
    sourceIdx: index("journals_source_idx").on(t.sourceType, t.sourceId),
  }),
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: serial("id").primaryKey(),
    journalId: integer("journal_id")
      .notNull()
      .references(() => journals.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    partyId: integer("party_id").references(() => parties.id),
    /** For CDF money accounts: signed native amount (+ debit, − credit) and the rate used. */
    currency: varchar("currency", { length: 3 }).$type<LineCurrency>().notNull().default("USD"),
    nativeAmount: money("native_amount"),
    rate: numeric("rate", { precision: 14, scale: 4 }),
    memo: text("memo"),
  },
  (t) => ({
    journalIdx: index("journal_lines_journal_idx").on(t.journalId),
    accountIdx: index("journal_lines_account_idx").on(t.accountId),
    partyIdx: index("journal_lines_party_idx").on(t.partyId),
    oneSided: check(
      "journal_lines_one_sided",
      sql`${t.debit} >= 0 AND ${t.credit} >= 0 AND (${t.debit} = 0 OR ${t.credit} = 0)`,
    ),
  }),
);

export const partners = pgTable("partners", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sharePct: numeric("share_pct", { precision: 5, scale: 2 }).notNull(),
  bearsOperatingExpenses: boolean("bears_operating_expenses").notNull().default(false),
  /** Equity account where monthly results and withdrawals are posted. */
  currentAccountId: integer("current_account_id").notNull(),
  /** Equity account for money put into the business. */
  capitalAccountId: integer("capital_account_id").notNull(),
  active: boolean("active").notNull().default(true),
});

/** One row per month. A closed month accepts no postings. */
export const periods = pgTable("periods", {
  id: serial("id").primaryKey(),
  /** YYYY-MM */
  month: varchar("month", { length: 7 }).notNull().unique(),
  status: varchar("status", { length: 10 }).notNull().default("open"),
  grossProfit: money("gross_profit"),
  operatingExpenses: money("operating_expenses"),
  result: jsonb("result"),
  closingJournalId: integer("closing_journal_id"),
  /** Month-end revaluation of franc balances at the closing rate, posted when the month closes. */
  revaluationJournalId: integer("revaluation_journal_id"),
  closedAt: timestamp("closed_at"),
  closedBy: integer("closed_by"),
});

// ---------------------------------------------------------------- Operating expenses

export const expenses = pgTable(
  "expenses",
  {
    id: serial("id").primaryKey(),
    date: date("date").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    description: text("description").notNull(),
    amountNative: money("amount_native").notNull(),
    currency: varchar("currency", { length: 3 }).$type<Currency>().notNull().default("USD"),
    rate: numeric("rate", { precision: 14, scale: 4 }),
    amountUsd: money("amount_usd").notNull(),
    paidFromAccountId: integer("paid_from_account_id").references(() => accounts.id),
    /** Unpaid bill: owed to this party instead of paid from a money account. */
    payablePartyId: integer("payable_party_id").references(() => parties.id),
    journalId: integer("journal_id"),
    voidedAt: timestamp("voided_at"),
    voidJournalId: integer("void_journal_id"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ dateIdx: index("expenses_date_idx").on(t.date) }),
);

// ---------------------------------------------------------------- Containers

export const CONTAINER_STATUSES = ["draft", "in_transit", "arrived", "finalized"] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

export const containers = pgTable("containers", {
  id: serial("id").primaryKey(),
  number: varchar("number", { length: 60 }).notNull().unique(),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => parties.id),
  status: varchar("status", { length: 20 }).$type<ContainerStatus>().notNull().default("draft"),
  /** Currency of the supplier invoice (USD, CNY…). */
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  /** USD per 1 unit of the invoice currency. */
  rateToUsd: numeric("rate_to_usd", { precision: 14, scale: 6 }).notNull().default("1"),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id),
  shipDate: date("ship_date"),
  arrivalDate: date("arrival_date"),
  offloadDate: date("offload_date"),
  notes: text("notes"),
  fobTotalUsd: money("fob_total_usd"),
  expensesTotalUsd: money("expenses_total_usd"),
  landedTotalUsd: money("landed_total_usd"),
  finalizeJournalId: integer("finalize_journal_id"),
  finalizedAt: timestamp("finalized_at"),
  finalizedBy: integer("finalized_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const containerLines = pgTable(
  "container_lines",
  {
    id: serial("id").primaryKey(),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    quantity: qty("quantity").notNull(),
    unitPrice: unitCost("unit_price").notNull(),
    weightKg: qty("weight_kg"),
    volumeCbm: qty("volume_cbm"),
    fobUsd: money("fob_usd"),
    allocatedUsd: money("allocated_usd"),
    landedTotalUsd: money("landed_total_usd"),
    landedUnitCost: unitCost("landed_unit_cost"),
  },
  (t) => ({ containerIdx: index("container_lines_container_idx").on(t.containerId) }),
);

export const CONTAINER_EXPENSE_TYPES = [
  "freight",
  "duties",
  "clearing",
  "transport",
  "handling",
  "offload_labour",
  "insurance",
  "other",
] as const;

export const containerExpenses = pgTable(
  "container_expenses",
  {
    id: serial("id").primaryKey(),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id),
    date: date("date").notNull(),
    type: varchar("type", { length: 30 }).notNull(),
    description: text("description"),
    amountNative: money("amount_native").notNull(),
    currency: varchar("currency", { length: 3 }).$type<Currency>().notNull().default("USD"),
    rate: numeric("rate", { precision: 14, scale: 4 }),
    amountUsd: money("amount_usd").notNull(),
    method: varchar("method", { length: 20 }).notNull().default("value"),
    targetLineId: integer("target_line_id"),
    paidFromAccountId: integer("paid_from_account_id").references(() => accounts.id),
    payablePartyId: integer("payable_party_id").references(() => parties.id),
    journalId: integer("journal_id"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ containerIdx: index("container_expenses_container_idx").on(t.containerId) }),
);

// ---------------------------------------------------------------- Sales

export const sales = pgTable(
  "sales",
  {
    id: serial("id").primaryKey(),
    number: varchar("number", { length: 20 }).notNull().unique(),
    date: date("date").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id),
    customerId: integer("customer_id").references(() => parties.id),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    subtotal: money("subtotal").notNull(),
    discount: money("discount").notNull().default("0"),
    total: money("total").notNull(),
    paidUsd: money("paid_usd").notNull(),
    creditUsd: money("credit_usd").notNull().default("0"),
    cogs: money("cogs").notNull(),
    note: text("note"),
    journalId: integer("journal_id"),
    voidJournalId: integer("void_journal_id"),
    voidedAt: timestamp("voided_at"),
    voidReason: text("void_reason"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ dateIdx: index("sales_date_idx").on(t.date) }),
);

export const saleLines = pgTable(
  "sale_lines",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id")
      .notNull()
      .references(() => sales.id),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    unitId: integer("unit_id"),
    qty: qty("qty").notNull(),
    unitPrice: money("unit_price").notNull(),
    lineDiscount: money("line_discount").notNull().default("0"),
    lineTotal: money("line_total").notNull(),
    /** Cost removed from stock for this line, fixed at the moment of sale. */
    cogs: money("cogs").notNull(),
    returnedQty: qty("returned_qty").notNull().default("0"),
  },
  (t) => ({ saleIdx: index("sale_lines_sale_idx").on(t.saleId) }),
);

export const salePayments = pgTable("sale_payments", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id")
    .notNull()
    .references(() => sales.id),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  currency: varchar("currency", { length: 3 }).$type<Currency>().notNull(),
  amountNative: money("amount_native").notNull(),
  rate: numeric("rate", { precision: 14, scale: 4 }),
  amountUsd: money("amount_usd").notNull(),
});

export const saleReturns = pgTable("sale_returns", {
  id: serial("id").primaryKey(),
  number: varchar("number", { length: 20 }).notNull().unique(),
  saleId: integer("sale_id")
    .notNull()
    .references(() => sales.id),
  date: date("date").notNull(),
  total: money("total").notNull(),
  cogs: money("cogs").notNull(),
  refundAccountId: integer("refund_account_id").references(() => accounts.id),
  reason: text("reason"),
  journalId: integer("journal_id"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const saleReturnLines = pgTable("sale_return_lines", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id")
    .notNull()
    .references(() => saleReturns.id),
  saleLineId: integer("sale_line_id")
    .notNull()
    .references(() => saleLines.id),
  qty: qty("qty").notNull(),
  amount: money("amount").notNull(),
  cogs: money("cogs").notNull(),
});

// ---------------------------------------------------------------- Stock adjustments & transfers

export const stockAdjustments = pgTable("stock_adjustments", {
  id: serial("id").primaryKey(),
  number: varchar("number", { length: 20 }).notNull().unique(),
  date: date("date").notNull(),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id),
  kind: varchar("kind", { length: 20 }).notNull(),
  reason: text("reason").notNull(),
  journalId: integer("journal_id"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});


// ---------------------------------------------------------------- Optional vouchers & payroll

export const DRAFT_KINDS = ["payment", "receipt", "journal", "transfer", "adjustment"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * Optional vouchers: saved but not posted. They touch no balance, stock or report until
 * finalized, which posts them through the same checks as a voucher saved directly.
 */
export const voucherDrafts = pgTable("voucher_drafts", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 20 }).$type<DraftKind>().notNull(),
  date: date("date").notNull(),
  memo: text("memo"),
  totalUsd: money("total_usd"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export interface PayrollLine {
  partyId: number;
  name: string;
  salary: string;
  bonus: string;
  deduction: string;
  net: string;
}

/** One salary run per month: Dr salaries expense, Cr what is owed to each employee. */
export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  month: varchar("month", { length: 7 }).notNull().unique(),
  date: date("date").notNull(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  totalUsd: money("total_usd").notNull(),
  lines: jsonb("lines").$type<PayrollLine[]>().notNull(),
  journalId: integer("journal_id"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
