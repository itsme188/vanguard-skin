-- Trade Reviews: monthly AI-generated trade analysis with per-trade grades.
-- trade_reviews stores one review per account per month (computed metrics + AI markdown).
-- trade_roundtrips stores individual buy→sell round-trips with AI assessments.

CREATE TABLE IF NOT EXISTS trade_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  import_batch_id INTEGER,

  -- Summary metrics (computed, not AI)
  total_trades INTEGER NOT NULL,
  winning_trades INTEGER NOT NULL,
  losing_trades INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  total_realized_pnl REAL NOT NULL,
  avg_holding_days REAL,
  best_trade_pnl REAL,
  best_trade_symbol TEXT,
  worst_trade_pnl REAL,
  worst_trade_symbol TEXT,
  avg_win REAL,
  avg_loss REAL,
  profit_factor REAL,

  -- AI-generated content
  review_markdown TEXT NOT NULL,
  trade_grades TEXT,
  patterns_identified TEXT,
  strengths TEXT,
  weaknesses TEXT,
  cumulative_patterns TEXT,

  -- Meta
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  generated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(account_id, period_start)
);

CREATE TABLE IF NOT EXISTS trade_roundtrips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,

  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  entry_quantity REAL NOT NULL,
  entry_cost REAL NOT NULL,

  exit_date TEXT NOT NULL,
  exit_price REAL NOT NULL,
  exit_quantity REAL NOT NULL,
  exit_proceeds REAL NOT NULL,

  holding_days INTEGER NOT NULL,
  realized_pnl REAL NOT NULL,
  return_pct REAL NOT NULL,

  grade TEXT,
  entry_thesis TEXT,
  exit_assessment TEXT,
  what_went_well TEXT,
  what_went_wrong TEXT,

  FOREIGN KEY(review_id) REFERENCES trade_reviews(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id)
);

CREATE INDEX IF NOT EXISTS idx_trade_reviews_account_period ON trade_reviews(account_id, period_start);
CREATE INDEX IF NOT EXISTS idx_trade_roundtrips_review ON trade_roundtrips(review_id);
CREATE INDEX IF NOT EXISTS idx_trade_roundtrips_symbol ON trade_roundtrips(symbol);
