-- Structured post-call quick-capture notes, one per earnings event.
-- symbol denormalized for family-history reads; guidance is the queryable
-- signal for the future intelligence tier ("which names lowered guidance").
CREATE TABLE earnings_call_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
  security_id INTEGER REFERENCES securities(id),
  symbol TEXT NOT NULL,
  guidance TEXT CHECK(guidance IN ('raised','inline','lowered','not_given') OR guidance IS NULL),
  tone TEXT,
  surprises TEXT,
  follow_ups TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_earnings_call_notes_symbol ON earnings_call_notes(symbol);
