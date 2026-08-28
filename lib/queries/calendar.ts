import type Database from "better-sqlite3";
import type { CalendarEvent, CalendarBriefing } from "@/lib/types";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import { addDays } from "@/lib/calendar/date-utils";

// ─── Filter types ─────────────────────────────────────────────────

export interface CalendarFilters {
  startDate?: string;
  endDate?: string;
  source?: string;
  eventType?: string;
  securityId?: number;
  limit?: number;
}

// ─── Query functions ──────────────────────────────────────────────

export function getUpcomingEvents(
  db: Database.Database,
  filters: CalendarFilters = {}
): CalendarEvent[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.startDate) {
    conditions.push("event_date >= ?");
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    conditions.push("event_date <= ?");
    params.push(filters.endDate);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters.eventType) {
    conditions.push("event_type = ?");
    params.push(filters.eventType);
  }
  if (filters.securityId) {
    conditions.push("security_id = ?");
    params.push(filters.securityId);
  }

  // Superseded rows never surface: one print can carry several source rows
  // (finnhub + nasdaq + manual) and reconcileEarningsDates marks the losers
  // superseded=1. Every consumer here is a display surface (Security Detail
  // Upcoming Events, UpcomingEventsCard, MorningBriefing, GET
  // /api/calendar/events) — same rule as getEventsByWeek. Deep-QA
  // 2026-07-16: HOOD/AAPL earnings rendered twice without this.
  conditions.push("COALESCE(superseded, 0) = 0");

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;

  return db
    .prepare(
      `SELECT * FROM calendar_events ${where}
       ORDER BY event_date ASC, event_time ASC NULLS LAST, title ASC
       LIMIT ?`
    )
    .all(...params, limit) as CalendarEvent[];
}

export function getEventsByWeek(
  db: Database.Database,
  weekOf: string
): CalendarEvent[] {
  const events = db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE week_of = ?
         AND COALESCE(superseded, 0) = 0
       ORDER BY event_date ASC, event_time ASC NULLS LAST, title ASC`
    )
    .all(weekOf) as CalendarEvent[];

  // Dual-class fallback, same post-process as getEarningsForWeekDeduped: a
  // sync row can carry security_id NULL even when the security (or a sibling
  // share class) exists, which left week-ahead cards linkless/inert. Pure
  // post-process — doesn't mutate the calendar_events row.
  for (const e of events) {
    if (e.security_id == null && e.symbol) {
      e.security_id = getSecurityIdForSymbolWithSiblings(db, e.symbol);
    }
  }
  return events;
}

export function getEventsForSecurity(
  db: Database.Database,
  securityId: number
): CalendarEvent[] {
  return db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE security_id = ?
       ORDER BY event_date ASC`
    )
    .all(securityId) as CalendarEvent[];
}

/**
 * Earnings events for the week — deduplicated when the same logical event
 * exists in multiple sources. Concrete case: a user manually adds TER for
 * 2026-04-28 because Finnhub didn't have the date at sync time, then later
 * Finnhub catches up and inserts its own row for the same event. Both rows
 * have unique source_keys (`manual:TER:...` vs `finnhub:TER:...`) so the DB
 * happily stores them, but downstream readers (the EarningsHub UI, the
 * Phase-3 email sweep) should treat them as one event. ROW_NUMBER() picks
 * the Finnhub row when both exist (Finnhub typically has consensus_estimate
 * populated, manual rows usually don't), falling back to the most-recent
 * created_at as the tiebreaker.
 *
 * Used by:
 *   - EarningsHub block on /dashboard/today (Phase 2)
 *   - email-sweep candidate finder in enrichment-runner (Phase 3)
 */
