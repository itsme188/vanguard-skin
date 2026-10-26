/**
 * `earnings_emails` audit-row writes shared across send paths.
 *
 * `recordCloudSentAudit` lived module-private in lib/calendar/email-sweep.ts
 * until 2026-08-02, when the morning debrief (lib/earnings/debrief-send.ts)
 * needed the identical row for its own cloud-marker drop path. Importing it
 * back out of email-sweep would have created an import cycle — email-sweep
 * already imports `runMorningDebrief` — so it moved here, the repo's home for
 * DB writes, and both callers share this one definition. Never copy the
 * INSERT: the SENT_BY_CLOUD error value plus the NULL `ai_output_md` are
 * exactly what the in-app viewer keys its "no local copy" state on, and the
 * DO NOTHING is the idempotency that lets the sweep re-reconcile the same KV
 * marker every tick.
 *
 * Both state values below come from lib/earnings/email-states.ts — the single
 * source of truth for what `earnings_emails.error` can hold.
 */

import type Database from "better-sqlite3";
import { DELIVERY_UNKNOWN, SENT_BY_CLOUD } from "@/lib/earnings/email-states";
import { previewStampCovers } from "@/lib/earnings/release-stale-preview";

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
  // A cloud-sent PREVIEW marker lives 30 hours. If the hand-entered row it
  // was sent for has since moved to a later date the preview cannot cover,
  // the Mac released that preview (lib/earnings/release-stale-preview.ts);
  // writing it back here would block the new date's preview for good. Same
  // test as the repoint invariant, on the marker's own send time. A marker
  // with no readable time keeps the old behaviour (stamped now, which covers).
  if (phase === "preview" && sentAt) {
    const event = db
      .prepare(`SELECT event_date FROM calendar_events WHERE id = ?`)
      .get(eventId) as { event_date: string } | undefined;
    if (event && !previewStampCovers(db, sentAt, event.event_date)) {
      console.info(
        `[release-stale-preview] event ${eventId} phase preview: cloud-sent marker not recorded ` +
          `(sent before the day before the event's date ${event.event_date})`,
      );
      return 0;
    }
  }
  const result = db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, ?, 'cloud-fallback', COALESCE(datetime(?), datetime('now')), NULL, '${SENT_BY_CLOUD}')
       ON CONFLICT(event_id, phase) DO NOTHING`,
    )
    .run(eventId, phase, sentAt ?? null);
  return result.changes;
}

/**
 * The desk checked the mailbox (or the Resend log) and the email DID arrive:
 * close a `delivery_unknown` row without sending anything (slice E, R-E14).
 *
 * `sent_at` is deliberately untouched — it is the moment the provider call
 * started, which is as close to the real send time as we will ever get, and
 * rewriting it to "now" would date the email to the day someone confirmed it.
 * The confirmation itself is appended to `provider_response`, so the audit
 * string says both what the relay reported (if anything) and that a human
 * closed the row. The leading separator is dropped when the column was empty,
 * so the value is never a bare "; ".
 *
 * Compare-and-set on the state: 0 rows means the row is not (or is no longer)
 * `delivery_unknown`, and the route answers 409 rather than pretending.
 */
export function markEmailDeliveredByHand(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  now: () => Date = () => new Date(),
): boolean {
  const stamp = `confirmed by hand ${now().toISOString()}`;
  return (
    db
      .prepare(
        `UPDATE earnings_emails
            SET error = NULL,
                provider_response = CASE
                  WHEN provider_response IS NULL OR provider_response = '' THEN ?
                  ELSE provider_response || '; ' || ?
                END
          WHERE event_id = ? AND phase = ? AND error = '${DELIVERY_UNKNOWN}'`,
      )
      .run(stamp, stamp, eventId, phase).changes === 1
  );
}
