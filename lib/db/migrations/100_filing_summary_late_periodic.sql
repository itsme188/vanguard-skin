-- 100 — filing summary: the late periodic report (10-Q / 10-K filed after the
-- print night). Spec: docs/superpowers/specs/2026-10-29-late-periodic-report-design.md.
-- Additive only, owner-approved shape (2026-10-29):
--  * filing_summary_filings.arrival: 'evening' for every filing the evening
--    poll stores (every existing row reads 'evening' through the default);
--    'late' for the 10-Q / 10-K the late watch stores after the 21:00 cutoff.
--    A late filing is stored with role 'companion'. Evening readers go through
--    the one helper in lib/filing-summary/store.ts (`eveningFilingSql` /
--    `listFilings`), so a late filing never enters the evening run, the
--    evening view, the share page or the push. The table is NOT rebuilt (its
--    children cascade-delete); ALTER TABLE ADD COLUMN keeps every row and id.
--  * filing_summary_late_watch: one row per print whose late watch has been
--    opened: watching until window_ends_at (16:00 Eastern on the next trading
--    day after the print), then found / ended; cancelled when disarmed.
ALTER TABLE filing_summary_filings
  ADD COLUMN arrival TEXT NOT NULL DEFAULT 'evening'
  CHECK (arrival IN ('evening','late'));

CREATE TABLE filing_summary_late_watch (
  event_id INTEGER PRIMARY KEY REFERENCES filing_summary_events(event_id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'watching'
    CHECK (state IN ('watching','found','ended','cancelled')),
  window_ends_at TEXT NOT NULL,
  last_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
