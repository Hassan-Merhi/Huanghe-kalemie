-- Journal numbers come from a sequence instead of the "journal" counters row: the row stayed locked
-- until the posting committed, so a posting that wrote two journals (an offload, then the deposits it
-- uses) could deadlock with a payment that took a franc balance before its number.
CREATE SEQUENCE "public"."journal_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
-- Numbering carries on after the last number given (the counter, or the highest J- number if higher).
SELECT setval('journal_number_seq', n, true) FROM (
  SELECT greatest(
    coalesce((SELECT "value" FROM "counters" WHERE "key" = 'journal'), 0),
    coalesce((SELECT max(substring("number" from 3)::bigint) FROM "journals" WHERE "number" ~ '^J-[0-9]{1,18}$'), 0)
  ) AS n
) x WHERE n > 0;--> statement-breakpoint
DELETE FROM "counters" WHERE "key" = 'journal';
