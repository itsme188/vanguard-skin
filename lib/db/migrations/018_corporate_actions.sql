-- Corporate actions: stock splits, reverse splits, mergers, spinoffs
CREATE TABLE corporate_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,           -- SPLIT, REVERSE_SPLIT, MERGER, SPINOFF
  effective_date TEXT NOT NULL,
  ratio_numerator REAL NOT NULL,       -- new shares per old share (e.g., 2 for 2:1 split)
  ratio_denominator REAL NOT NULL DEFAULT 1,
  new_security_id INTEGER,             -- for mergers/spinoffs: resulting security
  cash_per_share REAL,                 -- for cash-in-lieu or merger cash component
  notes TEXT,
  applied INTEGER NOT NULL DEFAULT 0,  -- 1 = adjustments have been applied to historical data
  source TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(new_security_id) REFERENCES securities(id),
  UNIQUE(security_id, action_type, effective_date)
);
