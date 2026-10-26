/**
 * Release a preview that no longer covers its print (owner ruling
 * 2026-10-26, item 7; controller ruling: release = delete, no migration).
 *
 * A preview is a promise about ONE print date (CLAUDE.md, the repoint
 * invariant: a preview row only follows an event its send date could cover,
 * `date(sent_at) >= date(event_date, '-1 day')`). When a HAND-ENTERED
 * earnings row moves to a LATER date that its sent preview could not cover,
 * that preview is about a date that turned out to be wrong, not about the
 * new one. findEmailCandidates reads ANY preview row on the event as
 * "handled" and the (event_id, phase) slot is UNIQUE, so leaving the row in
 * place means the new date never gets its preview. The row is deleted —
 * the same outcome correctEarningsEventDate already has (its doomed row's
 * non-covering preview dies in the delete cascade, "the deliberate price of
 * the preview invariant") — and one info line records the release so it
 * stays traceable without a new table.
 *
 * What is kept:
 *  - a move of a day or less (the sent preview still covers the new date):
 *    the same print, so no second preview goes out;
 *  - a move to an EARLIER date: a preview sent before the earlier date
 *    already covers it by the same test, and releasing it would mail a second
 *    preview for one print. The helper refuses earlier moves outright so a
 *    caller cannot get this wrong;
 *  - a LIVE claim (`in_progress` / `sending`): the sender owns that row; the
 *    test reads the state only through `notLiveClaimSql`;
 *  - any row of a sync-owned (non-manual) event: vendor rows never move in
 *    place, and their previews follow the reconciler's repoint rules.
 *
 * `delivery_unknown` IS released: whether or not it arrived, it is a preview
 * for the wrong date. A preview SKIP recorded for the old date is released by
 * the same test on `skipped_at`: skipping the old date is not a decision about
 * the new one.
 *
 * Call it inside the mutation's own transaction, after the date is written.
 */

import type Database from "better-sqlite3";
import { notLiveClaimSql } from "@/lib/earnings/email-states";

/**
 * SQL: "a preview stamped at `stampExpr` could NOT cover a print on
 * `dateExpr`". The negation of the repoint test, `date()` on both sides.
 */
export function previewCannotCoverSql(stampExpr: string, dateExpr: string): string {
  return `date(${stampExpr}) < date(${dateExpr}, '-1 day')`;
}

/** JS twin, answered by SQLite so date handling matches the SQL exactly. */
export function previewStampCovers(
  db: Database.Database,
  stamp: string,
  eventDate: string,
): boolean {
  const row = db
    .prepare(`SELECT ${previewCannotCoverSql("?", "?")} AS stale`)
    .get(stamp, eventDate) as { stale: number | null };
  // An unreadable stamp (date() → NULL) is never treated as stale: when in
  // doubt, keep the preview counted (a missed preview beats a duplicate).
  return row.stale !== 1;
}

export interface ReleaseStalePreviewResult {
  emails: number;
  skips: number;
}

export function releaseStalePreviewOnMove(
  db: Database.Database,
  opts: { eventId: number; fromDate: string; toDate: string },
): ReleaseStalePreviewResult {
  const none = { emails: 0, skips: 0 };
  // Later moves only (see the header): an earlier date is already covered.
  if (!(opts.toDate > opts.fromDate)) return none;
  const event = db
    .prepare(`SELECT source, event_type FROM calendar_events WHERE id = ?`)
    .get(opts.eventId) as { source: string; event_type: string } | undefined;
  if (!event || event.source !== "manual" || event.event_type !== "earnings") return none;

  const staleEmails = db
    .prepare(
      `SELECT id FROM earnings_emails
        WHERE event_id = ? AND phase = 'preview'
          AND ${notLiveClaimSql("error")}
          AND ${previewCannotCoverSql("sent_at", "?")}`,
    )
    .all(opts.eventId, opts.toDate) as Array<{ id: number }>;
  const staleSkips = db
    .prepare(
      `SELECT id FROM earnings_email_skips
        WHERE event_id = ? AND phase = 'preview'
          AND ${previewCannotCoverSql("skipped_at", "?")}`,
    )
    .all(opts.eventId, opts.toDate) as Array<{ id: number }>;

  const deleteEmail = db.prepare(`DELETE FROM earnings_emails WHERE id = ?`);
  const deleteSkip = db.prepare(`DELETE FROM earnings_email_skips WHERE id = ?`);
  for (const row of staleEmails) {
    console.info(
      `[release-stale-preview] event ${opts.eventId} phase preview: sent preview released ` +
        `(old date ${opts.fromDate}, new date ${opts.toDate})`,
    );
    deleteEmail.run(row.id);
  }
  for (const row of staleSkips) {
    console.info(
      `[release-stale-preview] event ${opts.eventId} phase preview: preview skip released ` +
        `(old date ${opts.fromDate}, new date ${opts.toDate})`,
    );
    deleteSkip.run(row.id);
  }
  return { emails: staleEmails.length, skips: staleSkips.length };
}
