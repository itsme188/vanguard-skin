-- Cap enrichment retries: the empty-enrichment guard (2026-08-19) leaves
-- failed articles with processed_at NULL so they retry — but with no cap, a
-- persistently-failing article retries every pass forever and can wedge the
-- LIMIT 20 queue head. Track attempts; the processor excludes an article as
-- 'enrichment_failed' after 3 tries (MAX_ENRICH_ATTEMPTS in lib/gmail/process.ts).
ALTER TABLE research_articles ADD COLUMN enrich_attempts INTEGER NOT NULL DEFAULT 0;
