CREATE TABLE "payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" varchar(7) NOT NULL,
	"date" date NOT NULL,
	"account_id" integer NOT NULL,
	"total_usd" numeric(20, 2) NOT NULL,
	"lines" jsonb NOT NULL,
	"journal_id" integer,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "voucher_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(20) NOT NULL,
	"date" date NOT NULL,
	"memo" text,
	"total_usd" numeric(20, 2),
	"payload" jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "position" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "monthly_salary" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;