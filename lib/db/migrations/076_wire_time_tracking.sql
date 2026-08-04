-- 076_wire_time_tracking.sql
-- Earnings wire-time tracking (spec 2026-08-04): observed print times per
-- (symbol, quarter) + per-symbol standing release-time overrides.

CREATE TABLE earnings_wire_observations (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_id INTEGER,
  first_seen_at TEXT NOT NULL,
  last_empty_probe_at TEXT,
  source TEXT NOT NULL DEFAULT 'finnhub_probe',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, event_date, source)
);

CREATE TABLE symbol_release_times (
  symbol TEXT PRIMARY KEY,
  release_time TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  verified_for_date TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE calendar_events ADD COLUMN wire_probe_empty_at TEXT;
