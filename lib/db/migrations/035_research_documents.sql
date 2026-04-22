-- Research PDF knowledge base (Theme F1).
-- Users upload analyst reports, bank research, market analyses, etc. Each doc
-- is Claude-extracted to structured metadata + raw text. FTS5 virtual table
-- provides lexical search over title/author/source/summary/raw_text.

CREATE TABLE research_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  source TEXT,                 -- firm or publication (e.g., "Goldman Sachs", "Bernstein")
  filename TEXT NOT NULL,
  file_size_bytes INTEGER,
  publication_date TEXT,       -- YYYY-MM-DD if extractable, else null
  document_type TEXT CHECK (document_type IN (
    'analyst_report', 'research_note', 'market_analysis', 'industry_primer', 'other'
  )),
  raw_text TEXT NOT NULL,
  summary TEXT,
  key_points TEXT,             -- JSON array of strings
  mentioned_symbols TEXT,      -- JSON array of tickers (upper-case)
  sentiment TEXT CHECK (sentiment IN ('bullish', 'bearish', 'neutral', 'mixed') OR sentiment IS NULL),
  target_prices TEXT,          -- JSON [{symbol, price, horizon}]
  ai_model TEXT,
  char_count INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_research_documents_pub_date
  ON research_documents(publication_date DESC, uploaded_at DESC);
CREATE INDEX idx_research_documents_type
  ON research_documents(document_type);
CREATE INDEX idx_research_documents_uploaded
  ON research_documents(uploaded_at DESC);

-- FTS5 external-content table — stores only the inverted index; source content
-- comes from research_documents via content='research_documents' + content_rowid='id'.
CREATE VIRTUAL TABLE research_documents_fts USING fts5(
  title, author, source, summary, mentioned_symbols, raw_text,
  content='research_documents',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers keep the FTS index in sync with the main table.
CREATE TRIGGER research_documents_ai AFTER INSERT ON research_documents BEGIN
  INSERT INTO research_documents_fts(rowid, title, author, source, summary, mentioned_symbols, raw_text)
  VALUES (new.id,
          COALESCE(new.title, ''),
          COALESCE(new.author, ''),
          COALESCE(new.source, ''),
          COALESCE(new.summary, ''),
          COALESCE(new.mentioned_symbols, ''),
          COALESCE(new.raw_text, ''));
END;

CREATE TRIGGER research_documents_ad AFTER DELETE ON research_documents BEGIN
  INSERT INTO research_documents_fts(research_documents_fts, rowid, title, author, source, summary, mentioned_symbols, raw_text)
  VALUES ('delete', old.id,
          COALESCE(old.title, ''),
          COALESCE(old.author, ''),
          COALESCE(old.source, ''),
          COALESCE(old.summary, ''),
          COALESCE(old.mentioned_symbols, ''),
          COALESCE(old.raw_text, ''));
END;

CREATE TRIGGER research_documents_au AFTER UPDATE ON research_documents BEGIN
  INSERT INTO research_documents_fts(research_documents_fts, rowid, title, author, source, summary, mentioned_symbols, raw_text)
  VALUES ('delete', old.id,
          COALESCE(old.title, ''),
          COALESCE(old.author, ''),
          COALESCE(old.source, ''),
          COALESCE(old.summary, ''),
          COALESCE(old.mentioned_symbols, ''),
          COALESCE(old.raw_text, ''));
  INSERT INTO research_documents_fts(rowid, title, author, source, summary, mentioned_symbols, raw_text)
  VALUES (new.id,
          COALESCE(new.title, ''),
          COALESCE(new.author, ''),
          COALESCE(new.source, ''),
          COALESCE(new.summary, ''),
          COALESCE(new.mentioned_symbols, ''),
          COALESCE(new.raw_text, ''));
END;
