-- Audit log for earnings preview/recap emails. Sprint: 2026-04-28 Phase 2.
-- Plan: ~/.claude/plans/okay-let-s-see-if-joyful-feather.md (Phase 2.1)
--
-- One row per (event, phase) pair. Inserted by sendEarningsEmail in
-- lib/digest/send-earnings-email.ts on successful send. UNIQUE constraint
-- prevents the same event_id+phase from being delivered twice — a hard
-- dedup floor underneath the cron's KV-marker dedup (Phase 3).
--
-- Phase 2 readers: the EarningsHub UI block reads this table to render
-- "preview-sent ✓" / "recap-sent ✓" status chips per row.

CREATE TABLE IF NOT EXISTS earnings_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('preview', 'recap')),
  recipient TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_input_hash TEXT,
  ai_output_md TEXT,
  error TEXT,
  UNIQUE(event_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_earnings_emails_event_phase
  ON earnings_emails(event_id, phase);
CREATE INDEX IF NOT EXISTS idx_earnings_emails_sent_at
  ON earnings_emails(sent_at DESC);
