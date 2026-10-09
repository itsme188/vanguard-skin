import type Database from "better-sqlite3";

/**
 * The one reader of `calendar_event_suppressions` (migration 070): the
 * (symbol, date, type) tuples the user removed from the calendar.
 *
 * Two callers must agree on what "suppressed" means, so both read it here:
 * the feed upsert and the delete paths (lib/mutations/calendar.ts), and the
 * earnings date reconciler (lib/calendar/reconcile-earnings-dates.ts). It
 * lives in its own file because the mutations module imports the reconciler;
 * the reconciler importing it back would be a cycle.
 */

/** `SYMBOL|date|type`, symbol trimmed and uppercased. */
export function suppressionKey(symbol: string, eventDate: string, eventType: string): string {
  return `${symbol.trim().toUpperCase()}|${eventDate}|${eventType}`;
}

/**
 * All suppressed tuples as `suppressionKey` strings. Returns an empty set when
 * the table doesn't exist (minimal hand-built test DBs) — same tolerance
 * pattern as the flow-adjusted risk lookup on a missing transactions table.
 */
export function getSuppressedEventTuples(db: Database.Database): Set<string> {
  try {
    const rows = db
      .prepare("SELECT symbol, event_date, event_type FROM calendar_event_suppressions")
      .all() as { symbol: string; event_date: string; event_type: string }[];
    return new Set(rows.map((r) => suppressionKey(r.symbol, r.event_date, r.event_type)));
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return new Set();
    throw err;
  }
}
