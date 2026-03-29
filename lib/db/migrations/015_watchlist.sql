-- Watchlist: track securities the user is watching but doesn't own yet.
-- Supports price targets, investment thesis, and active/inactive state.

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL UNIQUE,
  added_date TEXT NOT NULL DEFAULT (date('now')),
  price_target_low REAL,
  price_target_high REAL,
  thesis TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(security_id) REFERENCES securities(id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_active ON watchlist(is_active);
