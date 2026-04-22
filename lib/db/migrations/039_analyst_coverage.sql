-- Analyst coverage cache. Three orthogonal Finnhub datasets, each with its
-- own semantics, so they live in separate tables rather than a polymorphic
-- blob:
--
--   analyst_recommendations - monthly buy/sell count history. Keyed on
--     (symbol, period) so re-syncs upsert the same row.
--
--   analyst_price_targets - latest consensus high/low/mean. One row per
--     symbol, overwritten on every sync.
--
--   analyst_rating_changes - event stream of upgrades/downgrades/inits.
--     Deduped on (symbol, rating_date, firm, to_grade) - same firm may
--     appear twice on the same day with different grades, which is fine.

CREATE TABLE analyst_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  period TEXT NOT NULL,              -- YYYY-MM-DD (first of month per Finnhub)
  strong_buy INTEGER,
  buy INTEGER,
  hold INTEGER,
  sell INTEGER,
  strong_sell INTEGER,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, period)
);

CREATE INDEX idx_analyst_recommendations_symbol_period
  ON analyst_recommendations(symbol, period DESC);

CREATE TABLE analyst_price_targets (
  symbol TEXT PRIMARY KEY,
  target_high REAL,
  target_low REAL,
  target_mean REAL,
  target_median REAL,
  number_of_analysts INTEGER,
  last_updated TEXT,                 -- Finnhub's lastUpdated field
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE analyst_rating_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  rating_date TEXT NOT NULL,         -- YYYY-MM-DD
  firm TEXT,                         -- "Morgan Stanley", etc.
  from_grade TEXT,
  to_grade TEXT,
  action TEXT,                       -- "up" | "down" | "main" | "init" per Finnhub
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, rating_date, firm, to_grade)
);

CREATE INDEX idx_analyst_rating_changes_symbol_date
  ON analyst_rating_changes(symbol, rating_date DESC);
