/**
 * Input checks shared by the routes that let a person type a calendar event:
 * POST/PATCH /api/calendar/events, POST /api/earnings/correct-date and
 * POST /api/earnings/confirm-date. Each returns a plain sentence to show the
 * user, or null when the value is acceptable.
 */
import { addDays } from "@/lib/calendar/date-utils";

/** Longest ticker the app stores for a listed security (e.g. 402340.KS). */
export const MAX_TICKER_LENGTH = 12;

// Letters and digits, optionally joined by single dots, dashes or slashes:
// AAPL, BRK.B, BF-B, 402340.KS. No spaces, no other punctuation, and a
// separator is never first, last or doubled.
const TICKER_SHAPE_RE = /^[A-Z0-9]+(?:[./-][A-Z0-9]+)*$/;

/** Trim and uppercase, the way every calendar row stores its symbol. */
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Can this text be a ticker at all? Shape only: a well-formed symbol the app
 * has never seen is still accepted (a name that is not held or watched can
 * report earnings too).
 */
export function tickerShapeError(raw: string): string | null {
  const symbol = normalizeTicker(raw);
  if (symbol.length <= MAX_TICKER_LENGTH && TICKER_SHAPE_RE.test(symbol)) return null;
  const shown = raw.trim().slice(0, 24);
  return (
    `"${shown}" is not a ticker symbol. Use letters and digits only, with a dot, a dash or a slash ` +
    `for a share class (for example BRK.B), up to ${MAX_TICKER_LENGTH} characters. Nothing was saved.`
  );
}

/** Earliest date a typed event may carry. */
export const MIN_MANUAL_EVENT_DATE = "2000-01-01";
/** How far ahead of today a typed event may sit. */
export const MAX_MANUAL_EVENT_YEARS_AHEAD = 2;

/** Is this YYYY-MM-DD text a day that exists (2026-02-30 does not)? */
function isRealCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Bounds for a date a person typed. `today` is the US Eastern date
 * (`todayET()`). Refuses a day that does not exist, anything before 2000 and
 * anything more than two years ahead: a typo'd year would otherwise store a
 * row no screen ever shows and no sync ever corrects.
 */
export function manualEventDateError(date: string, today: string, field = "date"): string | null {
  if (!isRealCalendarDate(date)) {
    return `The ${field} ${date} is not a real calendar day. Use YYYY-MM-DD. Nothing was saved.`;
  }
  if (date < MIN_MANUAL_EVENT_DATE) {
    return `The ${field} ${date} is before the year 2000. Check the year. Nothing was saved.`;
  }
  const latest = addDays(today, 365 * MAX_MANUAL_EVENT_YEARS_AHEAD);
  if (date > latest) {
    return (
      `The ${field} ${date} is more than ${MAX_MANUAL_EVENT_YEARS_AHEAD} years ahead ` +
      `(the latest allowed is ${latest}). Check the year. Nothing was saved.`
    );
  }
  return null;
}
