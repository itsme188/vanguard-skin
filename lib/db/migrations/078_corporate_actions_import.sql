-- Import-sourced corporate actions (spec 2026-08-11, issue #37).
-- source='import' rows are REPLAY-mode: computeTaxLots applies them
-- chronologically; history is never rewritten. source='manual' rows keep
-- the legacy rewrite semantics and are excluded from the replay.
ALTER TABLE corporate_actions ADD COLUMN source_key TEXT;
ALTER TABLE corporate_actions ADD COLUMN import_batch_id INTEGER REFERENCES import_batches(id);
-- account the statement evidence belongs to (delta cross-check scope);
-- the split itself applies to every account's lots.
ALTER TABLE corporate_actions ADD COLUMN account_id INTEGER REFERENCES accounts(id);
-- statement's Quantity column (share delta) — evidence, never the booking truth
ALTER TABLE corporate_actions ADD COLUMN quantity_delta REAL;
-- persisted cross-check result; NULL = clean (only meaningful after a successful replay)
ALTER TABLE corporate_actions ADD COLUMN reconcile_delta REAL;

CREATE UNIQUE INDEX idx_corporate_actions_source_key
  ON corporate_actions(source_key) WHERE source_key IS NOT NULL;
