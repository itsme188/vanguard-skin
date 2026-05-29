/**
 * US equity-market (NYSE/Nasdaq) full-day holiday calendar — single source of
 * truth for "is the market closed today" gating of automated emails.
 *
 * Verified 2026-05-29 against the official NYSE 2026 trading calendar
 * (nyse.com `ICE_NYSE_2026_Yearly_Trading_Calendar.pdf`) and cross-checked
 * against Kiplinger / Fidelity / AARP. 2027 from the NYSE 2025–2027 announcement
 * plus federal observance rules (Sat holiday → preceding Fri; Sun → following Mon).
 *
 * IMPORTANT (verify-external-truth rule): re-verify against
 * nyse.com/markets/hours-calendars before extending past 2027. The classic trap
 * is the observed-day shift — e.g. Jul 4 2026 is a Saturday, so the FULL closure
 * is Fri Jul 3 (Jul 2 is only a 1pm EARLY close, NOT a holiday).
 *
 * Only FULL-day closures belong here. Early-close (1pm) days keep the market
 * OPEN, so emails still send — do not add them.
 */

import { addDays } from "@/lib/calendar/date-utils";

/** YYYY-MM-DD strings the NYSE is fully closed. Keep sorted by date. */
export const NYSE_FULL_CLOSURES: readonly string[] = [
  // ── 2026 ──
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King, Jr. Day
  "2026-02-16", // Washington's Birthday (Presidents Day)
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed — Jul 4 is Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  // ── 2027 ──
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King, Jr. Day
  "2027-02-15", // Washington's Birthday (Presidents Day)
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed — Jun 19 is Saturday)
  "2027-07-05", // Independence Day (observed — Jul 4 is Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (observed — Dec 25 is Saturday)
];

const HOLIDAY_SET = new Set(NYSE_FULL_CLOSURES);

/** True if the given YYYY-MM-DD (ET market date) is a full-day NYSE closure. */
export function isMarketHoliday(date: string): boolean {
  return HOLIDAY_SET.has(date);
}

/** Saturday/Sunday check on a YYYY-MM-DD (noon-anchored to avoid TZ drift). */
function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** True when the market is closed all day: weekend OR a full holiday. */
export function isMarketClosed(date: string): boolean {
  return isWeekend(date) || isMarketHoliday(date);
}

/** The next date strictly after `date` on which the market is open. */
export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  let guard = 0;
  while (isMarketClosed(d) && guard++ < 14) d = addDays(d, 1);
  return d;
}

/**
 * Whether the weekly week-ahead briefing should send TODAY, given holiday
 * shifting. The briefing normally goes out Sunday; when the upcoming Monday is
 * a market holiday the trading week starts Tuesday, so we defer the briefing to
 * that Monday instead (so it covers the real week, not a closed day).
 *
 *  - Sunday: send unless the next Monday is a holiday (then defer to Monday).
 *  - Monday: send ONLY if that Monday is itself a holiday (Sunday was skipped).
 *  - Any other day: never.
 */
export function shouldSendBriefingToday(today: string): boolean {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (dow === 0) return !isMarketHoliday(addDays(today, 1)); // Sunday
  if (dow === 1) return isMarketHoliday(today); // Monday
  return false;
}
