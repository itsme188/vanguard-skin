/**
 * The session label beside a broker quote (Gains at risk step 2, rulings R8
 * and P10). Pure: the Eastern clock and the NYSE calendar only.
 *
 * The broker's snapshot path can tell a live tick from a delayed one, but not
 * a frozen quote (the last quote of a closed session) from a live one. So the
 * page labels a quote taken outside the regular session "market closed: the
 * last quote" from this function, whatever ticks arrived.
 *
 * "regular-session" only on an open NYSE day, from 09:30 Eastern to before
 * the day's close. In a year NYSE_EARLY_CLOSE_YEARS covers, the close is the
 * listed early close (NYSE_EARLY_CLOSES) or 16:00: the list is complete for
 * those years, so an open market is never mislabelled. In any other year a
 * day whose previous or next weekday is a full closure is taken to close at
 * 13:00 (the conservative rule: the calendar cannot confirm such a day). Note
 * that NYSE_FULL_CLOSURES also stops at 2027, so past it only weekends are
 * known closures and the rule has nothing to sit next to until both lists
 * are extended from the NYSE calendar.
 */

import { addDays, nowET, todayET } from "@/lib/calendar/date-utils";
import {
  NYSE_EARLY_CLOSE_YEARS,
  earlyCloseTime,
  isMarketClosed,
  isMarketHoliday,
} from "@/lib/calendar/market-holidays";

export type QuoteSessionLabel = "regular-session" | "market-closed";

export const REGULAR_SESSION_OPEN_ET = "09:30";
export const REGULAR_SESSION_CLOSE_ET = "16:00";
/** The close assumed on an unlisted day next to a full closure. */
export const CONSERVATIVE_EARLY_CLOSE_ET = "13:00";

function isWeekendDay(date: string): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** The weekday (Mon-Fri) nearest `date` in the direction `step` (-1 back, +1 on). */
function adjacentWeekday(date: string, step: 1 | -1): string {
  let d = addDays(date, step);
  while (isWeekendDay(d)) d = addDays(d, step);
  return d;
}

/** The calendar the label reads; injectable so the uncovered-year rule can be tested. */
export interface SessionCalendar {
  isFullClosure: (date: string) => boolean;
  earlyClose: (date: string) => string | null;
  coveredYears: readonly number[];
}

const NYSE_CALENDAR: SessionCalendar = {
  isFullClosure: isMarketHoliday,
  earlyClose: earlyCloseTime,
  coveredYears: NYSE_EARLY_CLOSE_YEARS,
};

/** The Eastern close time (HH:MM) of an open day. */
export function sessionCloseET(day: string, calendar: SessionCalendar = NYSE_CALENDAR): string {
  const listed = calendar.earlyClose(day);
  if (listed !== null) return listed;
  if (calendar.coveredYears.includes(Number(day.slice(0, 4)))) return REGULAR_SESSION_CLOSE_ET;
  if (calendar.isFullClosure(adjacentWeekday(day, -1)) || calendar.isFullClosure(adjacentWeekday(day, 1))) {
    return CONSERVATIVE_EARLY_CLOSE_ET;
  }
  return REGULAR_SESSION_CLOSE_ET;
}

/** The label for a quote fetched at `now`, against a given calendar. */
export function quoteSessionLabelWith(now: Date, calendar: SessionCalendar): QuoteSessionLabel {
  const day = todayET(now);
  if (isWeekendDay(day) || calendar.isFullClosure(day)) return "market-closed";
  const clock = nowET(now); // "HH:MM", 24-hour, Eastern
  if (clock < REGULAR_SESSION_OPEN_ET) return "market-closed";
  if (clock >= sessionCloseET(day, calendar)) return "market-closed";
  return "regular-session";
}

/** The label for a quote fetched at `now` (the NYSE calendar). */
export function quoteSessionLabel(now: Date): QuoteSessionLabel {
  // isMarketClosed is the NYSE calendar's own closed-day test (weekend or full closure).
  if (isMarketClosed(todayET(now))) return "market-closed";
  return quoteSessionLabelWith(now, NYSE_CALENDAR);
}
