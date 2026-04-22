-- Press releases pulled from Finnhub's /company-news endpoint. One row per
-- unique (finnhub_id) story across all sources (Business Wire, PR Newswire,
-- company IR, Reuters, etc.). Keyed on finnhub_id so re-syncing the same
-- window is idempotent.
--
-- Symbol is stored raw (not a FK to securities) because news often mentions
-- tickers the user doesn't hold and we still want it searchable. The chat
-- tool is expected to scope by symbol on the way in.

CREATE TABLE press_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finnhub_id INTEGER NOT NULL UNIQUE,
  symbol TEXT NOT NULL,              -- uppercase ticker the story is about
  headline TEXT NOT NULL,
  summary TEXT,                      -- Finnhub's lead paragraph, often truncated
  source TEXT,                       -- "Business Wire", "Reuters", "SeekingAlpha", etc.
  category TEXT,                     -- Finnhub classification: "company news", "press release", "general", etc.
  url TEXT,                          -- canonical story URL
  image_url TEXT,                    -- hero image if provided
  published_at TEXT NOT NULL,        -- ISO 8601 UTC from Finnhub epoch
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json TEXT                      -- original Finnhub item for future reprocessing
);

CREATE INDEX idx_press_releases_symbol_date
  ON press_releases(symbol, published_at DESC);
CREATE INDEX idx_press_releases_cached_at
  ON press_releases(cached_at);
