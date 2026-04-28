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

// ─── Single-row CRUD for the Earnings Hub manual-add flow ─────────
//
// updateCalendarEvent / deleteCalendarEvent intentionally only operate on
// rows where source='manual'. Manual rows are exclusively user-curated;
// Finnhub/WSH/FRED rows are owned by their sync pipelines and a stray
// PATCH/DELETE would corrupt the next sync's idempotency. Routes wrap
// these and return 403 on attempts to touch non-manual rows.

export interface ManualEarningsInput {
  symbol: string;
  event_date: string;             // YYYY-MM-DD
  event_type?: string;            // default 'earnings'
  event_time?: string | null;     // 'BMO' | 'AMC' | 'TAS' | 'HH:MM'
  release_time?: string | null;   // explicit override; otherwise derived
  expected_impact?: string | null;
  consensus_estimate?: string | null;
  description?: string | null;
  security_id?: number | null;
  week_of: string;                // Monday of the event's week, computed by caller
}

export interface ManualEarningsResult {
  id: number;
}

/**
 * Insert a manually-curated calendar event (typically earnings the user
 * knows is happening but Finnhub didn't have at sync time). Returns the
 * new row's id. Throws on UNIQUE(source_key) collision — caller should
 * retry the upsert path or treat as a no-op if the manual row already
 * exists for that symbol+date+type.
 *
 * Default event_time/release_time mapping (only applied when caller doesn't
 * pass an explicit value):
 *   - event_time omitted     → "AMC" (most common case for missed names)
 *   - release_time omitted   → 08:00 if BMO, 16:15 if AMC, null otherwise
 */
export function insertCalendarEvent(
  db: Database.Database,
  input: ManualEarningsInput,
): ManualEarningsResult {
  const symbol = input.symbol.trim().toUpperCase();
  const eventType = input.event_type ?? "earnings";
  const eventTime = input.event_time ?? "AMC";
  const releaseTime = input.release_time ?? deriveReleaseTime(eventTime);
  const sourceKey = `manual:${symbol}:${input.event_date}:${eventType}`;
  const title = `${symbol} earnings (Manual entry)`;

  const result = db
    .prepare(
      `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, description,
        security_id, symbol, expected_impact, consensus_estimate,
        source_key, week_of, release_time)
       VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventType,
      input.event_date,
      eventTime,
      title,
      input.description ?? null,
      input.security_id ?? null,
      symbol,
      input.expected_impact ?? "high",
      input.consensus_estimate ?? null,
      sourceKey,
      input.week_of,
      releaseTime,
    );
  return { id: result.lastInsertRowid as number };
}

export interface UpdateManualEarningsInput {
  id: number;
  event_date?: string;
  event_time?: string | null;
  release_time?: string | null;
  description?: string | null;
  consensus_estimate?: string | null;
  expected_impact?: string | null;
  symbol?: string;
  event_type?: string;
  week_of?: string;
}

/** Returns true if the row was updated, false if not found OR not manual. */
export function updateCalendarEvent(
  db: Database.Database,
  input: UpdateManualEarningsInput,
): boolean {
  const existing = db
    .prepare("SELECT source FROM calendar_events WHERE id = ?")
    .get(input.id) as { source: string } | undefined;
  if (!existing) return false;
  if (existing.source !== "manual") return false; // sync-owned — refuse silently; route returns 403

  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.event_date !== undefined) { fields.push("event_date = ?"); params.push(input.event_date); }
  if (input.event_time !== undefined) { fields.push("event_time = ?"); params.push(input.event_time); }
  if (input.release_time !== undefined) { fields.push("release_time = ?"); params.push(input.release_time); }
  if (input.description !== undefined) { fields.push("description = ?"); params.push(input.description); }
  if (input.consensus_estimate !== undefined) { fields.push("consensus_estimate = ?"); params.push(input.consensus_estimate); }
  if (input.expected_impact !== undefined) { fields.push("expected_impact = ?"); params.push(input.expected_impact); }
  if (input.symbol !== undefined) {
    fields.push("symbol = ?");
    params.push(input.symbol.trim().toUpperCase());
  }
  if (input.event_type !== undefined) { fields.push("event_type = ?"); params.push(input.event_type); }
  if (input.week_of !== undefined) { fields.push("week_of = ?"); params.push(input.week_of); }
  // Re-derive the source_key only when symbol/date/type changed, so a date
  // edit doesn't break the UNIQUE constraint with the original key.
  if (
    input.symbol !== undefined ||
    input.event_date !== undefined ||
    input.event_type !== undefined
  ) {
    const row = db.prepare("SELECT symbol, event_date, event_type FROM calendar_events WHERE id = ?").get(input.id) as { symbol: string; event_date: string; event_type: string };
    const newSym = (input.symbol ?? row.symbol).toUpperCase();
    const newDate = input.event_date ?? row.event_date;
    const newType = input.event_type ?? row.event_type;
    fields.push("source_key = ?");
    params.push(`manual:${newSym}:${newDate}:${newType}`);
  }

  if (fields.length === 0) return true; // no-op update

  params.push(input.id);
  const result = db
    .prepare(
      `UPDATE calendar_events SET ${fields.join(", ")}
        WHERE id = ? AND source = 'manual'`,
    )
    .run(...params);
  return result.changes > 0;
}

/** Returns true if a manual row was deleted, false otherwise. */
export function deleteCalendarEvent(
  db: Database.Database,
  id: number,
): boolean {
  const existing = db
    .prepare("SELECT source FROM calendar_events WHERE id = ?")
    .get(id) as { source: string } | undefined;
  if (!existing) return false;
  if (existing.source !== "manual") return false;
  return db
    .prepare("DELETE FROM calendar_events WHERE id = ? AND source = 'manual'")
    .run(id).changes > 0;
}

function deriveReleaseTime(eventTime: string | null | undefined): string | null {
  if (!eventTime) return null;
  const t = eventTime.trim().toUpperCase();
  if (t === "BMO") return "08:00";
  if (t === "AMC") return "16:15";
  if (t === "TAS") return null; // "during trading" — no specific release time
  // If the caller passed "HH:MM" through event_time, treat that as the release_time too.
  if (/^\d{1,2}:\d{2}$/.test(eventTime)) return eventTime;
  return null;
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
