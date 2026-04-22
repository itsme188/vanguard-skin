-- Claude-written one-sentence explanations for suggested S/R levels.
-- Cached per (security_id, level_price, direction) + day so repeat views
-- don't re-run Haiku. Narratives refresh daily to capture new price action
-- (e.g., a new touch, a break of a prior level).

CREATE TABLE IF NOT EXISTS suggested_level_narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  level_price REAL NOT NULL,
  direction TEXT NOT NULL,
  narrative TEXT NOT NULL,
  computed_at_day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (security_id) REFERENCES securities(id) ON DELETE CASCADE,
  UNIQUE (security_id, level_price, direction, computed_at_day)
);

CREATE INDEX IF NOT EXISTS idx_suggested_narratives_security_day
  ON suggested_level_narratives (security_id, computed_at_day);
