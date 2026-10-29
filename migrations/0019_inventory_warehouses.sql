-- Existing locations remain top-level sites with their stock in place.
-- Warehouses are child locations and use the existing stock_levels / movements system.
ALTER TABLE "locations"
  ADD COLUMN "parent_id" integer REFERENCES "locations"("id");

-- A warehouse name may be reused at another site.
ALTER TABLE "locations"
  DROP CONSTRAINT IF EXISTS "locations_name_unique";

CREATE UNIQUE INDEX "locations_sibling_name_unique"
  ON "locations" (coalesce("parent_id", 0), "name");

CREATE INDEX "locations_parent_id_idx" ON "locations" ("parent_id");
