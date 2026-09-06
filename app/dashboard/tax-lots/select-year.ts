/**
 * Resolve the tax-lots page's `?year=` query param to a usable tax year.
 *
 * QA finding tax-lots--non-numeric-year-renders-nan-tiles-and-tax-report-400:
 * the page did a bare `parseInt(searchParams.year, 10)`, so `?year=all` (or
 * any non-numeric value) flowed `NaN` into every consumer — the headline
 * tiles rendered "NAN REALIZED / NAN LONG-TERM / NAN SHORT-TERM" and the
 * TaxReportCard fetched `/api/tax-report?year=NaN`, which the route rejects
 * with a 400 "Invalid year", taking the CSV/TXF export buttons with it.
 *
 * Rules (single source for the page):
 *   - a parseable integer inside the same [2000, 2100] window the
 *     `/api/tax-report` route accepts is used as-is (a year with no sales is
 *     a legitimate empty view, not an error);
 *   - anything else — absent, non-numeric, out of range — falls back exactly
 *     like an absent param: the current calendar year when it has sales,
 *     otherwise the most recent year that does, otherwise the calendar year.
 */
export const TAX_YEAR_MIN = 2000;
export const TAX_YEAR_MAX = 2100;

export function resolveSelectedYear(
  raw: string | undefined,
  availableYears: number[],
  currentCalendarYear: number,
): number {
  if (raw !== undefined && raw !== "") {
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= TAX_YEAR_MIN && parsed <= TAX_YEAR_MAX) {
      return parsed;
    }
  }
  if (availableYears.includes(currentCalendarYear)) return currentCalendarYear;
  return availableYears[0] ?? currentCalendarYear;
}
