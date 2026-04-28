/**
 * Shared calendar date utilities — single source of truth for Monday calculations.
 *
 * All calendar features (page, sync, briefing, email) must use these functions
 * instead of local reimplementations to avoid week-targeting inconsistencies.
 */

/**
 * Get the "current" Monday for calendar display:
 * - Mon–Fri: returns this week's Monday
 * - Sat–Sun: returns NEXT Monday (business week is over)
 */
export function getCurrentMonday(now = new Date()): string {
  const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 1 : day === 6 ? 2 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return formatDate(monday);
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

/** Format a Date as YYYY-MM-DD using local date parts (avoids UTC shift). */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
