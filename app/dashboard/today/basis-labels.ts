/**
 * Label decisions for the Today page's two "which date is this?" lines.
 * Pure: they pick WORDS only and never touch a figure. They live here, not in
 * page.tsx, because a Next.js page file may only export its page fields.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar-date part of a stored date or datetime, or null if unusable. */
function datePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = value.split("T")[0].split(" ")[0];
  if (!ISO_DATE.test(day)) return null;
  return Number.isNaN(new Date(`${day}T12:00:00Z`).getTime()) ? null : day;
}

/** "Sep 17" — or "Sep 17, 2025" when the year differs from `today`'s. */
function shortDate(day: string, today: string): string {
  // Noon UTC is the same calendar date in New York all year round.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" as const }),
  }).format(new Date(`${day}T12:00:00Z`));
}

/**
 * Heading of the one-line IBKR snapshot. The move beside it is measured on one
 * trading-day pair; `sessionDate` is that pair's later date. Only when that is
 * today's Eastern date (`today`, from `todayET()`) may the heading say "today";
 * an earlier session is named, and an unknown one is never called "today".
 */
export function ibkrSnapshotHeading(sessionDate: string | null | undefined, today: string): string {
  const session = datePart(sessionDate);
  if (session === null) return "IBKR last session";
  if (session === today) return "IBKR today";
  return `IBKR ${shortDate(session, today)} session`;
}

/**
 * The word for WHEN a position was opened or added to, on the one-line IBKR
 * snapshot ("2 opened today"). It follows the heading's rule: "today" only when
 * the move's session is today's Eastern date; otherwise "that session", which
 * reads against a heading that names the session.
 */
export function ibkrSessionWord(sessionDate: string | null | undefined, today: string): string {
  return datePart(sessionDate) === today ? "today" : "that session";
}

/**
 * Note beside the Portfolio strip's "as of" date when the Vanguard holdings
 * behind the total are older than that headline date. Null when they are not
 * older, or when either date is unknown.
 */
export function olderVanguardBasisNote(
  vanguardHoldingsAsOf: string | null | undefined,
  headlineAsOf: string | null | undefined,
  today: string,
): string | null {
  const vanguard = datePart(vanguardHoldingsAsOf);
  const headline = datePart(headlineAsOf);
  if (vanguard === null || headline === null) return null;
  if (vanguard >= headline) return null;
  return `Vanguard holdings through ${shortDate(vanguard, today)}`;
}

/**
 * Words beside the Portfolio strip's delta chip: which statement the change is
 * measured against. Each account's baseline is its previous statement snapshot,
 * which is not always the prior month-end, so the chip names the date(s).
 * One shared date reads "vs Aug 31 statement"; differing dates read
 * "vs statements of Aug 29 to Aug 31". With no baseline date the old wording stays.
 */
export function portfolioBaselineLabel(
  earliest: string | null | undefined,
  latest: string | null | undefined,
  today: string,
): string {
  const first = datePart(earliest);
  const last = datePart(latest);
  if (first === null && last === null) return "vs prior month";
  if (first === null || last === null || first === last) {
    return `vs ${shortDate((first ?? last) as string, today)} statement`;
  }
  return `vs statements of ${shortDate(first, today)} to ${shortDate(last, today)}`;
}
