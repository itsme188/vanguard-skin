-- 099 — armed-print filing summary: the EDGAR filings found for an armed
-- earnings print, the documents read from each, and the checked summaries.
-- Additive only (six new tables + two indexes; no existing table changes).
-- filing_summary_events holds one row per armed print: the model choice
-- (family + effort; NULL = the default), the EDGAR poll state, and locked_at,
-- set when the first run is created (the choice cannot change after that).
-- Filings are unique per (event, accession) and numbered by discovery order;
-- documents are unique per (filing, file name). A run is one summary pass at
-- a fixed choice with a frozen bogey snapshot; it holds one section per
-- filing, claimed with a CAS token + heartbeat (the 091 read pattern), and its
-- status is recomputed whenever a section finishes. request_key makes a
-- client retry of "create run" idempotent, and last_retry_key does the same
-- for a Retry click. filing_summary_pushes records each
-- phone push before it is sent, so a crash mid-send reads delivery_unknown
-- rather than being sent twice.
CREATE TABLE filing_summary_events (
  event_id INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  family TEXT CHECK (family IS NULL OR family IN ('sonnet','opus','fable')),
  effort TEXT CHECK (effort IS NULL OR effort IN ('medium','high')),
  poll_state TEXT NOT NULL DEFAULT 'waiting' CHECK (poll_state IN
    ('waiting','found','past_cutoff','sec_unreachable','cancelled','no_cik','manual_only','ambiguous')),
  poll_detail TEXT,
  cik TEXT,
  last_polled_at TEXT,
  catchup_done INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE filing_summary_filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  accession TEXT NOT NULL,
  cik TEXT NOT NULL,
  form TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('earnings','companion')),
  items TEXT,
  accepted_at TEXT,
  discovered_at TEXT NOT NULL,
  discovery_seq INTEGER NOT NULL,
  identity_verdict TEXT NOT NULL CHECK (identity_verdict IN ('accepted','ambiguous','rejected','time_unconfirmed')),
  identity_reason TEXT,
  fetch_state TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_state IN ('pending','fetched','failed')),
  UNIQUE (event_id, accession)
);
CREATE TABLE filing_summary_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filing_id INTEGER NOT NULL REFERENCES filing_summary_filings(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetched','skipped','failed')),
  skip_reason TEXT,
  sha256 TEXT, byte_len INTEGER, stored_path TEXT,
  UNIQUE (filing_id, file_name)
);
CREATE TABLE filing_summary_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','rerun','manual_run')),
  family TEXT NOT NULL CHECK (family IN ('sonnet','opus','fable')),
  effort TEXT NOT NULL CHECK (effort IN ('medium','high')),
  model_id TEXT,
  fallback_note TEXT,
  request_key TEXT UNIQUE,
  last_retry_key TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  bogey_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (event_id, run_no)
);
CREATE TABLE filing_summary_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES filing_summary_runs(id) ON DELETE CASCADE,
  filing_id INTEGER NOT NULL REFERENCES filing_summary_filings(id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT, claimed_at TEXT, heartbeat_at TEXT,
  model_id TEXT, effort TEXT,
  input_fingerprint TEXT,
  output_json TEXT, checked_json TEXT, coverage_json TEXT,
  incomplete INTEGER NOT NULL DEFAULT 0,
  counts_json TEXT, usage_json TEXT, versions_json TEXT,
  error_class TEXT CHECK (error_class IS NULL OR error_class IN
    ('model_error','timeout','refusal','truncated','invalid_output','model_unavailable','input_too_large','attempt_cap','takeover','cancelled','awaiting_retry')),
  error_text TEXT,
  finished_at TEXT,
  UNIQUE (run_id, filing_id),
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_fs_sections_status ON filing_summary_sections(status, run_id, seq);
CREATE INDEX idx_fs_runs_event ON filing_summary_runs(event_id, run_no);
CREATE TABLE filing_summary_pushes (
  push_key TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','delivery_unknown','failed')),
  title TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
