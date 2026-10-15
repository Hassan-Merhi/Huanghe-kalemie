ALTER TABLE "idempotency_keys" ADD COLUMN "body_hash" varchar(64);--> statement-breakpoint
UPDATE "accounts" SET "name" = regexp_replace("name", ': profit share \(current account\)$', ' : compte de bénéfices') WHERE "partner_id" IS NOT NULL AND "name" LIKE '%: profit share (current account)';--> statement-breakpoint
UPDATE "accounts" SET "name" = regexp_replace("name", '([^ ]): capital$', '\1 : capital') WHERE "partner_id" IS NOT NULL AND "name" ~ '[^ ]: capital$';
