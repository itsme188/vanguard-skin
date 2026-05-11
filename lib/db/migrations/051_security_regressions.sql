-- Cached per-security regression coefficients vs a benchmark. Populated by
-- computeDailyValuations cron extension (~60 ops/day). Read by
-- FactorProfileSection on Security Detail (Task B4).
--
-- benchmark_symbol typically "SPY", "QQQ", or "VTI" — whichever benchmark the
-- user picks in the UI for the per-security factor lens.
--
-- computed_at_day is the YYYY-MM-DD the regression was computed against. The
-- newest row per (security_id, benchmark_symbol) is the live value; older rows
-- form the historical trend if a future feature wants beta drift.

CREATE TABLE IF NOT EXISTS security_regressions (
  security_id INTEGER NOT NULL,
  benchmark_symbol TEXT NOT NULL,
  computed_at_day TEXT NOT NULL,
  beta REAL,
  vol REAL,
  correlation REAL,
  r_squared REAL,
  data_points INTEGER,
  PRIMARY KEY (security_id, benchmark_symbol, computed_at_day),
  FOREIGN KEY (security_id) REFERENCES securities(id)
);

CREATE INDEX IF NOT EXISTS idx_security_regressions_lookup
  ON security_regressions(security_id, benchmark_symbol, computed_at_day DESC);
