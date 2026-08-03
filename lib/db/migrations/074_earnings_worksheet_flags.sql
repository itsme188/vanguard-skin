-- Printable one-page earnings worksheet (feedback #6, 2026-08-03).
-- Per-event opt-in: arming an event's flag auto-prints the monospace
-- worksheet (lp) at the preview tick; printed_at stamps once so it fires
-- exactly one time (re-arm = toggle off/on). Mirrors earnings_email_skips.
CREATE TABLE earnings_worksheet_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  printed_at TEXT
);
