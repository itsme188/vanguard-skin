/**
 * The sentence the Earnings Hub shows on the LATER of two hand-entered
 * earnings rows for one company (owner ruling 2026-10-07: email follows the
 * earlier date; the later row is ignored for email until the user deletes
 * one of the two). Symbol and date are public calendar data.
 *
 * Its own file so the wording is unit-testable without importing the Hub's
 * server component (which pulls in the database singleton).
 */
export function emailFollowsEarlierCopy(symbol: string, emailRowDate: string): string {
  return (
    `Email follows your earlier ${symbol} entry (${emailRowDate}). ` +
    `Delete one of the two entries to settle the date.`
  );
}
