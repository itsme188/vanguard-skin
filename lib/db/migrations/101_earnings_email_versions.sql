-- Recap storage review (2026-11-03): earnings_emails keeps ONE current body per
-- (event_id, phase). A later successful compose REPLACES it; the superseded body
-- is kept here so history is not lost and never pollutes the current body.
-- Additive only (a new table); existing rows are untouched.
CREATE TABLE IF NOT EXISTS earnings_email_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('preview', 'recap')),
  ai_output_md TEXT NOT NULL,
  ai_input_hash TEXT,
  sent_at TEXT,
  superseded_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_earnings_email_versions_event_phase
  ON earnings_email_versions(event_id, phase, superseded_at DESC);
