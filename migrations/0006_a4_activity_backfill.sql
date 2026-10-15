-- Postings made before the activity log recorded every posting get their entry, dated when they were made.
INSERT INTO "audit_log" ("user_id", "action", "entity", "entity_id", "data", "created_at")
SELECT j."created_by",
       CASE WHEN j."reverses_journal_id" IS NULL THEN 'post' ELSE 'reverse' END,
       j."type",
       j."id",
       jsonb_build_object(
         'number', j."number",
         'date', to_char(j."date", 'YYYY-MM-DD'),
         'memo', j."memo",
         'total', (SELECT to_char(coalesce(sum(l."debit"), 0), 'FM999999999990.00') FROM "journal_lines" l WHERE l."journal_id" = j."id"),
         'sourceType', j."source_type",
         'sourceId', j."source_id"
       ),
       j."created_at"
FROM "journals" j
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_log" a WHERE a."entity_id" = j."id" AND a."action" IN ('post', 'reverse') AND a."entity" = j."type"
);
