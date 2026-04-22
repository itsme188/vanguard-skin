-- Cached SEC filing section extractions (10-K Item 1A Risk Factors, Item 7 MD&A,
-- and the 10-Q equivalents). Populated lazily by the chat tool on first request
-- per (symbol, accession, section); re-used for subsequent calls without
-- re-fetching EDGAR or re-invoking Claude.

CREATE TABLE filing_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  cik TEXT NOT NULL,
  filing_type TEXT NOT NULL CHECK (filing_type IN ('10-K', '10-Q')),
  accession_number TEXT NOT NULL,
  filing_date TEXT NOT NULL, -- YYYY-MM-DD
  section_name TEXT NOT NULL CHECK (section_name IN ('risk_factors', 'mda')),
  summary TEXT NOT NULL, -- Claude-generated structured summary
  key_points TEXT,       -- Optional bullet-point extract (JSON array as text)
  source_url TEXT,       -- Direct link to the filing on SEC EDGAR
  char_count INTEGER,    -- Raw section length (post-strip) for diagnostics
  model_id TEXT,         -- Which model produced the summary
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_filing_sections_unique
  ON filing_sections(symbol, accession_number, section_name);

CREATE INDEX idx_filing_sections_lookup
  ON filing_sections(symbol, filing_type, section_name, filing_date DESC);
