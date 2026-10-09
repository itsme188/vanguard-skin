/**
 * The read-only record of ONE event's print, whatever state it is in.
 *
 * Why this exists: `getWatchStatus` (lib/print-watch/watcher.ts) lists active
 * prints plus the prints that expired TODAY, and deliberately nothing older.
 * That feed also drives the poll interval, the live countdown, the "Live
 * prints outside this week" block and the ensure route's count, so it must not
 * be widened. A finished print dated before today is therefore in no feed, and
 * an armed Hub row expanded the next morning had no way to reach the figures
 * the desk accepted. This is the scoped read for that one row.
 *
 * It lives beside `print-outputs.ts` rather than in `lib/print-watch/` because
 * the outputs evaluation reads the send audit row through `@/lib/digest`, and
 * no `lib/print-watch` module may import that tree
 * (tests/repo/print-watch-import-boundaries.test.ts, R-D22).
 *
 * Store reads only: `GET /api/print-watch/record` calls this, and a GET must
 * never write (tests/api/no-state-changing-get.test.ts).
 */
import type Database from "better-sqlite3";
import { getPrintByEventId, getSheet, listDocuments } from "@/lib/print-watch/store";
import { evaluatePrintOutputs, type PrintOutputs } from "@/lib/earnings/print-outputs";
import type { PrintWatchLine, PrintWatchState } from "@/lib/print-watch/types";

export interface PrintRecord {
  eventId: number;
  /** null when no print was ever created for the event. */
  print: {
    printId: number;
    symbol: string;
    /** The print row's own event date (YYYY-MM-DD). */
    eventDate: string;
    state: PrintWatchState;
  } | null;
  /** The whole sheet as stored. The client picks which lines the record shows
   *  (`recordLines` in app/dashboard/today/live-print/helpers.ts). */
  lines: PrintWatchLine[];
  /** doc id to document kind, so a figure can name its source. */
  documents: Record<number, string>;
  /** The same evaluation the status route sends; null when there is no print. */
  outputs: PrintOutputs | null;
}

export function getPrintRecord(db: Database.Database, eventId: number): PrintRecord {
  // No state filter: an expired or disarmed print is exactly what this reads.
  const print = getPrintByEventId(db, eventId);
  if (!print) return { eventId, print: null, lines: [], documents: {}, outputs: null };
  const documents: Record<number, string> = {};
  for (const doc of listDocuments(db, print.id)) documents[doc.id] = doc.kind;
  return {
    eventId,
    print: {
      printId: print.id,
      symbol: print.symbol,
      eventDate: print.event_date,
      state: print.state,
    },
    lines: getSheet(db, print.id),
    documents,
    outputs: evaluatePrintOutputs(db, print.id),
  };
}
