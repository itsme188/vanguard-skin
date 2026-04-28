-- Earnings bogeys — user-curated consensus + whisper numbers per event.
-- Sprint: 2026-04-28 polish-pass Track D. Plan: ~/.claude/plans/okay-now-that-we-idempotent-yao.md
--
-- Multiple sources can carry bogeys for one event (e.g., TMT Breakout +
-- Vital Knowledge + manual entry). All are stored; the email composer
-- prefers the most-recently-uploaded set when composing the preview /
-- recap, but renders all sources alongside in the prompt for context.
--
-- Whisper numbers (eps_whisper / revenue_whisper_usd) are the killer
-- feature here — Finnhub doesn't carry them, so this table is the only
-- way they reach the AI prompt + scoreboard.
--
-- A single multi-symbol PDF (e.g., TMT Breakout's "earnings this week"
-- preview page) fans out to N rows, one per matched calendar_events.id.
-- The fan-out logic lives in lib/earnings/extract-bogeys.ts.

CREATE TABLE IF NOT EXISTS earnings_bogeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,

  -- Provenance. 'pdf_upload' = drag-and-dropped multi-symbol preview PDF;
  -- 'manual' = typed by user via per-event modal; 'newsletter' = future
  -- (extracted from research_articles raw_text, deferred for v1).
  source TEXT NOT NULL CHECK (source IN ('pdf_upload', 'manual', 'newsletter')),
  -- Free-text label for the source — e.g., "TMT Breakout 2026-04-28 weekly
  -- preview" or "user note 14:32". Surfaced to the user in the composer's
  -- attribution row beneath the scoreboard.
  source_label TEXT,
  source_url TEXT,
  raw_pdf_r2_key TEXT,
  research_document_id INTEGER REFERENCES research_documents(id),
  research_article_id INTEGER REFERENCES research_articles(id),

  -- Numeric bogeys. Always nullable — different sources cover different
  -- subsets (some give EPS only, some give segment splits only).
  eps_consensus REAL,
  eps_whisper REAL,
  revenue_consensus_usd REAL,
  revenue_whisper_usd REAL,

  -- JSON: {"Network": {"consensus": 1234000000, "whisper": 1240000000},
  -- "Optical": {...}}. Optional; for issuers with reportable segments.
  segment_breakdown_json TEXT,
  -- Free-text guidance lines, e.g., "FY26 guide $19.5-20.0B revenue,
  -- 24-25% op margin". Surfaced to the AI prompt verbatim.
  guidance_notes TEXT,
  -- Free-text user notes attached at upload / manual-entry time.
  notes TEXT,

  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_extraction_model TEXT,

  -- Idempotency: a re-upload of the same source for the same event is a
  -- no-op. NULL source_label coalesces to '' so multiple manual entries
  -- with no label collapse into one — that's the desired behavior.
  UNIQUE(event_id, source, source_label)
);

CREATE INDEX IF NOT EXISTS idx_earnings_bogeys_event
  ON earnings_bogeys(event_id);
CREATE INDEX IF NOT EXISTS idx_earnings_bogeys_uploaded
  ON earnings_bogeys(uploaded_at DESC);
