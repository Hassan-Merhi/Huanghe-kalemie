-- The franc rate a sale was validated at (its francs' rate, else the day's), so a reprinted receipt reads
-- "≈ 151 632 FC · Taux : 1 $ = 2 808 FC" as it did, whatever the day's rate is corrected to since.
-- Sales made before keep none, and their receipts read the day's rate as before.
ALTER TABLE "sales" ADD COLUMN "cdf_rate" numeric(14, 4);
