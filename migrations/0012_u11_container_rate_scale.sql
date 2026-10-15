-- A franc container's rate is USD per 1 FC (about 0.000356): six decimals rounded 1 $ = 2 808 FC to
-- 0.000356 (2 809 FC) and 35 000 000 FC to 12 460 $ instead of 12 464,39 $. Twelve decimals keep it exact to the cent.
ALTER TABLE "containers" ALTER COLUMN "rate_to_usd" SET DATA TYPE numeric(24, 12);
