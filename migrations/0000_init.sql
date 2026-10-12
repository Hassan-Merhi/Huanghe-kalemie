CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"type" varchar(20) NOT NULL,
	"system_key" varchar(40),
	"is_money" boolean DEFAULT false NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"partner_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "accounts_system_key_unique" UNIQUE("system_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" varchar(60) NOT NULL,
	"entity" varchar(40) NOT NULL,
	"entity_id" integer,
	"data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"container_id" integer NOT NULL,
	"date" date NOT NULL,
	"type" varchar(30) NOT NULL,
	"description" text,
	"amount_native" numeric(20, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"rate" numeric(14, 4),
	"amount_usd" numeric(20, 2) NOT NULL,
	"method" varchar(20) DEFAULT 'value' NOT NULL,
	"target_line_id" integer,
	"paid_from_account_id" integer,
	"payable_party_id" integer,
	"journal_id" integer,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"container_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"quantity" numeric(15, 3) NOT NULL,
	"unit_price" numeric(20, 6) NOT NULL,
	"weight_kg" numeric(15, 3),
	"volume_cbm" numeric(15, 3),
	"fob_usd" numeric(20, 2),
	"allocated_usd" numeric(20, 2),
	"landed_total_usd" numeric(20, 2),
	"landed_unit_cost" numeric(20, 6)
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(60) NOT NULL,
	"supplier_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"rate_to_usd" numeric(14, 6) DEFAULT '1' NOT NULL,
	"location_id" integer NOT NULL,
	"ship_date" date,
	"arrival_date" date,
	"offload_date" date,
	"notes" text,
	"fob_total_usd" numeric(20, 2),
	"expenses_total_usd" numeric(20, 2),
	"landed_total_usd" numeric(20, 2),
	"finalize_journal_id" integer,
	"finalized_at" timestamp,
	"finalized_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "containers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"date" date PRIMARY KEY NOT NULL,
	"cdf_per_usd" numeric(14, 4) NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"account_id" integer NOT NULL,
	"description" text NOT NULL,
	"amount_native" numeric(20, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"rate" numeric(14, 4),
	"amount_usd" numeric(20, 2) NOT NULL,
	"paid_from_account_id" integer,
	"payable_party_id" integer,
	"journal_id" integer,
	"voided_at" timestamp,
	"void_journal_id" integer,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"journal_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"debit" numeric(20, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 2) DEFAULT '0' NOT NULL,
	"party_id" integer,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"native_amount" numeric(20, 2),
	"rate" numeric(14, 4),
	"memo" text,
	CONSTRAINT "journal_lines_one_sided" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0 AND ("journal_lines"."debit" = 0 OR "journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(20) NOT NULL,
	"date" date NOT NULL,
	"type" varchar(30) NOT NULL,
	"memo" text,
	"source_type" varchar(30),
	"source_id" integer,
	"reverses_journal_id" integer,
	"reversed_by_journal_id" integer,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "journals_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "locations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "motorcycle_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"chassis_no" varchar(60),
	"engine_no" varchar(60),
	"color" text,
	"container_id" integer,
	"status" varchar(20) DEFAULT 'in_stock' NOT NULL,
	"sale_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "motorcycle_units_chassis_no_unique" UNIQUE("chassis_no")
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"phone" varchar(40),
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"share_pct" numeric(5, 2) NOT NULL,
	"bears_operating_expenses" boolean DEFAULT false NOT NULL,
	"current_account_id" integer NOT NULL,
	"capital_account_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" varchar(7) NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"gross_profit" numeric(20, 2),
	"operating_expenses" numeric(20, 2),
	"result" jsonb,
	"closing_journal_id" integer,
	"closed_at" timestamp,
	"closed_by" integer,
	CONSTRAINT "periods_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category_id" integer,
	"brand" text DEFAULT 'Huanghe' NOT NULL,
	"unit" varchar(20) DEFAULT 'pcs' NOT NULL,
	"description" text,
	"tracks_serials" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"unit_id" integer,
	"qty" numeric(15, 3) NOT NULL,
	"unit_price" numeric(20, 2) NOT NULL,
	"line_discount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(20, 2) NOT NULL,
	"cogs" numeric(20, 2) NOT NULL,
	"returned_qty" numeric(15, 3) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount_native" numeric(20, 2) NOT NULL,
	"rate" numeric(14, 4),
	"amount_usd" numeric(20, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_return_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_id" integer NOT NULL,
	"sale_line_id" integer NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"cogs" numeric(20, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(20) NOT NULL,
	"sale_id" integer NOT NULL,
	"date" date NOT NULL,
	"total" numeric(20, 2) NOT NULL,
	"cogs" numeric(20, 2) NOT NULL,
	"refund_account_id" integer,
	"reason" text,
	"journal_id" integer,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sale_returns_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(20) NOT NULL,
	"date" date NOT NULL,
	"location_id" integer NOT NULL,
	"customer_id" integer,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"subtotal" numeric(20, 2) NOT NULL,
	"discount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total" numeric(20, 2) NOT NULL,
	"paid_usd" numeric(20, 2) NOT NULL,
	"credit_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"cogs" numeric(20, 2) NOT NULL,
	"note" text,
	"journal_id" integer,
	"void_journal_id" integer,
	"voided_at" timestamp,
	"void_reason" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sales_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(20) NOT NULL,
	"date" date NOT NULL,
	"location_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"reason" text NOT NULL,
	"journal_id" integer,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "stock_levels_variant_id_location_id_pk" PRIMARY KEY("variant_id","location_id"),
	CONSTRAINT "stock_levels_non_negative" CHECK ("stock_levels"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"type" varchar(30) NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"value" numeric(20, 2) NOT NULL,
	"source_type" varchar(30),
	"source_id" integer,
	"journal_id" integer,
	"note" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(60) NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"role" varchar(20) NOT NULL,
	"partner_id" integer,
	"language" varchar(2) DEFAULT 'fr' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"sku" varchar(60) NOT NULL,
	"barcode" varchar(64),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sell_price" numeric(20, 2) DEFAULT '0' NOT NULL,
	"reorder_level" numeric(15, 3) DEFAULT '0' NOT NULL,
	"stock_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"stock_value" numeric(20, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "variants_sku_unique" UNIQUE("sku"),
	CONSTRAINT "variants_barcode_unique" UNIQUE("barcode"),
	CONSTRAINT "variants_stock_non_negative" CHECK ("variants"."stock_qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "container_expenses" ADD CONSTRAINT "container_expenses_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_expenses" ADD CONSTRAINT "container_expenses_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_expenses" ADD CONSTRAINT "container_expenses_payable_party_id_parties_id_fk" FOREIGN KEY ("payable_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_lines" ADD CONSTRAINT "container_lines_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_lines" ADD CONSTRAINT "container_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_supplier_id_parties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payable_party_id_parties_id_fk" FOREIGN KEY ("payable_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motorcycle_units" ADD CONSTRAINT "motorcycle_units_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motorcycle_units" ADD CONSTRAINT "motorcycle_units_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_return_id_sale_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sale_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_refund_account_id_accounts_id_fk" FOREIGN KEY ("refund_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_parties_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "container_expenses_container_idx" ON "container_expenses" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "container_lines_container_idx" ON "container_lines" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("date");--> statement-breakpoint
CREATE INDEX "journal_lines_journal_idx" ON "journal_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_party_idx" ON "journal_lines" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "journals_date_idx" ON "journals" USING btree ("date");--> statement-breakpoint
CREATE INDEX "journals_source_idx" ON "journals" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "motorcycle_units_variant_idx" ON "motorcycle_units" USING btree ("variant_id","status");--> statement-breakpoint
CREATE INDEX "parties_type_idx" ON "parties" USING btree ("type","name");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sale_lines_sale_idx" ON "sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sales_date_idx" ON "sales" USING btree ("date");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_idx" ON "stock_movements" USING btree ("variant_id","date");--> statement-breakpoint
CREATE INDEX "stock_movements_source_idx" ON "stock_movements" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "variants" USING btree ("product_id");