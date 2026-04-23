-- Calendar as a living record — enrichment columns for post-release data.
-- Sprint: 2026-04-24 Tier-3. Plan: docs/plans/2026-04-24-calendar-living-record.md
--
-- Additive only. All new columns nullable; existing rows keep behaving the
-- same until the enrichment runner (scripts/enrich-calendar-events.ts) fills
-- them in on the next 15-minute sweep.

-- Time-of-day for the scheduled release, "HH:MM" in US Eastern. For macro
-- events this comes from RELEASE_TIMES_ET; for earnings it's derived from
-- the Finnhub `hour` field (bmo → 08:00, amc → 16:15).
ALTER TABLE calendar_events ADD COLUMN release_time TEXT;

-- Released value as a string. Events publish in incompatible units
-- (percent, dollars, thousands, index points) — storing as TEXT keeps the
-- UI honest. Parse at read time when math is actually needed.
ALTER TABLE calendar_events ADD COLUMN actual_value TEXT;

-- Pre-release consensus. Some rows already have this in raw_json or
-- consensus_estimate; surfaced here as a first-class column at enrichment
-- time so all downstream readers use one shape.
ALTER TABLE calendar_events ADD COLUMN consensus_value TEXT;

-- Reaction snapshot JSON: SPY/QQQ/TLT + optional sector ETF at T-5min and
-- T+120min. Shape documented in lib/calendar/reaction-snapshot.ts.
ALTER TABLE calendar_events ADD COLUMN reaction_snapshot TEXT;

-- datetime('now') when the enrichment runner completed this row. The
-- runner skips rows where this is non-null.
ALTER TABLE calendar_events ADD COLUMN enriched_at TEXT;

-- Fast lookup for "unenriched events whose release window is open" — the
-- hot query for every 15-minute sweep.
CREATE INDEX IF NOT EXISTS idx_calendar_events_enrichment
  ON calendar_events (enriched_at, event_date);

-- Running log of earnings events whose sector couldn't be mapped to an
-- ETF. PRIMARY KEY on (symbol, sector) gives free dedup on upsert —
-- count increments on every miss so the "most common unmapped" rise to
-- the top when we do the periodic backfill.
CREATE TABLE IF NOT EXISTS sector_etf_gaps (
  symbol TEXT NOT NULL,
  sector TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol, sector)
);
