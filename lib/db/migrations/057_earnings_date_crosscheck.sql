-- Earnings date cross-check (Finnhub x Nasdaq) with human-in-the-loop confirmation.
--
-- The calendar now ingests TWO independent free earnings calendars (Finnhub +
-- Nasdaq). A reconciliation pass (lib/calendar/reconcile-earnings-dates.ts)
-- clusters each held/watchlist name's rows and resolves a canonical date:
--
--   date_status:
--     'confirmed'      - both sources agree (or a past-with-actuals row wins)
--     'conflict'       - both future, dates differ -> awaits user confirmation
--     'single'         - only one source has it
--     'user_confirmed' - the user picked/entered the date (IBKR-authoritative); locked
--
--   date_conflict_with - on a 'conflict' row, the losing source's date, e.g.
--                        "finnhub:2026-06-08", so the confirm popover can show both.
--
--   superseded         - non-canonical rows in a cluster are marked 1 and excluded
--                        from every reader (Hub, today/upcoming releases, week-ahead,
--                        earnings-email candidate finder). Non-destructive: the row
--                        survives for audit and re-reconciliation.
--
-- All three are nullable / default-0 so existing rows survive untouched until the
-- next syncCalendarForWeek run reconciles them.

ALTER TABLE calendar_events ADD COLUMN date_status TEXT;
ALTER TABLE calendar_events ADD COLUMN date_conflict_with TEXT;
ALTER TABLE calendar_events ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_calendar_events_superseded ON calendar_events(superseded);
