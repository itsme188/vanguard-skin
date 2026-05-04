-- Backfill canonical-csv transaction source_keys to include amount-as-cents suffix.
--
-- Pre-fix formula in parser: `canonical:txn:{acct}:{sym}:{date}:{type}` (5 colons).
-- Two same-day, same-symbol, same-type fills (e.g., a 400-share SELL and a 100-share
-- SELL on 2026-04-13) collided on source_key — second row silently skipped via INSERT
-- OR IGNORE on the unique source_key constraint. Symptom in production (2026-05-04):
-- one $19,664 RSP sell silently lost during April import.
--
-- Post-fix formula in parser: `canonical:txn:{acct}:{sym}:{date}:{type}:{cents}`
-- where cents = round(amount * 100) as integer (dodges JS/SQLite float-formatting drift).
--
-- This migration appends `:{cents}` to existing canonical:txn rows so re-uploads of
-- prior CSVs with the new parser formula match (idempotent — does not re-insert).
--
-- Idempotency guard: only updates rows whose source_key currently has exactly 5 colons
-- (the pre-fix format). Already-backfilled rows have 6 colons and are skipped.

UPDATE transactions
SET source_key = source_key || ':' || CAST(ROUND(COALESCE(amount, 0) * 100) AS INTEGER)
WHERE source_key LIKE 'canonical:txn:%'
  AND (LENGTH(source_key) - LENGTH(REPLACE(source_key, ':', ''))) = 5;
