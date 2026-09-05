import type Database from "better-sqlite3";
import type { EmailSendState } from "@/lib/earnings/cockpit-stages";
import {
  notLiveClaimSql,
  sendStateFor,
  DELIVERY_UNKNOWN,
  SENT_BY_CLOUD,
} from "@/lib/earnings/email-states";
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
 * Single audit row for an (event, phase). Excludes LIVE CLAIM rows — both of
 * them, `'in_progress'` (claimed, composing) and `'sending'` (the provider
 * call is on the wire); the set lives in lib/earnings/email-states.ts and is
 * spelled here by notLiveClaimSql. A claim isn't a sent email, so any reader
 * (the in-app email viewer, in particular) must see "no row" rather than an
 * in-flight/possibly-crashed compose.
 *
 * The two DELIVERED sentinels DO return. A `'sent-by-cloud'` row has
 * `ai_output_md = NULL` (the Worker delivered it; there is no local prose
 * copy). A `'delivery_unknown'` row DOES carry the prose that was composed —
 * we put a message on the wire and never heard back — and the viewer shows
 * that body with the delivery caveat rather than hiding it. Callers branch on
 * `error` (or, better, on sendStateFor(error)) to say which they are looking
 * at.
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
            AND ${notLiveClaimSql("error")}`,
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
 * Excludes LIVE CLAIM rows — `'in_progress'` (mid-compose) and `'sending'`
 * (the provider call is on the wire); see the cross-process send-claim mutex
 * in lib/digest/send-earnings-email.ts, bug B3. Neither has delivered
 * anything yet, so a "sent" chip would be a lie. Both delivered sentinels
 * DO count as sent: `'sent-by-cloud'` (the Worker delivered it) and
 * `'delivery_unknown'` (we may well have delivered it and never learned —
 * counting it as unsent would invite a duplicate).
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
          AND ${notLiveClaimSql("error")}`,
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
  /** 1 = terminal 'delivery_unknown': the provider's answer was never received.
   *  It IS listed (a body exists), but it is the one row a human must resolve. */
  delivery_unknown: 0 | 1;
}

/**
 * Archive listing of every completed earnings email send, newest-first —
 * backs the alerts "Emails" tab + the Security Detail per-symbol section
 * (spec: docs/superpowers/specs/2026-07-28-earnings-email-archive-design.md).
 * Excludes both LIVE CLAIM values, `'in_progress'` and `'sending'` (the
 * five-value convention in lib/earnings/email-states.ts). A
 * `'delivery_unknown'` row IS listed — an email may well have gone out and a
 * body is stored — but `delivery_unknown = 1` marks it as the one state a
 * human still has to close, by confirming delivery (`markDelivered`) or by
 * refiring. The optional symbol filter is family-aware via issuerSiblings so
 * a GOOG page finds GOOGL events and vice versa.
 */
export function getSentEarningsEmails(
  db: Database.Database,
  opts: { symbol?: string; limit?: number } = {},
): SentEarningsEmail[] {
  const limit = opts.limit ?? 500;
  const conditions = [notLiveClaimSql("ee.error")];
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
         CASE WHEN ee.error = '${SENT_BY_CLOUD}' THEN 1 ELSE 0 END AS sent_by_cloud,
         CASE WHEN ee.error = '${DELIVERY_UNKNOWN}' THEN 1 ELSE 0 END AS delivery_unknown
       FROM earnings_emails ee
       JOIN calendar_events ce ON ce.id = ee.event_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ee.sent_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as SentEarningsEmail[];
}

/**
 * Cockpit send-state per (event, phase) INCLUDING live claims — unlike
 * getSentPhasesForEvents/getEmailAudit, which deliberately exclude them.
 *
 * The mapping is sendStateFor (lib/earnings/email-states.ts), which is the
 * LENIENT delivered reading and is deliberately NOT isDeliveredStrict: both
 * live values ('in_progress', 'sending') → 'in-flight', 'sent-by-cloud' →
 * itself, 'delivery_unknown' → 'delivery-unknown', and ANY other historical
 * error string → 'sent' (failure claims are released/deleted by the sweep, so
 * a persistent non-sentinel row means a send that completed). That legacy
 * reading is preserved on purpose — see the two-delivered-questions note in
 * email-states.ts.
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
    const entry = result[row.event_id] ?? { preview: null, recap: null };
    entry[row.phase] = sendStateFor(row.error);
    result[row.event_id] = entry;
  }
  return result;
}
