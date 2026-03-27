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
