-- 059_etf_sector_weights.sql
-- Per-ETF GICS sector weights for portfolio look-through. One row per (etf, sector).
-- Sourced via Claude+web_search; refreshed quarterly. Last-good rows are the fallback.
CREATE TABLE IF NOT EXISTS etf_sector_weights (
  etf_symbol   TEXT NOT NULL,
  sector       TEXT NOT NULL,   -- canonical GICS-11 label
  weight_pct   REAL NOT NULL,   -- 0..100
  as_of_date   TEXT NOT NULL,   -- YYYY-MM-DD
  source       TEXT NOT NULL,   -- 'claude_web_search' | 'manual'
  PRIMARY KEY (etf_symbol, sector)
);
