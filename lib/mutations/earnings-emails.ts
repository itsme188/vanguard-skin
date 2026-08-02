/**
 * `earnings_emails` audit-row writes shared across send paths.
 *
 * `recordCloudSentAudit` lived module-private in lib/calendar/email-sweep.ts
 * until 2026-08-02, when the morning debrief (lib/earnings/debrief-send.ts)
 * needed the identical row for its own cloud-marker drop path. Importing it
 * back out of email-sweep would have created an import cycle — email-sweep
 * already imports `runMorningDebrief` — so it moved here, the repo's home for
 * DB writes, and both callers share this one definition. Never copy the
 * INSERT: the `'sent-by-cloud'` error value plus the NULL `ai_output_md` are
 * exactly what the in-app viewer keys its "no local copy" state on, and the
 * DO NOTHING is the idempotency that lets the sweep re-reconcile the same KV
 * marker every tick.
 */

import type Database from "better-sqlite3";

/**
 * When the Worker fallback already delivered an email, mirror that fact into
 * the local audit table so (a) findEmailCandidates / findDebriefCandidates
 * stop re-selecting the event every tick and (b) the EarningsHub chips show
 * it as sent. ai_output_md stays NULL — the viewer knows there's no local
 * copy.
 *
 * `sentAt` (ISO, from the KV marker value) preserves the Worker's real send
 * time; SQLite's datetime() normalizes it to the space-separated format every
 * other sent_at uses, and NULLs (malformed marker) fall back to now.
 * Returns 1 when a row was inserted, 0 when one already existed.
 */
export function recordCloudSentAudit(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  sentAt?: string | null,
): number {
  const result = db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, ?, 'cloud-fallback', COALESCE(datetime(?), datetime('now')), NULL, 'sent-by-cloud')
       ON CONFLICT(event_id, phase) DO NOTHING`,
    )
    .run(eventId, phase, sentAt ?? null);
  return result.changes;
}
