import type Database from "better-sqlite3";

export interface EarningsEmailAudit {
  id: number;
  event_id: number;
  phase: "preview" | "recap";
  recipient: string;
  sent_at: string;
  ai_input_hash: string | null;
  ai_output_md: string | null;
  error: string | null;
}

/**
 * Single audit row for an (event, phase). Excludes live 'in_progress' claim
 * rows (see the cross-process send-claim mutex + tri-state note in
 * lib/digest/send-earnings-email.ts) — a claim isn't a sent email, so any
 * reader (the in-app email viewer, in particular) must see "no row" rather
 * than an in-flight/possibly-crashed compose. 'sent-by-cloud' rows DO return
 * (caller should branch on `error === "sent-by-cloud"` — those rows have
 * `ai_output_md = NULL`, no local prose copy).
 */
export function getEmailAudit(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): EarningsEmailAudit | null {
  return (
    (db
      .prepare(
        `SELECT id, event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error
           FROM earnings_emails
          WHERE event_id = ? AND phase = ?
            AND (error IS NULL OR error != 'in_progress')`,
      )
      .get(eventId, phase) as EarningsEmailAudit | undefined) ?? null
  );
}

export function getEmailAuditsForEvent(
  db: Database.Database,
  eventId: number,
): EarningsEmailAudit[] {
  return db
    .prepare(
      `SELECT id, event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error
         FROM earnings_emails
        WHERE event_id = ?
        ORDER BY phase ASC`,
    )
    .all(eventId) as EarningsEmailAudit[];
}

/**
 * For a list of event_ids, return which phases have been sent.
 * Empty input → empty result. Single round-trip; caller decides
 * which events render which buttons.
 *
 * Excludes live 'in_progress' claim rows (see the cross-process send-claim
 * mutex in lib/digest/send-earnings-email.ts, bug B3) — a send that's still
 * mid-compose hasn't actually delivered anything yet, so the "sent" chip
 * would be a lie. 'sent-by-cloud' rows (Worker-delivered) DO count as sent.
 */
export function getSentPhasesForEvents(
  db: Database.Database,
  eventIds: number[],
): Record<number, { preview: boolean; recap: boolean }> {
  const out: Record<number, { preview: boolean; recap: boolean }> = {};
  if (eventIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT event_id, phase FROM earnings_emails
        WHERE event_id IN (${eventIds.map(() => "?").join(",")})
          AND (error IS NULL OR error != 'in_progress')`,
    )
    .all(...eventIds) as { event_id: number; phase: "preview" | "recap" }[];
  for (const r of rows) {
    const existing = out[r.event_id] ?? { preview: false, recap: false };
    if (r.phase === "preview") existing.preview = true;
    if (r.phase === "recap") existing.recap = true;
    out[r.event_id] = existing;
  }
  return out;
}
