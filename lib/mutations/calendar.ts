import type Database from "better-sqlite3";
import type {
  CalendarEvent,
  CalendarBriefing,
  CalendarEventSource,
} from "@/lib/types";
import { resolveReleaseTime } from "@/lib/calendar/release-times";

// ─── Result types ─────────────────────────────────────────────────

export interface UpsertResult {
  total: number;
  inserted: number;
  updated: number;
}

// ─── Event input type ─────────────────────────────────────────────

export interface CalendarEventInput {
  source: CalendarEventSource;
  event_type: string;
  event_date: string;
  event_time?: string | null;
  title: string;
  description?: string | null;
  security_id?: number | null;
  symbol?: string | null;
  ib_con_id?: number | null;
  expected_impact?: string | null;
  consensus_estimate?: string | null;
  previous_value?: string | null;
  raw_json?: string | null;
  source_key: string;
  week_of?: string | null;
}

// ─── Mutation functions ───────────────────────────────────────────

/**
 * Batch upsert calendar events. Uses ON CONFLICT(source_key) to update
 * existing events rather than creating duplicates.
 * Returns counts distinguishing new inserts from updates of existing rows.
 */
export function upsertCalendarEvents(
  db: Database.Database,
  events: CalendarEventInput[]
): UpsertResult {
  if (events.length === 0) return { total: 0, inserted: 0, updated: 0 };

  // Check which source_keys already exist so we can distinguish insert vs update
  const sourceKeys = events.map((e) => e.source_key);
  const placeholders = sourceKeys.map(() => "?").join(",");
  const existingRows = db
    .prepare(
      `SELECT source_key FROM calendar_events WHERE source_key IN (${placeholders})`
    )
    .all(...sourceKeys) as { source_key: string }[];
  const existingKeys = new Set(existingRows.map((r) => r.source_key));

  const stmt = db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, release_time, title, description,
        security_id, symbol, ib_con_id, expected_impact, consensus_estimate,
        previous_value, raw_json, source_key, week_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       event_type = excluded.event_type,
       event_date = excluded.event_date,
       event_time = excluded.event_time,
       release_time = excluded.release_time,
       title = excluded.title,
       description = excluded.description,
       expected_impact = excluded.expected_impact,
       consensus_estimate = excluded.consensus_estimate,
       previous_value = excluded.previous_value,
       raw_json = excluded.raw_json,
       fetched_at = datetime('now')`
  );

  const insertAll = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    for (const e of events) {
      const releaseTime = resolveReleaseTime({
        event_type: e.event_type,
        event_time: e.event_time ?? null,
        raw_json: e.raw_json ?? null,
      });
      stmt.run(
        e.source,
        e.event_type,
        e.event_date,
        e.event_time ?? null,
        releaseTime,
        e.title,
        e.description ?? null,
        e.security_id ?? null,
        e.symbol ?? null,
        e.ib_con_id ?? null,
        e.expected_impact ?? null,
        e.consensus_estimate ?? null,
        e.previous_value ?? null,
        e.raw_json ?? null,
        e.source_key,
        e.week_of ?? null
      );
      if (existingKeys.has(e.source_key)) {
        updated++;
      } else {
        inserted++;
      }
    }
    return { total: inserted + updated, inserted, updated };
  });

  return insertAll();
}

/**
 * Save or update a weekly briefing.
 */
export function saveBriefing(
  db: Database.Database,
  params: {
    weekOf: string;
    title: string;
    content: string;
    eventCount: number;
    model: string;
  }
): CalendarBriefing {
  db.prepare(
    `INSERT INTO calendar_briefings (week_of, title, content, event_count, model)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_of) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       event_count = excluded.event_count,
       model = excluded.model,
       generated_at = datetime('now')`
  ).run(
    params.weekOf,
    params.title,
    params.content,
    params.eventCount,
    params.model
  );

  return db
    .prepare("SELECT * FROM calendar_briefings WHERE week_of = ?")
    .get(params.weekOf) as CalendarBriefing;
}

/**
 * Delete events for a given week, optionally filtered by source.
 */
export function deleteEventsForWeek(
  db: Database.Database,
  weekOf: string,
  source?: CalendarEventSource
): number {
  if (source) {
    return db
      .prepare(
        "DELETE FROM calendar_events WHERE week_of = ? AND source = ?"
      )
      .run(weekOf, source).changes;
  }
  return db
    .prepare("DELETE FROM calendar_events WHERE week_of = ?")
    .run(weekOf).changes;
}
