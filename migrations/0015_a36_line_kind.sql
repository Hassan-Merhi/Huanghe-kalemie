-- Lines the books write themselves are marked by kind, never told apart by their memo: a memo typed on
-- a voucher line is the person's own text. fx_usd keeps, on each franc or yuan line valued at its
-- balance's average cost, the exchange difference that moved, so a journal settling two contacts' yuan
-- keeps each one's.
ALTER TABLE "journal_lines" ADD COLUMN "kind" varchar(16);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "fx_usd" numeric(20, 2);--> statement-breakpoint
-- Lines written before: by their memo and their shape, never in a journal typed by hand (the same as
-- markSystemLines, run on a restored backup made before this migration).
UPDATE "journal_lines" l SET "kind" = CASE
    WHEN l."memo" = 'Écart de change (coût moyen des devises)' THEN 'cost_fx'
    WHEN l."memo" = 'Reste de moins d''un demi-centime soldé en écart de change' THEN 'residue'
    WHEN l."memo" = 'Écart de change du règlement repris à l''annulation' THEN 'settled_fx'
    ELSE 'revalued' END
  FROM "journals" j, "accounts" a
  WHERE j."id" = l."journal_id" AND a."id" = l."account_id" AND j."type" NOT IN ('manual', 'opening') AND (
    (l."memo" = 'Écart de change (coût moyen des devises)' AND a."system_key" = 'fx')
    OR (l."memo" = 'Reste de moins d''un demi-centime soldé en écart de change' AND abs(l."debit" - l."credit") <= 0.01)
    OR (l."memo" = 'Écart de change du règlement repris à l''annulation' AND j."type" IN ('container_reversal', 'reversal')
        AND (a."system_key" = 'fx' OR (l."currency" = 'CNY' AND l."native_amount" = 0)))
    OR (l."memo" = 'Écart de change à l''annulation' AND j."type" NOT IN ('payment', 'receipt')
        AND (a."system_key" = 'fx' OR l."native_amount" IS NULL OR l."native_amount" = 0 OR (l."rate" > 0 AND abs(l."native_amount") / l."rate" < 0.006)))
  );
