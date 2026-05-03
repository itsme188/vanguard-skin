-- Per-event preview/recap skip — TODO 2026-05-03.
--
-- The user can mute a symbol globally (earnings_emails_muted_symbols in
-- settings) or disable all earnings emails (earnings_emails_enabled). This
-- table fills the gap between those: a one-off "skip just this event" mark
-- that doesn't change global state.
--
-- One row per (event, phase) pair. Mirrors the earnings_emails audit-row
-- pattern so findEmailCandidates can LEFT JOIN both tables and exclude
-- either via NULL check. UNIQUE prevents redundant skip rows when the user
-- clicks the button twice.

CREATE TABLE IF NOT EXISTS earnings_email_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('preview', 'recap')),
  skipped_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_earnings_email_skips_event_phase
  ON earnings_email_skips(event_id, phase);
