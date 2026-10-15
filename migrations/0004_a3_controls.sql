ALTER TABLE "payroll_runs" DROP CONSTRAINT "payroll_runs_month_unique";--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "status" varchar(20) DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "currency" varchar(3) DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "rate" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "cancelled_by" integer;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "cancel_journal_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_posted_month" ON "payroll_runs" USING btree ("month") WHERE "payroll_runs"."status" = 'posted';