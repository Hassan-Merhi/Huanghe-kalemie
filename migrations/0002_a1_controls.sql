CREATE TABLE "idempotency_keys" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"method" varchar(10) NOT NULL,
	"path" text NOT NULL,
	"status" integer,
	"response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
