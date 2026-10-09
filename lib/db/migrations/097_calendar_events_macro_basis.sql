-- Migration 097: calendar_events macro basis columns (owner rulings 2026-10-08).
--
-- actual_refused_reason
--   Why a macro actual was refused and stored empty. Set when the fetched
--   actual is more than ten times both the consensus and the previous reading
--   on the same unit (a different basis or a scale error). NULL on every row
--   whose actual was stored, or was never refused. A later valid actual
--   clears it.
--
-- reference_period
--   The data period the actual refers to, taken from the FRED observation
--   date: "2026-08" for a monthly series, "2026-Q2" for quarterly GDP, the
--   week-ending date ("2026-08-29") for weekly claims. NULL until an actual
--   is fetched from FRED, and always NULL on non-FRED and earnings rows.
--
-- Both columns are nullable TEXT with no default. Additive only: no table
-- rebuild, no data rewrite, no backfill. Existing rows keep NULL in both.
-- The weekly sync upsert does not list either column, so a re-sync never
-- touches them.

ALTER TABLE calendar_events ADD COLUMN actual_refused_reason TEXT;
ALTER TABLE calendar_events ADD COLUMN reference_period TEXT;
