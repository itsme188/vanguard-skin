import type Database from "better-sqlite3";

/**
 * Candidate map for the bogeys-upload fan-out: uppercase symbol → the LIVE
 * earnings event id inside [startDate, endDate].
 *
 * Superseded rows are excluded — a date correction leaves the wrong vendor
 * row behind flagged `superseded = 1`, and every rendering surface (hub,
 * week-ahead, cockpit) filters it. Matching a bogey onto that row makes the
 * curated sheet invisible forever while the upload still reports "matched",
 * so the fan-out must share the same filter. A symbol whose only in-window
 * row is superseded is deliberately absent from the map: reporting it
 * unmatched is honest, attaching it is silent data loss.
 *
 * First-write-wins on duplicate live rows (candidate sets are small; the
 * Finnhub-vs-Nasdaq preference is handled by the surfaces that render).
 */
export function buildBogeyEventMap(
  db: Database.Database,
  startDate: string,
  endDate: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [key, match] of buildBogeyEventMatchMap(db, startDate, endDate)) {
    map.set(key, match.eventId);
  }
  return map;
}

/** What an upload landed on: enough to NAME the write to the user. */
export interface BogeyEventMatch {
  eventId: number;
  /** The event's own symbol (a share-class sibling of the uploaded one, maybe). */
  symbol: string;
  /** The event's own date — the match window is wider than the visible week,
   *  so this can be a day the page is not showing. */
  eventDate: string;
}

/**
 * The same candidate set as `buildBogeyEventMap`, carrying the event's symbol
 * and date as well as its id (qa: upload match-success-unnamed-off-week). The
 * upload reports "1/1 matched" without saying which event it wrote to; the
 * id alone cannot say it, and the page's week is not the event's week.
 */
export function buildBogeyEventMatchMap(
  db: Database.Database,
  startDate: string,
  endDate: string,
): Map<string, BogeyEventMatch> {
  const rows = db
    .prepare(
      `SELECT id, symbol, event_date FROM calendar_events
        WHERE event_type = 'earnings'
          AND event_date >= ? AND event_date <= ?
          AND symbol IS NOT NULL
          AND COALESCE(superseded, 0) = 0`,
    )
    .all(startDate, endDate) as Array<{ id: number; symbol: string | null; event_date: string }>;

  const map = new Map<string, BogeyEventMatch>();
  for (const row of rows) {
    if (!row.symbol) continue;
    const key = row.symbol.toUpperCase();
    if (!map.has(key)) map.set(key, { eventId: row.id, symbol: row.symbol, eventDate: row.event_date });
  }
  return map;
}

/**
 * Why an uploaded symbol matched no event, in one short clause the upload
 * button can print after the symbol (to-do n1: "a bogey upload that matched
 * nothing gives no reason"). Read-only, issuer-family aware, the same live-row
 * rule as the match map.
 *
 *   - "next earnings on the calendar is 2026-11-05, outside 10/17–10/30"
 *   - "last earnings on the calendar was 2026-07-30, outside 10/17–10/30"
 *   - "no earnings date on the calendar for it"
 */
export function unmatchedBogeyReason(
  db: Database.Database,
  family: readonly string[],
  startDate: string,
  endDate: string,
): string {
  const symbols = [...new Set(family.map((s) => s.toUpperCase()))];
  if (symbols.length === 0) return "no earnings date on the calendar for it";
  const marks = symbols.map(() => "?").join(", ");
  const live = `event_type = 'earnings' AND UPPER(symbol) IN (${marks}) AND COALESCE(superseded, 0) = 0`;
  const next = db
    .prepare(`SELECT MIN(event_date) AS d FROM calendar_events WHERE ${live} AND event_date > ?`)
    .get(...symbols, endDate) as { d: string | null };
  const last = db
    .prepare(`SELECT MAX(event_date) AS d FROM calendar_events WHERE ${live} AND event_date < ?`)
    .get(...symbols, startDate) as { d: string | null };
  const span = `${shortMonthDay(startDate)}–${shortMonthDay(endDate)}`;
  if (next.d) return `next earnings on the calendar is ${next.d}, outside ${span}`;
  if (last.d) return `last earnings on the calendar was ${last.d}, outside ${span}`;
  return "no earnings date on the calendar for it";
}

function shortMonthDay(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso;
}
