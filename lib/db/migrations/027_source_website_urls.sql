-- Populate website_url for all sources missing it.
-- These are fallback URLs used when per-article source_url extraction fails.

-- New sources (recently added, 0 articles yet)
UPDATE research_sources SET website_url = 'https://www.fabricatedknowledge.com' WHERE id = 24 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://irrationalanalysis.substack.com' WHERE id = 23 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://www.libertyrpf.com' WHERE id = 26 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://tbpn.substack.com' WHERE id = 27 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://blog.tickertrends.io' WHERE id = 25 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://www.apolloacademy.com' WHERE id = 22 AND website_url IS NULL;

-- Existing sources missing website_url
UPDATE research_sources SET website_url = 'https://mojo3324106.substack.com' WHERE id = 14 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://purpledrink.substack.com' WHERE id = 19 AND website_url IS NULL;
UPDATE research_sources SET website_url = 'https://fundaai.substack.com' WHERE id = 21 AND website_url IS NULL;

-- Fix typo: "Torsen Slok" -> "Torsten Slok"
UPDATE research_sources SET name = 'Torsten Slok' WHERE id = 22 AND name = 'Torsen Slok';

-- Deactivate empty placeholder (no sender_email, no articles, never configured)
UPDATE research_sources SET is_active = 0 WHERE id = 4 AND sender_email IS NULL AND name = 'Afternoon Recap';

-- Deactivate duplicate Purple Drink (id 20) — same sender_email as id 19, 0 articles
UPDATE research_sources SET is_active = 0 WHERE id = 20 AND (SELECT COUNT(*) FROM research_articles WHERE source_id = 20) = 0;
