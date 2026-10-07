import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import {
  emailIgnoredManualTwins,
  type EmailFollowsEarlierRow,
  type ManualTwinRow,
} from "@/lib/earnings/manual-twin-email";

/**
 * The hand-entered earnings rows email ignores, keyed by event id — the one
 * read every Mac email finder and the Hub share (owner ruling 2026-10-07:
 * with two live hand-entered rows for one company, the earlier date counts
 * for email). The rule itself is `emailIgnoredManualTwins`
 * (lib/earnings/manual-twin-email.ts, mirrored on the Worker).
 *
 * Reads every live hand-entered earnings row, not a date window: the earlier
 * row decides whether a later one is ignored even after its own email went
 * out and it has left every finder's window.
 */
export function getEmailIgnoredManualTwins(
  db: Database.Database,
): Map<number, EmailFollowsEarlierRow> {
  const rows = db
    .prepare(
      `SELECT id, symbol, event_date, source, event_type
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND source = 'manual'
          AND symbol IS NOT NULL
          AND COALESCE(superseded, 0) = 0`,
    )
    .all() as ManualTwinRow[];
  return emailIgnoredManualTwins(rows, issuerSiblings);
}
