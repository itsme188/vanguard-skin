-- Forward-to-research ingestion (U6): track each forwarded Gmail message that
-- the inbox poller has processed, so re-polls don't re-ingest it and failures
-- are visible/retriable. One row per Gmail message; a single message can
-- produce several documents (multiple attachments) — document_count records that.
CREATE TABLE IF NOT EXISTS research_inbox_messages (
  gmail_message_id TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'done',   -- 'done' | 'failed'
  document_id      INTEGER,                          -- first/primary research_documents row created
  document_count   INTEGER NOT NULL DEFAULT 0,
  subject          TEXT,
  from_addr        TEXT,
  error            TEXT,
  processed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_inbox_messages_processed
  ON research_inbox_messages (processed_at DESC);
