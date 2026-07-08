import type Database from "better-sqlite3";
import {
  GUIDANCE_VALUES,
  type CallNoteGuidance,
  type EarningsCallNote,
  getCallNoteForEvent,
} from "@/lib/queries/earnings-call-notes";

export interface UpsertCallNoteInput {
  eventId: number;
  securityId?: number | null;
  symbol: string;
  guidance?: CallNoteGuidance | null;
  tone?: string | null;
  surprises?: string | null;
  followUps?: string | null;
}

/**
 * One note per event (UNIQUE event_id). Full-replace semantics: the modal
 * always posts every field, so an omitted/null field clears the column —
 * "save what the form shows", no partial-merge surprises.
 */
export function upsertCallNote(
  db: Database.Database,
  input: UpsertCallNoteInput
): EarningsCallNote {
  if (input.guidance != null && !GUIDANCE_VALUES.includes(input.guidance)) {
    throw new Error(
      `Invalid guidance "${input.guidance}" — expected one of ${GUIDANCE_VALUES.join(", ")}`
    );
  }
  db.prepare(
    `INSERT INTO earnings_call_notes
       (event_id, security_id, symbol, guidance, tone, surprises, follow_ups)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       security_id = excluded.security_id,
       symbol = excluded.symbol,
       guidance = excluded.guidance,
       tone = excluded.tone,
       surprises = excluded.surprises,
       follow_ups = excluded.follow_ups,
       updated_at = datetime('now')`
  ).run(
    input.eventId,
    input.securityId ?? null,
    input.symbol,
    input.guidance ?? null,
    input.tone ?? null,
    input.surprises ?? null,
    input.followUps ?? null
  );
  const note = getCallNoteForEvent(db, input.eventId);
  if (!note) throw new Error("Call note upsert failed to persist");
  return note;
}
