-- Migration 030: track whether an article has been scanned for price levels.
-- Even if Claude found zero levels in the article, we mark it attempted so
-- we don't re-scan on every research sync. A null value = never attempted.

ALTER TABLE research_articles ADD COLUMN levels_extracted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_research_articles_levels_extracted
  ON research_articles(levels_extracted_at);
