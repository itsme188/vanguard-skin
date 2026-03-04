CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT,
  security_type TEXT,
  asset_class TEXT,
  source_key TEXT
);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  record_count INTEGER DEFAULT 0,
  summary TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  security_id INTEGER,
  import_batch_id INTEGER,
  trade_date TEXT NOT NULL,
  settlement_date TEXT,
  type TEXT NOT NULL,
  quantity REAL,
  amount REAL,
  price_per_share REAL,
  fees REAL DEFAULT 0,
  is_external_flow INTEGER DEFAULT 0,
  source_key TEXT UNIQUE,
  notes TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id)
);

CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  cost_basis REAL,
  as_of_date TEXT NOT NULL,
  import_batch_id INTEGER,
  source_key TEXT UNIQUE,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(account_id, security_id, as_of_date)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  close_price REAL NOT NULL,
  source TEXT DEFAULT 'manual',
  import_batch_id INTEGER,
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(security_id, date)
);

CREATE TABLE daily_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  valuation_date TEXT NOT NULL,
  cash_balance REAL NOT NULL,
  holdings_value REAL NOT NULL,
  total_value REAL NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  UNIQUE(account_id, valuation_date)
);

CREATE TABLE raw_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL,
  raw_data TEXT NOT NULL,
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id)
);

CREATE TABLE reconciliation_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  checkpoint_date TEXT NOT NULL,
  statement_value REAL NOT NULL,
  computed_value REAL,
  difference REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  UNIQUE(account_id, checkpoint_date)
);

CREATE TABLE tax_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  acquisition_transaction_id INTEGER,
  acquisition_date TEXT NOT NULL,
  acquisition_price REAL NOT NULL,
  quantity_acquired REAL NOT NULL,
  quantity_remaining REAL NOT NULL,
  cost_basis REAL NOT NULL,
  is_from_opening_snapshot INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(acquisition_transaction_id) REFERENCES transactions(id)
);

CREATE INDEX idx_tax_lots_account_security
  ON tax_lots(account_id, security_id, acquisition_date);

CREATE TABLE tax_lot_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_lot_id INTEGER NOT NULL,
  sale_transaction_id INTEGER NOT NULL,
  quantity_sold REAL NOT NULL,
  sale_price REAL NOT NULL,
  proceeds REAL NOT NULL,
  cost_basis_allocated REAL NOT NULL,
  realized_gain_loss REAL NOT NULL,
  is_long_term INTEGER NOT NULL,
  holding_period_days INTEGER NOT NULL,
  sale_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(tax_lot_id) REFERENCES tax_lots(id),
  FOREIGN KEY(sale_transaction_id) REFERENCES transactions(id)
);

CREATE INDEX idx_tax_lot_sales_transaction ON tax_lot_sales(sale_transaction_id);
CREATE INDEX idx_tax_lot_sales_date ON tax_lot_sales(sale_date);

CREATE TABLE monthly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  month_end_date TEXT NOT NULL,
  total_value REAL NOT NULL,
  source TEXT DEFAULT 'manual',
  notes TEXT,
  starting_value REAL,
  mark_to_market REAL,
  deposits_withdrawals REAL,
  dividends REAL,
  interest REAL,
  commissions REAL,
  fees REAL,
  other_pnl REAL,
  twr REAL,
  investment_gain REAL,
  import_batch_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(account_id, month_end_date)
);

CREATE INDEX idx_monthly_snapshots_date ON monthly_snapshots(month_end_date);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('start_date', '2025-01-01'),
  ('opening_snapshot_asof', '2024-12-31');
