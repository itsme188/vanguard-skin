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
  const rows = db
    .prepare(
      `SELECT id, symbol FROM calendar_events
        WHERE event_type = 'earnings'
          AND event_date >= ? AND event_date <= ?
          AND symbol IS NOT NULL
          AND COALESCE(superseded, 0) = 0`,
    )
    .all(startDate, endDate) as Array<{ id: number; symbol: string | null }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.symbol) continue;
    const key = row.symbol.toUpperCase();
    if (!map.has(key)) map.set(key, row.id);
  }
  return map;
}
