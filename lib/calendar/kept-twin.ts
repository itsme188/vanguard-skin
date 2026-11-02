/**
 * Follow a superseded earnings row to the row that kept its print.
 *
 * The reconciler (`reconcileEarningsDates`) marks every row of a cluster but
 * one `superseded = 1` and repoints the print's children (worksheet flags,
 * bogeys, emails, print-watch rows, filing-summary runs and pushes) at the
 * kept row. A link minted before that flip still names the old id: the
 * filing-summary pushes link to `/dashboard/print/<event_id>/filings`, and
 * after a Refresh flipped the kept twin that page said the print had no
 * summary (QA: dashboard-print-2117-filings-the-link-the-msft-filing-summary-
 * pushes-carry-calendar-refresh-kept-row-flip-afte).
 *
 * Same cluster rule as the reconciler and `findHiddenFinnhubDonor`: the same
 * issuer family (`issuerSiblings`, never symbol equality), an unsuperseded
 * earnings row within CLUSTER_PROXIMITY_DAYS of the superseded row's date;
 * nearest date first, then lowest id. Read-only.
 */
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { CLUSTER_PROXIMITY_DAYS } from "@/lib/calendar/reconcile-earnings-dates";
import { addDays } from "@/lib/calendar/date-utils";

export interface KeptEarningsEvent {
  /** The row to read: the kept twin, or the addressed row itself. */
  id: number;
  /** The superseded id the caller asked for, when the answer is another row. */
  followedFrom: number | null;
}

/**
 * Null when no calendar row has that id. The row itself when it is not an
 * earnings row, is not superseded, or has no kept twin to follow (a
 * superseded row with no winner is still shown as it is).
 */
export function resolveKeptEarningsEventId(
  db: Database.Database,
  eventId: number,
): KeptEarningsEvent | null {
  const row = db
    .prepare(
      `SELECT id, event_type, symbol, event_date, COALESCE(superseded, 0) AS superseded
         FROM calendar_events WHERE id = ?`,
    )
    .get(eventId) as
    | { id: number; event_type: string; symbol: string | null; event_date: string; superseded: number }
    | undefined;
  if (!row) return null;
  if (row.event_type !== "earnings" || row.superseded !== 1 || !row.symbol) {
    return { id: row.id, followedFrom: null };
  }
  const family = [...new Set(issuerSiblings(row.symbol).map((s) => s.toUpperCase()))];
  if (family.length === 0) return { id: row.id, followedFrom: null };
  const kept = db
    .prepare(
      `SELECT id, event_date
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND COALESCE(superseded, 0) = 0 AND id != ?
          AND UPPER(symbol) IN (${family.map(() => "?").join(",")})
          AND event_date BETWEEN ? AND ?
        ORDER BY ABS(julianday(event_date) - julianday(?)) ASC, id ASC
        LIMIT 1`,
    )
    .get(
      row.id,
      ...family,
      addDays(row.event_date, -CLUSTER_PROXIMITY_DAYS),
      addDays(row.event_date, CLUSTER_PROXIMITY_DAYS),
      row.event_date,
    ) as { id: number; event_date: string } | undefined;
  if (!kept) return { id: row.id, followedFrom: null };
  return { id: kept.id, followedFrom: row.id };
}
