-- 091 — live print v2 slice D: the first-pass read and its verified callouts.
-- Additive only (two tables + indexes). Reads are identified by the SHA-256 of
-- the exact prompt DTO they were generated from; at most one generation per
-- (print, fingerprint, nonce). Callouts are model-PROPOSED figures that passed
-- mechanical verification; their identity is semantic (document content
-- identity + normalised label + unit) so a regeneration UPSERTS rather than
-- duplicates. doc_sha256 is slice B's content identity
-- (print_watch_documents.sha256, the UNIQUE(print_id, sha256) column);
-- evidence_sha256 is slice D's normalised-evidence-text hash (the text the
-- verifier ran against).
CREATE TABLE print_watch_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  fingerprint TEXT NOT NULL,
  nonce INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('generating', 'done', 'failed', 'superseded')),
  claim_token TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  model_id TEXT,
  facts_json TEXT,
  prose_json TEXT,
  error TEXT,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('model_error', 'timeout', 'sanitisation', 'model_drift', 'cites', 'attempt_cap', 'takeover')),
  generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (print_id, fingerprint, nonce)
);
CREATE INDEX idx_pw_reads_print ON print_watch_reads(print_id, status, id);
CREATE INDEX idx_pw_reads_retry ON print_watch_reads(status, next_retry_at);

CREATE TABLE print_watch_callouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  -- The read whose completion last wrote this row (association with read
  -- identity, review #14). SET NULL if that read row is ever deleted.
  read_id INTEGER REFERENCES print_watch_reads(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  label_norm TEXT NOT NULL,
  value REAL NOT NULL,
  value_high REAL,
  unit TEXT NOT NULL CHECK (unit IN ('usd', 'percent', 'per_share', 'count')),
  value_text TEXT NOT NULL,
  snippet TEXT NOT NULL,
  -- ON DELETE SET NULL: slice B's merge handler deletes a byte-twin document
  -- when two prints merge; the callout survives on doc_sha256 and readers
  -- re-resolve the document through print_watch_documents.sha256 (plan M-D12).
  doc_id INTEGER REFERENCES print_watch_documents(id) ON DELETE SET NULL,
  doc_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  verifier_version INTEGER NOT NULL,
  vs_bogey_text TEXT,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'accepted', 'revoked', 'superseded')),
  accepted_at TEXT,
  revoked_at TEXT,
  superseded_by_read_id INTEGER REFERENCES print_watch_reads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (print_id, doc_sha256, label_norm, unit)
);
CREATE INDEX idx_pw_callouts_print ON print_watch_callouts(print_id, state);
