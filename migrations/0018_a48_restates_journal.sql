-- On a line a month's closing or reopening moves on a balance settled since its end: the posting on that
-- balance it restates (a payment, its undoing, a bill's reversal), so the francs it belongs to are those
-- that posting moved, whatever is posted the same day since. Lines written before keep none.
ALTER TABLE "journal_lines" ADD COLUMN "restates_journal_id" integer;
