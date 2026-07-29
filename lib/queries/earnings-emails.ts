import type Database from "better-sqlite3";
import type { EmailSendState } from "@/lib/earnings/cockpit-stages";
import { issuerSiblings } from "@/lib/securities/issuer-family";

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

export interface SentEarningsEmail {
  event_id: number;
  phase: "preview" | "recap";
  symbol: string;
  event_date: string;
  sent_at: string;
  /** 1 = Worker-delivered ('sent-by-cloud') — viewer has no local prose copy */
  sent_by_cloud: 0 | 1;
}

/**
 * Archive listing of every completed earnings email send, newest-first —
 * backs the alerts "Emails" tab + the Security Detail per-symbol section
 * (spec: docs/superpowers/specs/2026-07-28-earnings-email-archive-design.md).
 * Excludes live 'in_progress' claims (tri-state convention). The optional
 * symbol filter is family-aware via issuerSiblings so a GOOG page finds
 * GOOGL events and vice versa.
 */
export function getSentEarningsEmails(
  db: Database.Database,
  opts: { symbol?: string; limit?: number } = {},
): SentEarningsEmail[] {
  const limit = opts.limit ?? 500;
  const conditions = [`(ee.error IS NULL OR ee.error != 'in_progress')`];
  const params: (string | number)[] = [];

  if (opts.symbol) {
    const family = issuerSiblings(opts.symbol).map((s) => s.toUpperCase());
    conditions.push(
      `UPPER(ce.symbol) IN (${family.map(() => "?").join(",")})`,
    );
    params.push(...family);
  }

  return db
    .prepare(
      `SELECT
         ee.event_id, ee.phase, ce.symbol, ce.event_date, ee.sent_at,
         CASE WHEN ee.error = 'sent-by-cloud' THEN 1 ELSE 0 END AS sent_by_cloud
       FROM earnings_emails ee
       JOIN calendar_events ce ON ce.id = ee.event_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ee.sent_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as SentEarningsEmail[];
}

/**
 * Cockpit send-state per (event, phase) INCLUDING live 'in_progress' claims —
 * unlike getSentPhasesForEvents/getEmailAudit, which deliberately exclude them.
 * Mapping: NULL → 'sent' (local), 'sent-by-cloud' → itself, 'in_progress' →
 * 'in-flight'. Any other historical error string is treated as 'sent'
 * (failure claims are released/deleted by the sweep, so persistent rows sent).
 */
export function getEmailStatesForEvents(
  db: Database.Database,
  eventIds: number[],
): Record<number, { preview: EmailSendState; recap: EmailSendState }> {
  const result: Record<number, { preview: EmailSendState; recap: EmailSendState }> = {};
  if (eventIds.length === 0) return result;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_id, phase, error FROM earnings_emails WHERE event_id IN (${placeholders})`,
    )
    .all(...eventIds) as Array<{ event_id: number; phase: "preview" | "recap"; error: string | null }>;
  for (const row of rows) {
    const state: EmailSendState =
      row.error === "in_progress" ? "in-flight"
      : row.error === "sent-by-cloud" ? "sent-by-cloud"
      : "sent";
    const entry = result[row.event_id] ?? { preview: null, recap: null };
    entry[row.phase] = state;
    result[row.event_id] = entry;
  }
  return result;
}
