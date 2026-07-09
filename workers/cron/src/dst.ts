/**
 * DST-aware wall-clock check for ET.
 *
 * Cloudflare Workers cron fires in UTC only — there's no seasonal config.
 * We register 4 cron triggers (summer + winter slots × briefing + digest),
 * and this module gates each firing so only the correct one executes.
 *
 * Why not use getTimezoneOffset: in V8, Date methods reflect UTC; there's no
 * host locale. Intl.DateTimeFormat with a timeZone option is the only
 * reliable way to compute a wall-clock hour in an arbitrary zone.
 */

const ET_ZONE = "America/New_York";

export function getCurrentETHour(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(fmt.format(now), 10);
  // `hour: "numeric"` with hour12:false returns "0" through "23" but some
  // runtimes emit "24" at midnight — normalize.
  return hour % 24;
}

export function getCurrentETMinute(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    minute: "numeric",
  });
  return parseInt(fmt.format(now), 10);
}

export function shouldRunNow(expectedHour: number, now: Date = new Date()): boolean {
  return getCurrentETHour(now) === expectedHour;
}

/** Today's date in ET (YYYY-MM-DD). Used as marker keys so they match the Mac's local day. */
export function todayET(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now); // en-CA yields YYYY-MM-DD
}

/**
 * Formats an arbitrary UTC timestamp (as stored in Mac `computed_at` columns,
 * e.g. "2026-07-14 06:00:00" — UTC, space-separated, no zone suffix, written
 * via `new Date(nowMs).toISOString().replace("T"," ").slice(0,19)`) as an ET
 * wall-clock label for the earnings-intelligence "as of" suffix (e.g.
 * "Jul 14 02:00 ET"). Falls back to the raw string when unparseable so a
 * malformed value degrades to visible-but-odd rather than throwing.
 */
export function formatEtTimestamp(storedUtc: string): string {
  const iso = /Z$|[+-]\d{2}:\d{2}$/.test(storedUtc)
    ? storedUtc
    : `${storedUtc.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return storedUtc;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Normalize a possible "24" midnight edge case (same gotcha as getCurrentETHour).
  const hour = (parseInt(get("hour"), 10) % 24).toString().padStart(2, "0");
  const minute = get("minute").padStart(2, "0");
  return `${get("month")} ${get("day")} ${hour}:${minute} ET`;
}

/** Day of week in ET. 0 = Sunday, 1 = Monday, ..., 6 = Saturday. */
export function getCurrentETDayOfWeek(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    weekday: "short",
  });
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[fmt.format(now)] ?? -1;
}
