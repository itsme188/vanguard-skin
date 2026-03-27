-- Benchmark price history for comparison charts (SPY, QQQ, DIA, etc.)
-- Separate from `prices` (portfolio securities) and `ohlcv_bars` (candlestick charts).
CREATE TABLE IF NOT EXISTS benchmark_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close_price REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'tws',
  UNIQUE(symbol, date)
);
