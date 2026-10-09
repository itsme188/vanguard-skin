import type Database from "better-sqlite3";
import { todayET, addDays, easternDayStartIso, isDateOnly } from "@/lib/calendar/date-utils";
import { getLastDigestSentAt } from "@/lib/digest/daily-digest";

/**
 * Where a digest's article window opens. The sender captures this BEFORE its
 * slow fetch (a concurrent send would otherwise move the marker under it), and
 * the preview reads the same rule so the two never disagree.
 *
 * ET-anchored: a UTC slice reads tomorrow from 20:00 ET, which emptied an
 * evening "today" digest and skipped a day on the 24h fallback.
 */
export function resolveDigestSince(
  db: Database.Database,
  opts: { mode?: string; sinceDate?: string | null },
): string | null {
  if (opts.mode === "today") return todayET();
  if (opts.mode === "since_last") {
    return getLastDigestSentAt(db) || defaultDigestSince();
  }
  if (opts.mode === "since_date" && opts.sinceDate) return opts.sinceDate;
  return null; // legacy path: the caller applies defaultDigestSince()
}

/** The window for a caller that named no mode: the Eastern yesterday. */
export function defaultDigestSince(): string {
  return addDays(todayET(), -1);
}

/**
 * The instant a window opens, for a SQL `datetime(?)` comparison. A date-only
 * window opens at midnight Eastern (SQLite would read the bare date as UTC
 * midnight, the prior evening in Eastern). A full instant is returned as is.
 */
export function digestWindowStartInstant(since: string): string {
  return isDateOnly(since) ? easternDayStartIso(since) : since;
}
