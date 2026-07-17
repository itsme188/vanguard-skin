-- Migration 068: earnings source hierarchy (spec 2026-07-17).
-- earnings_rank non-NULL = source is in the earnings composer's trust-ordered
-- hierarchy (1 = highest). NULL = general pool (still eligible to fill
-- remaining slots — see getNewsletterContext rank-ordered fill).
-- earnings_note = per-source "how to read this" guidance injected once per
-- source into the earnings preview/recap prompt.
--
-- The seed UPDATEs transfer ownership from the deleted PREFERRED_SOURCE_IDS
-- constant in lib/digest/send-earnings-email.ts to the DB. They are id-guarded
-- and no-op harmlessly on DBs without those rows (test DBs, fresh installs).

ALTER TABLE research_sources ADD COLUMN earnings_rank INTEGER;
ALTER TABLE research_sources ADD COLUMN earnings_note TEXT;

UPDATE research_sources SET earnings_rank = 1 WHERE id = 1;  -- Vital Knowledge
UPDATE research_sources SET earnings_rank = 2,
       earnings_note = 'Morning Wrap carries sell-side bogies tables — quote exact numbers.'
 WHERE id = 8;                                               -- TMT Breakout
UPDATE research_sources SET earnings_rank = 3 WHERE id = 18; -- Eliant Capital
UPDATE research_sources SET earnings_rank = 4 WHERE id = 19; -- Purple Drink's Market Musings
UPDATE research_sources SET earnings_rank = 5 WHERE id = 28; -- Helene Meisler
