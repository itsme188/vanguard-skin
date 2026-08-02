import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export const GUIDANCE_VALUES = ["raised", "inline", "lowered", "not_given"] as const;
export type CallNoteGuidance = (typeof GUIDANCE_VALUES)[number];

export interface EarningsCallNote {
  id: number;
  event_id: number;
  security_id: number | null;
  symbol: string;
  guidance: CallNoteGuidance | null;
  tone: string | null;
  surprises: string | null;
  follow_ups: string | null;
  created_at: string;
  updated_at: string;
}

export function getCallNoteForEvent(
  db: Database.Database,
  eventId: number
): EarningsCallNote | null {
  const row = db
    .prepare("SELECT * FROM earnings_call_notes WHERE event_id = ?")
    .get(eventId) as EarningsCallNote | undefined;
  return row ?? null;
}

/** Which of these events already have a call note (cockpit `hasCallNote`). */
export function getCallNotePresenceForEvents(
  db: Database.Database,
  eventIds: number[]
): Set<number> {
  if (eventIds.length === 0) return new Set();
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT event_id FROM earnings_call_notes WHERE event_id IN (${placeholders})`)
    .all(...eventIds) as Array<{ event_id: number }>;
  return new Set(rows.map((r) => r.event_id));
}

/**
 * Most recent call note for the issuer family, by the note's EVENT date
 * (join to calendar_events), optionally strictly before `beforeDate` —
 * the preview composer passes the upcoming event's date to get the PRIOR
 * quarter's note, never the current one.
 */
export function getLatestCallNoteForFamily(
  db: Database.Database,
  symbol: string,
  beforeDate?: string
): EarningsCallNote | null {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  if (family.length === 0) return null;
  const placeholders = family.map(() => "?").join(",");
  const params: (string | number)[] = [...family];
  let dateClause = "";
  if (beforeDate) {
    dateClause = "AND ce.event_date < ?";
    params.push(beforeDate);
  }
  const row = db
    .prepare(
      `SELECT n.* FROM earnings_call_notes n
       JOIN calendar_events ce ON ce.id = n.event_id
       WHERE UPPER(n.symbol) IN (${placeholders}) ${dateClause}
       ORDER BY ce.event_date DESC, n.updated_at DESC
       LIMIT 1`
    )
    .get(...params) as EarningsCallNote | undefined;
  return row ?? null;
}

/**
 * Call note for the issuer family whose associated calendar event's
 * `event_date` falls within `windowDays` of `eventDate` (either direction —
 * a dual-class sibling can report a day or two off from the candidate's own
 * print). Unlike `getLatestCallNoteForFamily` (which — absent a
 * `beforeDate` — happily returns the family's single most recent note no
 * matter how old), this must never misattribute a stale note from a prior
 * quarter to the print currently being written about: no match inside the
 * window returns null, it never falls back to "closest anyway".
 *
 * Ties (more than one family note inside the window — rare) break on
 * closest event_date first, then most recently updated.
 */
export function getCallNoteNearDateForFamily(
  db: Database.Database,
  symbol: string,
  eventDate: string,
  windowDays = 5
): EarningsCallNote | null {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  if (family.length === 0) return null;
  const placeholders = family.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT n.* FROM earnings_call_notes n
       JOIN calendar_events ce ON ce.id = n.event_id
       WHERE UPPER(n.symbol) IN (${placeholders})
         AND ABS(julianday(ce.event_date) - julianday(?)) <= ?
       ORDER BY ABS(julianday(ce.event_date) - julianday(?)) ASC, n.updated_at DESC
       LIMIT 1`
    )
    .get(...family, eventDate, windowDays, eventDate) as EarningsCallNote | undefined;
  return row ?? null;
}
