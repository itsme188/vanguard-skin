-- Earnings transcript cache.
-- Stores EDGAR 8-K press releases, Seeking Alpha transcripts, and API Ninjas transcripts.
-- Layered sources: API Ninjas (paid, optional) → Motley Fool (free) → EDGAR 8-K (free).

CREATE TABLE earnings_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER REFERENCES securities(id),
  ticker TEXT NOT NULL,
  year INTEGER NOT NULL,
  quarter INTEGER NOT NULL CHECK(quarter BETWEEN 1 AND 4),
  call_date TEXT,                    -- YYYY-MM-DD
  source TEXT NOT NULL,              -- 'edgar_8k' | 'motley_fool' | 'api_ninjas'

  -- Content
  transcript TEXT,                   -- Full transcript text (can be very large)
  summary TEXT,                      -- Extracted/generated summary (~200 words)
  guidance TEXT,                     -- Forward-looking statements
  risk_factors TEXT,                 -- Challenges mentioned

  -- Sentiment
  sentiment_score REAL,              -- -1.0 to 1.0
  sentiment_label TEXT,              -- 'bullish' | 'bearish' | 'neutral'

  -- Participants (JSON array of {name, role})
  participants TEXT,

  -- EDGAR-specific
  accession_number TEXT,
  filing_url TEXT,

  -- Dedup + metadata
  source_key TEXT UNIQUE NOT NULL,   -- e.g., 'motley_fool:AAPL:2025:3'
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transcripts_ticker_quarter ON earnings_transcripts(ticker, year, quarter);
CREATE INDEX idx_transcripts_security ON earnings_transcripts(security_id);
CREATE INDEX idx_transcripts_call_date ON earnings_transcripts(call_date);
