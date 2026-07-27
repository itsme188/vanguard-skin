-- Migration 070: user suppression list for sync-owned calendar events.
--
-- A wrong earnings date from a sync source (NET: Finnhub carried 2026-07-30,
-- the real date was Aug 6) was uncorrectable: sync-owned rows are 403-guarded
-- in the events API, and even a raw delete would be re-inserted by the next
-- sweep (deterministic source_key). Deleting a sync-owned earnings row via
-- DELETE /api/calendar/events now records its (symbol, event_date,
-- event_type) tuple here, and upsertCalendarEvents — the single choke point
-- every sync source (finnhub, nasdaq, wsh, claude_macro) flows through —
-- skips matching non-manual events.
--
-- Keyed on the semantic tuple, NOT source_key: Finnhub AND Nasdaq both scan
-- earnings, so a source_key suppression would leave the other source free to
-- re-insert the same wrong date under its own key.
--
-- Manual rows are deliberately NOT gated (insertCalendarEvent never consults
-- this table) — an explicit user action wins over a past suppression.
CREATE TABLE calendar_event_suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,                        -- stored uppercase
  event_date TEXT NOT NULL,                    -- YYYY-MM-DD
  event_type TEXT NOT NULL DEFAULT 'earnings',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, event_date, event_type)
);
