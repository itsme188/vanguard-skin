-- Migration 066: track whether an article has been scanned for earnings
-- bogeys (EPS/revenue consensus + whisper numbers for upcoming reporters).
-- Sibling to migration 030's levels_extracted_at marker — even if Claude
-- found zero bogeys in the article, we mark it attempted so we don't
-- re-scan on every research sync. A null value = never attempted.
-- Task A1 (#11): lib/earnings/extract-newsletter-bogeys.ts.

ALTER TABLE research_articles ADD COLUMN bogeys_scanned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_research_articles_bogeys_scanned
  ON research_articles(bogeys_scanned_at);
