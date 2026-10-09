import type Database from "better-sqlite3";
import { getCurrentMonday, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";

/**
 * The cache key for macro themes (`analysis_macro_themes.week_of`): the Monday
 * of the Eastern-time week containing `now` (Sunday belongs to the week that
 * is ending). Every writer and reader of the theme cache must use this, never
 * a UTC date: from 20:00 ET on a Sunday the UTC date is already Monday.
 */
export function currentThemeWeek(now: Date = new Date()): string {
  return mondayOf(todayET(now));
}

/**
 * The weeks a READER should look in, best first. On a Saturday or Sunday the
 * Sunday briefing pre-generates themes for the week that starts the next
 * Monday (`getCurrentMonday` rolls forward on a weekend), so a weekend reader
 * prefers those once they exist and otherwise shows the week that is ending.
 * On a weekday this is just the current week. A writer from the card always
 * writes `currentThemeWeek()`; only the briefing writes the upcoming week.
 */
export function themeWeeksToRead(now: Date = new Date()): string[] {
  const current = currentThemeWeek(now);
  const upcoming = getCurrentMonday(now);
  return upcoming !== current ? [upcoming, current] : [current];
}

/** The cached themes a reader should show right now: the first of `themeWeeksToRead` that exists. */
export function getCachedMacroThemesForNow(
  db: Database.Database,
  scope: string,
  now: Date = new Date(),
): ReturnType<typeof getCachedMacroThemes> {
  for (const week of themeWeeksToRead(now)) {
    const cached = getCachedMacroThemes(db, scope, week);
    if (cached) return cached;
  }
  return null;
}

