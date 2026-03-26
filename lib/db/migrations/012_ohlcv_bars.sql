-- OHLCV bars for per-security candlestick charting (fetched from TWS)
-- bar_date: YYYY-MM-DD for daily bars, YYYY-MM-DD HH:MM for intraday
CREATE TABLE ohlcv_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  bar_date TEXT NOT NULL,
  bar_size TEXT NOT NULL DEFAULT '1 day',
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER,
  wap REAL,
  trade_count INTEGER,
  FOREIGN KEY(security_id) REFERENCES securities(id),
  UNIQUE(security_id, bar_date, bar_size)
);

-- Queries filter by (security_id, bar_size) — the UNIQUE constraint index covers
-- (security_id, bar_date, bar_size) but the column order doesn't serve bar_size-first lookups.
CREATE INDEX idx_ohlcv_bars_security_size ON ohlcv_bars(security_id, bar_size);
