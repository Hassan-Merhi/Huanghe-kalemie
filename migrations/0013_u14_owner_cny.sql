-- The yuan rate the owner set for a day, kept apart from the day's row: a manager saving the franc rate
-- took the row over, so the owner's yuan rate of that day stopped counting as the owner's.
ALTER TABLE "exchange_rates" ADD COLUMN "owner_cny_per_usd" numeric(14, 4);--> statement-breakpoint
UPDATE "exchange_rates" SET "owner_cny_per_usd" = "cny_per_usd"
  WHERE "cny_per_usd" IS NOT NULL AND "created_by" IN (SELECT "id" FROM "users" WHERE "role" = 'owner');
