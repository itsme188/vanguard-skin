import { parseStoredTimestamp } from "@/lib/format";

const etDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

/**
 * The Eastern calendar date (YYYY-MM-DD) a level last fired on.
 *
 * `security_levels.triggered_at` is a UTC timestamp. Slicing its first ten
 * characters prints the UTC date, so an evening fire (8:30pm Eastern) showed
 * the next day. Returns null for a missing or unparseable value; the caller
 * supplies its own "unrecorded" wording.
 */
export function lastFiredDateET(triggeredAt: string | null | undefined): string | null {
  if (!triggeredAt) return null;
  const d = parseStoredTimestamp(triggeredAt);
  if (Number.isNaN(d.getTime())) return null;
  return etDateFormatter.format(d);
}
