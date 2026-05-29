/**
 * Worker mirror of lib/calendar/market-holidays.ts — the Worker can't import
 * app code, so this is a self-contained copy. The two lists MUST stay in sync;
 * test/market-holidays.test.ts pins the array so a drift fails CI.
 *
 * Verified 2026-05-29 against the NYSE 2026 trading calendar. Only FULL-day
 * closures belong here (early-close days keep the market open → emails send).
 * Re-verify against nyse.com/markets/hours-calendars before extending past 2027.
 */

/** YYYY-MM-DD strings the NYSE is fully closed. Keep in sync with the Mac copy. */
export const NYSE_FULL_CLOSURES: readonly string[] = [
  // ── 2026 ──
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // ── 2027 ──
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
];

const HOLIDAY_SET = new Set(NYSE_FULL_CLOSURES);

export function isMarketHoliday(date: string): boolean {
  return HOLIDAY_SET.has(date);
}

/** Add whole days to a YYYY-MM-DD, noon-UTC anchored so slice(0,10) is stable. */
function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isMarketClosed(date: string): boolean {
  return isWeekend(date) || isMarketHoliday(date);
}

/**
 * Whether the weekly briefing should send today, with holiday shifting.
 *  - Sunday: send unless the next Monday is a holiday (defer to Monday).
 *  - Monday: send only if that Monday is itself a holiday (Sunday was skipped).
 *  - else: never.
 */
export function shouldSendBriefingToday(today: string): boolean {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (dow === 0) return !isMarketHoliday(addDaysISO(today, 1));
  if (dow === 1) return isMarketHoliday(today);
  return false;
}
