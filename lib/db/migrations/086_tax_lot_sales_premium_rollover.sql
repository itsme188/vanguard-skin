-- 086_tax_lot_sales_premium_rollover.sql
-- Flags exercised/assigned option closes whose premium rolled into the
-- linked underlying leg (IRS Pub 550: exercised premium adjusts the
-- underlying; it is not a separate disposition). Filing surfaces exclude
-- these rows; the engine regenerates them on every recompute.
ALTER TABLE tax_lot_sales ADD COLUMN premium_rollover INTEGER NOT NULL DEFAULT 0;
