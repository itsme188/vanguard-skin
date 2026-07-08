-- lib/db/migrations/065_earnings_intel.sql
-- Earnings intelligence tier (audit §4C #9/#10).
-- Spec: docs/superpowers/specs/2026-07-08-earnings-intelligence-design.md

CREATE TABLE earnings_report_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol              TEXT NOT NULL,
  reported_date       TEXT NOT NULL,
  fiscal_date_ending  TEXT,
  eps_actual          REAL,
  eps_estimate        REAL,
  surprise_pct        REAL,
  report_time         TEXT,
  post_print_move_pct REAL,
  source              TEXT NOT NULL DEFAULT 'alphavantage',
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, reported_date)
);
CREATE INDEX idx_earnings_report_history_symbol ON earnings_report_history(symbol);

CREATE TABLE earnings_intel (
  event_id         INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  implied_move_pct REAL,
  implied_method   TEXT,
  expiry_used      TEXT,
  straddle_mid     REAL,
  spot             REAL,
  computed_at      TEXT NOT NULL
);
