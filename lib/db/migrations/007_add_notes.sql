-- Notes / journaling system for investment thoughts.
-- Three types: journal (market thoughts), earnings (per-security earnings call notes),
-- and trade_thesis (rationale for buy/sell decisions).

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_type TEXT NOT NULL CHECK(note_type IN ('journal', 'earnings', 'trade_thesis')),
  content TEXT NOT NULL,
  security_id INTEGER REFERENCES securities(id),
  transaction_id INTEGER REFERENCES transactions(id),
  event_date TEXT NOT NULL,
  tags TEXT,
  sentiment TEXT CHECK(sentiment IN ('bullish', 'bearish', 'neutral', 'cautious', 'confident') OR sentiment IS NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notes_security ON notes(security_id);
CREATE INDEX idx_notes_type ON notes(note_type);
CREATE INDEX idx_notes_event_date ON notes(event_date);
