-- The franc cash box is called "Caisse FC" in the shop, as on every screen. Only the default name changes.
UPDATE "accounts" SET "name" = 'Caisse FC' WHERE "system_key" = 'cash_cdf' AND "name" = 'Caisse CDF';
