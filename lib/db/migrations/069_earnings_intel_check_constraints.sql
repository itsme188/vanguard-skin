-- lib/db/migrations/069_earnings_intel_check_constraints.sql
-- Deferred minor from the 2026-07-08 earnings-intelligence final review:
-- enum CHECK constraints on earnings_intel.implied_method and
-- earnings_report_history.report_time (migration 064 guidance-enum
-- precedent). SQLite cannot ALTER TABLE ... ADD CHECK, so both tables
-- rebuild via create-copy-drop-rename. Neither table has incoming FKs;
-- earnings_intel keeps its outgoing CASCADE FK to calendar_events.
-- Live data verified conforming before this migration (2026-07-21).

CREATE TABLE earnings_intel_new (
  event_id         INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  implied_move_pct REAL,
  implied_method   TEXT CHECK(implied_method IN ('straddle','iv_approx') OR implied_method IS NULL),
  expiry_used      TEXT,
  straddle_mid     REAL,
  spot             REAL,
  computed_at      TEXT NOT NULL
);
INSERT INTO earnings_intel_new
  SELECT event_id, implied_move_pct, implied_method, expiry_used, straddle_mid, spot, computed_at
  FROM earnings_intel;
DROP TABLE earnings_intel;
ALTER TABLE earnings_intel_new RENAME TO earnings_intel;

CREATE TABLE earnings_report_history_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol              TEXT NOT NULL,
  reported_date       TEXT NOT NULL,
  fiscal_date_ending  TEXT,
  eps_actual          REAL,
  eps_estimate        REAL,
  surprise_pct        REAL,
  report_time         TEXT CHECK(report_time IN ('pre-market','post-market') OR report_time IS NULL),
  post_print_move_pct REAL,
  source              TEXT NOT NULL DEFAULT 'alphavantage',
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, reported_date)
);
INSERT INTO earnings_report_history_new
  SELECT id, symbol, reported_date, fiscal_date_ending, eps_actual, eps_estimate,
         surprise_pct, report_time, post_print_move_pct, source, fetched_at
  FROM earnings_report_history;
DROP TABLE earnings_report_history;
ALTER TABLE earnings_report_history_new RENAME TO earnings_report_history;
CREATE INDEX idx_earnings_report_history_symbol ON earnings_report_history(symbol);
