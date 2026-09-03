-- 088: live print v2, slice A (spec 2026-09-02 §4.1, §5).
-- Armed-as-covered needs: a prepare work table, a per-article scan ledger, a
-- cloud outbox for the Worker delta, and an earnings_bogeys rebuild that admits
-- the 'finnhub' consensus row. Deviation D1: the vendor EPS lives in its own
-- column so compileContracts (first non-null eps_consensus by rowid) can never
-- fill the adjusted-EPS expected value from a vendor figure.

CREATE TABLE earnings_prepare_steps (
  event_id          INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  step              TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','claimed','done','failed')),
  input_fingerprint TEXT,
  claim_token       TEXT,
  claimed_at        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, step)
);

CREATE TABLE earnings_bogey_scans (
  event_id          INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  article_id        INTEGER NOT NULL REFERENCES research_articles(id) ON DELETE CASCADE,
  extractor_version INTEGER NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('claimed','hit','no_numbers','error')),
  claim_token       TEXT,
  model_id          TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  scanned_at        TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, article_id, extractor_version)
);

CREATE TABLE cloud_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  payload_json TEXT    NOT NULL,
  written_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT,
  send_error   TEXT,
  UNIQUE (kind, generation)
);
CREATE INDEX idx_cloud_outbox_unsent ON cloud_outbox(kind, sent_at, generation);

-- earnings_bogeys rebuild (precedent: 069). Explicit column list, ids preserved.
CREATE TABLE earnings_bogeys_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('pdf_upload', 'manual', 'newsletter', 'finnhub')),
  source_label TEXT,
  source_url TEXT,
  raw_pdf_r2_key TEXT,
  research_document_id INTEGER REFERENCES research_documents(id),
  research_article_id INTEGER REFERENCES research_articles(id),
  eps_consensus REAL,
  eps_whisper REAL,
  revenue_consensus_usd REAL,
  revenue_whisper_usd REAL,
  segment_breakdown_json TEXT,
  guidance_notes TEXT,
  notes TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_extraction_model TEXT,
  expected_move_pct REAL,
  eps_consensus_vendor REAL,
  extra_metrics_json TEXT,
  UNIQUE(event_id, source, source_label)
);
INSERT INTO earnings_bogeys_new (
  id, event_id, source, source_label, source_url, raw_pdf_r2_key,
  research_document_id, research_article_id, eps_consensus, eps_whisper,
  revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
  guidance_notes, notes, uploaded_at, ai_extraction_model, expected_move_pct
)
SELECT
  id, event_id, source, source_label, source_url, raw_pdf_r2_key,
  research_document_id, research_article_id, eps_consensus, eps_whisper,
  revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
  guidance_notes, notes, uploaded_at, ai_extraction_model, expected_move_pct
FROM earnings_bogeys;
DROP TABLE earnings_bogeys;
ALTER TABLE earnings_bogeys_new RENAME TO earnings_bogeys;
CREATE INDEX idx_earnings_bogeys_event ON earnings_bogeys(event_id);
CREATE INDEX idx_earnings_bogeys_uploaded ON earnings_bogeys(uploaded_at DESC);
