import type Database from "better-sqlite3";
import type { CalendarEvent, CalendarBriefing } from "@/lib/types";

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
  return db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE week_of = ?
       ORDER BY event_date ASC, event_time ASC NULLS LAST, title ASC`
    )
    .all(weekOf) as CalendarEvent[];
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
  return db
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
       )
       SELECT id, source, event_type, event_date, event_time, title, description,
              security_id, symbol, ib_con_id, expected_impact, consensus_estimate,
              previous_value, raw_json, source_key, week_of, fetched_at, created_at,
              release_time, actual_value, consensus_value, reaction_snapshot, enriched_at
         FROM ranked
        WHERE rn = 1
        ORDER BY event_date ASC, release_time ASC NULLS LAST, symbol ASC`,
    )
    .all(weekOf) as CalendarEvent[];
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
