-- 085: live print-watch v1 (spec 2026-08-20 §5, v1 subset + Codex plan-review fixes).
-- Prints key to calendar_events.id (UNIQUE) with NO cascade: evidence must
-- survive event correction. ACCEPTED LIMITATION (plan header, deviation b):
-- a date-correction that deletes/re-homes the event mid-window orphans this
-- print (kept as evidence) and the sweep re-arm creates a fresh print for
-- the successor event.
CREATE TABLE print_watch_prints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  event_date TEXT NOT NULL,
  release_time_et TEXT,
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','window_open','acquired','parsed','expired','disarmed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE print_watch_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  kind TEXT NOT NULL CHECK (kind IN ('dj-release','edgar-ex99','ir-page','user-drop')),
  source TEXT NOT NULL,
  url TEXT,
  sha256 TEXT NOT NULL,
  bytes_path TEXT NOT NULL,
  parsed_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(print_id, kind, sha256)
);
CREATE TABLE print_watch_lines (
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  metric_id TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  expected_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','flash','single_source','agreed','conflict','blank','accepted')),
  value REAL, value_high REAL, snippet TEXT,
  source_doc_id INTEGER REFERENCES print_watch_documents(id),
  candidates_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (print_id, metric_id)
);
CREATE INDEX idx_pw_documents_print ON print_watch_documents(print_id);
