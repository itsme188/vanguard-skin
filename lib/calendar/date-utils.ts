/**
 * Shared calendar date utilities — single source of truth for Monday calculations.
 *
 * All calendar features (page, sync, briefing, email) must use these functions
 * instead of local reimplementations to avoid week-targeting inconsistencies.
 */

const ET_ZONE = "America/New_York";

/**
 * The given instant's calendar date in ET (America/New_York), as YYYY-MM-DD.
 *
 * Single source of truth for "what day is it" anywhere a date is shown to the
 * user or used to target a week. The portfolio is ET-centric (markets, statement
 * dates, calendar events), so "today" must be the ET day regardless of where the
 * Mac physically sits (user travels) or that a Cloudflare Worker runs in UTC.
 * Mirrors `workers/cron/src/dst.ts::todayET`.
 */
export function todayET(now = new Date()): string {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The given instant's wall-clock time in ET (America/New_York), as HH:MM
 * (24-hour, zero-padded — safe to compare lexically against e.g. "09:30").
 *
 * `hourCycle: "h23"` is deliberate: `hour12: false` on some ICU builds emits
 * "24:00" for midnight instead of "00:00", which would break a lexical
 * range check straddling midnight. Single source of truth for any
 * intraday-session gate (e.g. TWS regular-trading-hours tick priority) —
 * never derive ET clock time from local-time `Date` math.
 */
export function nowET(now = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

/** Day of week of the given instant in ET. 0=Sun, 1=Mon, ..., 6=Sat. */
function etDayOfWeek(now: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    weekday: "short",
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? now.getDay();
}

/**
 * Get the "current" Monday for calendar display:
 * - Mon–Fri: returns this week's Monday
 * - Sat–Sun: returns NEXT Monday (business week is over)
 *
 * ET-anchored: the day-of-week and base date are computed in America/New_York,
 * so a traveling Mac (foreign local TZ) or a UTC Worker never targets the wrong
 * week. This is the fix for the "Earnings this week shows last week" bug.
 */
export function getCurrentMonday(now = new Date()): string {
  const day = etDayOfWeek(now); // 0=Sun, 1=Mon, ..., 6=Sat (ET)
  const diff = day === 0 ? 1 : day === 6 ? 2 : 1 - day;
  // addDays does noon-anchored local arithmetic on a correct YYYY-MM-DD string,
  // so adding whole days never crosses a calendar boundary in the local zone.
  return addDays(todayET(now), diff);
}

/**
 * Add days to a YYYY-MM-DD string, returning YYYY-MM-DD.
 */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00"); // noon to avoid DST edge cases
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

/**
 * Whole calendar days between two YYYY-MM-DD strings (absolute value).
 *
 * Used by return-series computations to detect non-consecutive price rows: the
 * `prices` table mixes sparse month-end statement anchors with dense daily TWS
 * data, so adjacent rows are not always adjacent trading days. A pair whose gap
 * exceeds a small threshold (weekend + holidays + a missed day or two) spans a
 * statement-anchor discontinuity or sync outage and must NOT be treated as a
 * single-period return — see the beta/position-risk gap guards.
 */
export function calendarDaysBetween(a: string, b: string): number {
  const da = new Date(a + "T12:00:00"); // noon to avoid DST edge cases
  const db = new Date(b + "T12:00:00");
  return Math.abs(Math.round((db.getTime() - da.getTime()) / 86_400_000));
}

/**
 * Validate a weekOf parameter: must be YYYY-MM-DD and a Monday.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateWeekOf(weekOf: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
    return "weekOf must be YYYY-MM-DD format";
  }
  const d = new Date(weekOf + "T12:00:00");
  if (isNaN(d.getTime())) {
    return "weekOf is not a valid date";
  }
  if (d.getDay() !== 1) {
    return `weekOf must be a Monday (${weekOf} is a ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]})`;
  }
  return null;
}

/**
 * Format a week range for display: "Apr 7 – Apr 13, 2026"
 * Handles year boundaries: "Dec 29, 2025 – Jan 4, 2026"
 */
export function formatWeekRange(weekOf: string): string {
  const start = new Date(weekOf + "T12:00:00");
  const end = new Date(weekOf + "T12:00:00");
  end.setDate(end.getDate() + 6);

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  if (start.getFullYear() !== end.getFullYear()) {
    return `${fmt(start)}, ${start.getFullYear()} – ${fmt(end)}, ${end.getFullYear()}`;
  }
  return `${fmt(start)} – ${fmt(end)}, ${start.getFullYear()}`;
}

/**
 * Given any YYYY-MM-DD, return the Monday of that ISO week. Used by the
 * Earnings Hub manual-add flow: user picks a date, we compute the Monday
 * for `week_of` so the deduped query and weekly views surface the row.
 *
 * Sunday rolls back to the *previous* Monday (treats Sunday as part of
 * the week ending that day) — this matches how `getCurrentMonday()` shifts
 * Sunday FORWARD because the business week is over, but "the Monday this
 * date belongs to" naturally includes Sunday in the prior week.
 */
export function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return formatDate(d);
}

/**
 * Returns the YYYY-MM-DD date exactly 7 days before the input.
 */
export function weekAgo(dateStr: string): string {
  return addDays(dateStr, -7);
}

/**
 * Resolve a user-supplied ?weekOf= query param to a Monday. Forgiving by
 * design (it arrives from a URL, not a form): any valid date snaps to its
 * week's Monday via mondayOf; absent or unparseable input falls back to the
 * current Monday instead of erroring. Backs the week-ahead navigation
 * (qa: today-week-ahead--no-week-navigation-weekof-ignored).
 */
export function resolveWeekOfParam(param: string | undefined): string {
  if (!param || !/^\d{4}-\d{2}-\d{2}$/.test(param)) return getCurrentMonday();
  const d = new Date(param + "T12:00:00");
  if (isNaN(d.getTime())) return getCurrentMonday();
  return mondayOf(param);
}

/** Format a Date as YYYY-MM-DD using local date parts (avoids UTC shift). */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// `datetime('now')` shape: space-separated UTC, no 'Z' (e.g. "2026-08-13 01:00:00").
const SQLITE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Format a "generated at" timestamp as a short ET-anchored caption
 * ("Aug 12"). Accepts both real ISO strings (`toISOString()` — 'T' +
 * trailing 'Z'/offset) and SQLite's `datetime('now')` shape, which
 * `new Date()` would otherwise parse as LOCAL wall-clock time (wrong
 * instant) or reject outright as Invalid Date on some Safari versions.
 * Returns null (caller should hide the caption) when the input can't be
 * parsed as a valid date.
 */
export function formatGeneratedAt(raw: string): string | null {
  const iso = SQLITE_DATETIME_PATTERN.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}
