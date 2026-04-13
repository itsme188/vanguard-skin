-- Per-article source URL (extracted from "View in browser" links in newsletter raw_html)
ALTER TABLE research_articles ADD COLUMN source_url TEXT;

-- Per-source website URL (fallback when no per-article URL is available)
ALTER TABLE research_sources ADD COLUMN website_url TEXT;

-- Populate known newsletter website URLs
UPDATE research_sources SET website_url = 'https://vitalknowledge.net' WHERE name = 'Vital Knowledge';
UPDATE research_sources SET website_url = 'https://stratechery.com' WHERE name LIKE 'Stratechery%';
UPDATE research_sources SET website_url = 'https://thediff.co' WHERE name = 'The Diff';
UPDATE research_sources SET website_url = 'https://doomberg.substack.com' WHERE name = 'Doomberg';
UPDATE research_sources SET website_url = 'https://www.tmtbreakout.com' WHERE name = 'TMT Breakout';
UPDATE research_sources SET website_url = 'https://www.bloomberg.com/oddlots' WHERE name = 'Bloomberg Odd Lots';
UPDATE research_sources SET website_url = 'https://www.topdowncharts.com' WHERE name = 'Topdown Charts';
UPDATE research_sources SET website_url = 'https://www.mbi-deepdives.com' WHERE name = 'MBI Deep Dives';
UPDATE research_sources SET website_url = 'https://www.calliecox.com' WHERE name = 'Callie Cox';
UPDATE research_sources SET website_url = 'https://www.highyieldharry.com' WHERE name = 'High Yield Harry';
UPDATE research_sources SET website_url = 'https://www.jamesbulltard.com' WHERE name = 'James Bulltard';
UPDATE research_sources SET website_url = 'https://www.eliantcapital.com' WHERE name = 'Eliant Capital';
