-- Clarify trade_roundtrips column semantics.
--
-- Historical issue: the writer in lib/mutations/trade-reviews.ts maps the AI's
-- structured-output fields (`assessment`, `what_worked`, `what_didnt`) onto
-- columns whose names don't match — e.g. AI's `assessment` was stored in
-- `entry_thesis`, AI's `what_worked` in `exit_assessment`, AI's `what_didnt`
-- in `what_went_well`, and `what_went_wrong` was always NULL. Reads on the
-- Security Detail page used the column names literally, producing mislabeled
-- "Entry"/"Exit" sections that didn't match their content.
--
-- This migration:
--   1. Adds a properly-named `assessment` column.
--   2. Moves existing data into semantically correct columns.
--      The single UPDATE evaluates RHS using each row's OLD values, so the
--      three reassignments are atomic and don't collide.
--
-- Old `entry_thesis` and `exit_assessment` columns are kept for backward-compat
-- reads (legacy fallback in route.ts / page.tsx), but the writer stops
-- populating them after this migration.

ALTER TABLE trade_roundtrips ADD COLUMN assessment TEXT;

-- Move existing scrambled data into correctly-named columns.
-- Pre-migration content:
--   entry_thesis     = AI's "assessment"
--   exit_assessment  = AI's "what_worked"
--   what_went_well   = AI's "what_didnt"
--   what_went_wrong  = NULL (always)
-- Post-migration content:
--   assessment       = AI's "assessment"   (new column)
--   what_went_well   = AI's "what_worked"  (semantically correct)
--   what_went_wrong  = AI's "what_didnt"   (semantically correct)
--   entry_thesis     = unchanged (legacy, no longer authoritative)
--   exit_assessment  = unchanged (legacy, no longer authoritative)
UPDATE trade_roundtrips
SET
  assessment      = entry_thesis,
  what_went_wrong = what_went_well,
  what_went_well  = exit_assessment
WHERE assessment IS NULL;
