-- French typography: a no-break space before the colon in the partners' account names ("Associé A : capital"),
-- so the colon never starts a line. Only names still in the shape the app gives them change.
UPDATE "accounts" SET "name" = regexp_replace("name", ' : (capital|compte de bénéfices)$', E'\u00a0: \\1') WHERE "partner_id" IS NOT NULL AND "name" ~ ' : (capital|compte de bénéfices)$';
