ALTER TABLE "exchange_rates" ADD COLUMN "cny_per_usd" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "periods" ADD COLUMN "shares" jsonb;