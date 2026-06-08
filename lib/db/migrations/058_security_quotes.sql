-- Per-security market-data quote cache from the IBKR Web API
-- /iserver/marketdata/snapshot (headless OAuth, TWS-independent).
--
-- Captures the fundamentals the app had no source for: implied volatility,
-- 30-day historical volatility, and the 52-week trading range. (Dividend yield
-- column is reserved/nullable — the raw marketdata snapshot doesn't expose it;
-- a separate fundamentals endpoint would fill it later.)
--
-- One row per security (latest snapshot wins), mirroring the security_betas
-- cache pattern. Vols are stored as annualized FRACTIONS (0.24 = 24%);
-- dividend_yield (when populated) is a PERCENT (0.34 = 0.34%).

CREATE TABLE IF NOT EXISTS security_quotes (
  security_id    INTEGER PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
  as_of_date     TEXT NOT NULL,
  iv_underlying  REAL,
  hv_30d         REAL,
  week52_high    REAL,
  week52_low     REAL,
  dividend_yield REAL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
