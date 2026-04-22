-- Expand the research_documents knowledge base to support:
--   * 5 additional document types (investor_letter, earnings_presentation,
--     article, book_summary_or_essay, macro_note) for better categorization
--     of non-standard-analyst-report uploads.
--   * tags column (JSON array of strings) — user-editable + AI-suggested.
-- Also rebuild the FTS5 virtual table to include `tags` in the searchable
-- corpus so "docs tagged macroeconomics" resolves via the same search path.
--
-- SQLite can't widen a CHECK constraint via ALTER, so we use the standard
-- create-copy-rename pattern. Triggers + FTS table are torn down first to
-- avoid re-entrancy on the intermediate state.

-- 1. Tear down FTS5 + triggers (they reference the old table shape).
DROP TRIGGER IF EXISTS research_documents_ai;
DROP TRIGGER IF EXISTS research_documents_ad;
DROP TRIGGER IF EXISTS research_documents_au;
DROP TABLE IF EXISTS research_documents_fts;

-- 2. Create the new table shape.
CREATE TABLE research_documents_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  source TEXT,
  filename TEXT NOT NULL,
  file_size_bytes INTEGER,
  publication_date TEXT,
  document_type TEXT CHECK (document_type IN (
    'analyst_report',
    'research_note',
    'market_analysis',
    'industry_primer',
    'investor_letter',
    'earnings_presentation',
    'article',
    'book_summary_or_essay',
    'macro_note',
    'other'
  )),
  raw_text TEXT NOT NULL,
  summary TEXT,
  key_points TEXT,
  mentioned_symbols TEXT,
  tags TEXT,                   -- JSON array of lowercased free-text tags
  sentiment TEXT CHECK (sentiment IN ('bullish', 'bearish', 'neutral', 'mixed') OR sentiment IS NULL),
  target_prices TEXT,
  ai_model TEXT,
  char_count INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Copy any existing rows over, preserving everything and leaving tags NULL.
INSERT INTO research_documents_v2 (
  id, title, author, source, filename, file_size_bytes, publication_date,
  document_type, raw_text, summary, key_points, mentioned_symbols,
  sentiment, target_prices, ai_model, char_count, uploaded_at, processed_at
)
SELECT
  id, title, author, source, filename, file_size_bytes, publication_date,
  document_type, raw_text, summary, key_points, mentioned_symbols,
  sentiment, target_prices, ai_model, char_count, uploaded_at, processed_at
FROM research_documents;

DROP TABLE research_documents;
ALTER TABLE research_documents_v2 RENAME TO research_documents;

-- 4. Recreate indices on the new table.
CREATE INDEX idx_research_documents_pub_date
  ON research_documents(publication_date DESC, uploaded_at DESC);
CREATE INDEX idx_research_documents_type
  ON research_documents(document_type);
CREATE INDEX idx_research_documents_uploaded
  ON research_documents(uploaded_at DESC);

-- 5. Recreate FTS5 table — adds tags as a searchable column.
CREATE VIRTUAL TABLE research_documents_fts USING fts5(
  title, author, source, summary, mentioned_symbols, tags, raw_text,
  content='research_documents',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- 6. Rebuild FTS index from any existing content.
INSERT INTO research_documents_fts(rowid, title, author, source, summary, mentioned_symbols, tags, raw_text)
SELECT id,
       COALESCE(title, ''),
       COALESCE(author, ''),
       COALESCE(source, ''),
       COALESCE(summary, ''),
       COALESCE(mentioned_symbols, ''),
       COALESCE(tags, ''),
       COALESCE(raw_text, '')
FROM research_documents;

-- 7. Recreate triggers with the tags column wired in.
CREATE TRIGGER research_documents_ai AFTER INSERT ON research_documents BEGIN
  INSERT INTO research_documents_fts(rowid, title, author, source, summary, mentioned_symbols, tags, raw_text)
  VALUES (new.id,
          COALESCE(new.title, ''),
          COALESCE(new.author, ''),
          COALESCE(new.source, ''),
          COALESCE(new.summary, ''),
          COALESCE(new.mentioned_symbols, ''),
          COALESCE(new.tags, ''),
          COALESCE(new.raw_text, ''));
END;

CREATE TRIGGER research_documents_ad AFTER DELETE ON research_documents BEGIN
  INSERT INTO research_documents_fts(research_documents_fts, rowid, title, author, source, summary, mentioned_symbols, tags, raw_text)
  VALUES ('delete', old.id,
          COALESCE(old.title, ''),
          COALESCE(old.author, ''),
          COALESCE(old.source, ''),
          COALESCE(old.summary, ''),
          COALESCE(old.mentioned_symbols, ''),
          COALESCE(old.tags, ''),
          COALESCE(old.raw_text, ''));
END;

CREATE TRIGGER research_documents_au AFTER UPDATE ON research_documents BEGIN
  INSERT INTO research_documents_fts(research_documents_fts, rowid, title, author, source, summary, mentioned_symbols, tags, raw_text)
  VALUES ('delete', old.id,
          COALESCE(old.title, ''),
          COALESCE(old.author, ''),
          COALESCE(old.source, ''),
          COALESCE(old.summary, ''),
          COALESCE(old.mentioned_symbols, ''),
          COALESCE(old.tags, ''),
          COALESCE(old.raw_text, ''));
  INSERT INTO research_documents_fts(rowid, title, author, source, summary, mentioned_symbols, tags, raw_text)
  VALUES (new.id,
          COALESCE(new.title, ''),
          COALESCE(new.author, ''),
          COALESCE(new.source, ''),
          COALESCE(new.summary, ''),
          COALESCE(new.mentioned_symbols, ''),
          COALESCE(new.tags, ''),
          COALESCE(new.raw_text, ''));
END;
