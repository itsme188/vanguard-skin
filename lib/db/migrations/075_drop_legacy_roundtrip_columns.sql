-- Drop the legacy scrambled-name columns kept by migration 047 for
-- backward-compat reads. 047's UPDATE copied all data into the
-- correctly-named columns (assessment / what_went_well / what_went_wrong);
-- verified 2026-08-03: 213 rows, zero rows with legacy-only content.
-- Readers' pragma-detect fallbacks are removed in the same commit.

ALTER TABLE trade_roundtrips DROP COLUMN entry_thesis;
ALTER TABLE trade_roundtrips DROP COLUMN exit_assessment;
