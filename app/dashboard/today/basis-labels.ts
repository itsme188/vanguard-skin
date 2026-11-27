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
 * Note beside the Portfolio strip's "as of" date when the Vanguard positions
 * behind the total are older than that headline date. Null when they are not
 * older, or when either date is unknown. Since plan v4 (Plaid session dating)
 * a Vanguard position row is dated on the session whose close it describes,
 * so the note names that close.
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
  return `Vanguard positions from the ${shortDate(vanguard, today)} close`;
}

/**
 * The dates behind one account's value, as `getPortfolioCurrentValues`
 * returns them (lib/queries/dashboard.ts). Declared here, structurally, so
 * this file stays import-free.
 */
export interface AccountValueCaptionInput {
  /** Which row the value was read from. */
  sourceKind: "live" | "daily" | "statement" | null;
  /** Date of that row. */
  asOfDate: string | null;
  /** The account's latest daily valuation row. */
  valuationDate: string | null;
  /** Date and source of the newest holdings rows (tombstones left out). */
  holdingsSession: string | null;
  holdingsSource: "statement" | "plaid" | "tws" | null;
  /** Date and source of the newest monthly_snapshots anchor. */
  anchorSession: string | null;
  anchorSource: "statement" | "plaid" | "tws" | null;
}

/**
 * The caption under the Portfolio strip for one Vanguard account (plan v4,
 * unit U3). Two sentences, positions first, then the value:
 *
 *  - "Positions from the <session> close (Plaid)." when the newest rows are
 *    Plaid's AND a Plaid anchor sits on that same date; Plaid rows with no
 *    Plaid anchor on their date never read as a Plaid close ("Positions from
 *    Plaid, dated <session>.").
 *  - "Positions from the <session> statement." for statement rows.
 *  - The value: a daily valuation dated after the newest anchor reads
 *    "Valued <date> at the latest prices." (never "a Plaid close"); one
 *    dated before it (a valuation that has not caught up, plan A8) reads
 *    "Value not yet updated for the <anchor> close."; one on the anchor's
 *    own date reads as that close or statement. A value read straight from a
 *    statement row names the statement.
 *
 * Words only: it never touches a figure. Null when there is nothing true to
 * say (no positions and no value).
 */
export function accountValueCaption(input: AccountValueCaptionInput, today: string): string | null {
  const parts: string[] = [];

  const session = datePart(input.holdingsSession);
  const anchor = datePart(input.anchorSession);
  if (session !== null) {
    if (input.holdingsSource === "statement") {
      parts.push(`Positions from the ${shortDate(session, today)} statement.`);
    } else if (input.holdingsSource === "plaid") {
      parts.push(
        input.anchorSource === "plaid" && anchor === session
          ? `Positions from the ${shortDate(session, today)} close (Plaid).`
          : `Positions from Plaid, dated ${shortDate(session, today)}.`,
      );
    } else if (input.holdingsSource === "tws") {
      parts.push(`Positions from the ${shortDate(session, today)} broker sync.`);
    }
  }

  const asOf = datePart(input.asOfDate);
  if (input.sourceKind === "statement" && asOf !== null) {
    parts.push(`Valued at the ${shortDate(asOf, today)} statement.`);
  } else if (input.sourceKind === "live" && asOf !== null) {
    parts.push(`Live broker value, ${shortDate(asOf, today)}.`);
  } else if (input.sourceKind === "daily") {
    const valued = datePart(input.valuationDate) ?? asOf;
    if (valued !== null) {
      if (anchor === null || valued > anchor) {
        parts.push(`Valued ${shortDate(valued, today)} at the latest prices.`);
      } else if (valued < anchor) {
        parts.push(`Value not yet updated for the ${shortDate(anchor, today)} close.`);
      } else if (input.anchorSource === "plaid") {
        parts.push(`Valued at the ${shortDate(anchor, today)} close (Plaid).`);
      } else if (input.anchorSource === "statement") {
        parts.push(`Valued at the ${shortDate(anchor, today)} statement.`);
      } else {
        parts.push(`Valued ${shortDate(valued, today)}.`);
      }
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
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
