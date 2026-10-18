-- The cost per unit stock was added at (an adjustment, opening stock), to six decimals: its value is kept to
-- the cent, so 1 L at 0,125 $ goes in at 0,13 $. Shown as the item's cost while it still gives that value.
-- Movements made before keep none, and are shown as before.
ALTER TABLE "stock_movements" ADD COLUMN "unit_cost" numeric(20, 6);
