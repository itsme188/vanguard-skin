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
