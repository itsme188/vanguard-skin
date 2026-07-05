-- Earnings enrichment retry semantics (2026-07-04 pre-season fixes, B2).
--
-- enrichment_attempted_at: stamped on EVERY enrichment attempt. For earnings
-- rows, enriched_at is now stamped only when enrichment is COMPLETE (actual
-- captured AND (reaction captured OR release >= 150 min ago)), so the runner
-- retries across ticks instead of burning its one shot 5-20 min post-release
-- before Finnhub has posted actuals / before reaction bars exist.
--
-- actual_missing_alerted_at: dedup stamp for the blocked-recap Pushover alert
-- (a previewed event sitting >2h post-release with no actual).
ALTER TABLE calendar_events ADD COLUMN enrichment_attempted_at TEXT;
ALTER TABLE calendar_events ADD COLUMN actual_missing_alerted_at TEXT;