export function getEarningsForWeekDeduped(
  db: Database.Database,
  weekOf: string,
): CalendarEvent[] {
  const events = db
    .prepare(
      `WITH ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY UPPER(symbol), event_date, event_type
                  ORDER BY CASE WHEN source = 'finnhub' THEN 0 ELSE 1 END ASC,
                           datetime(created_at) DESC
                ) AS rn
           FROM calendar_events
          WHERE week_of = ?
            AND event_type = 'earnings'
            AND COALESCE(superseded, 0) = 0
       )
       SELECT id, source, event_type, event_date, event_time, title, description,
              security_id, symbol, ib_con_id, expected_impact, consensus_estimate,
              previous_value, raw_json, source_key, week_of, fetched_at, created_at,
              release_time, actual_value, consensus_value, reaction_snapshot, enriched_at,
              date_status, date_conflict_with, manual_actuals_at
         FROM ranked
        WHERE rn = 1
        ORDER BY event_date ASC, release_time ASC NULLS LAST, symbol ASC`,
    )
    .all(weekOf) as CalendarEvent[];

  // Dual-class fallback: if the row's security_id is null but a sibling
  // class is in our securities table (e.g., GOOGL event but we hold GOOG),
  // fill in the sibling's id so SymbolLink can render. Pure post-process —
  // doesn't mutate the calendar_events row.
  for (const e of events) {
    if (e.security_id == null && e.symbol) {
      e.security_id = getSecurityIdForSymbolWithSiblings(db, e.symbol);
    }
  }
  return events;
}

/**
 * Count earnings rows whose Finnhub × Nasdaq dates disagree and await the
 * user's IBKR-definitive confirmation, in the [today, today+14] window. Powers
 * the NotificationBell nudge. Excludes superseded + already-resolved rows.
 */
export function countEarningsDateConflicts(
  db: Database.Database,
  today: string,
): number {
  const end = addDays(today, 14);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM calendar_events
       WHERE event_type = 'earnings'
         AND date_status = 'conflict'
         AND COALESCE(superseded, 0) = 0
         AND event_date BETWEEN ? AND ?`,
    )
    .get(today, end) as { c: number };
  return row.c;
}

export interface EarningsDateConflict {
  id: number;
  symbol: string | null;
  security_id: number | null;
  event_date: string;
  release_time: string | null;
  date_status: "conflict";
  date_conflict_with: string | null;
}

/**
 * The rows behind countEarningsDateConflicts — same predicate, same window —
 * so the NotificationBell badge and the Alerts-inbox Conflicts view can never
 * disagree. Powers the mobile-reachable conflict surface (pre-fix the badge
 * counted conflicts that had NO surface anywhere on touch). security_id is
 * sibling-filled the same way getEarningsForWeekDeduped does, so SymbolLink
 * renders for dual-class tickers.
 */
export function getEarningsDateConflicts(
  db: Database.Database,
  today: string,
): EarningsDateConflict[] {
  const end = addDays(today, 14);
  const rows = db
    .prepare(
      `SELECT id, symbol, security_id, event_date, release_time,
              date_status, date_conflict_with
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND date_status = 'conflict'
          AND COALESCE(superseded, 0) = 0
          AND event_date BETWEEN ? AND ?
        ORDER BY event_date ASC, symbol ASC`,
    )
    .all(today, end) as EarningsDateConflict[];

  for (const r of rows) {
    if (r.security_id == null && r.symbol) {
      r.security_id = getSecurityIdForSymbolWithSiblings(db, r.symbol);
    }
  }
  return rows;
}

export function getEventCountBySource(
  db: Database.Database,
  weekOf: string
): { source: string; count: number }[] {
  return db
    .prepare(
      `SELECT source, COUNT(*) as count
       FROM calendar_events
       WHERE week_of = ?
       GROUP BY source`
    )
    .all(weekOf) as { source: string; count: number }[];
}

// ─── Briefing queries ─────────────────────────────────────────────

export function getLatestBriefing(
  db: Database.Database
): CalendarBriefing | null {
  return (
    (db
      .prepare(
        `SELECT * FROM calendar_briefings
         ORDER BY week_of DESC LIMIT 1`
      )
      .get() as CalendarBriefing) ?? null
  );
}

export function getBriefingByWeek(
  db: Database.Database,
  weekOf: string
): CalendarBriefing | null {
  return (
    (db
      .prepare("SELECT * FROM calendar_briefings WHERE week_of = ?")
      .get(weekOf) as CalendarBriefing) ?? null
  );
}

export function isBriefingStale(
  db: Database.Database,
  weekOf: string
): boolean {
  const row = db
    .prepare(
      `SELECT
         cb.generated_at AS briefing_at,
         MAX(ce.created_at) AS latest_event_at
       FROM calendar_briefings cb
       LEFT JOIN calendar_events ce ON ce.week_of = cb.week_of
       WHERE cb.week_of = ?
       GROUP BY cb.week_of`
    )
    .get(weekOf) as { briefing_at: string; latest_event_at: string | null } | undefined;

  if (!row || !row.latest_event_at) return false;
  return row.latest_event_at > row.briefing_at;
}
