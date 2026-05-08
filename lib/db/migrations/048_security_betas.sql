-- Security beta cache table — stores regression coefficients.
--
-- Beta measures a security's systematic risk relative to SPY. Computed via
-- linear regression of the security's daily returns against SPY's daily returns
-- over a configurable lookback window (e.g., 60 days, 252 days for one year).
--
-- This table caches computed betas to avoid re-running expensive regression
-- on every factor analysis or risk query. Each (security_id, lookback_days)
-- pair stores exactly one beta value + timestamp.

CREATE TABLE IF NOT EXISTS security_betas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  lookback_days INTEGER NOT NULL,
  beta REAL NOT NULL,
  computed_at TEXT NOT NULL,
  UNIQUE(security_id, lookback_days)
);

CREATE INDEX IF NOT EXISTS idx_security_betas_security
  ON security_betas(security_id);
