/**
 * The sentence the Earnings Hub shows on the LATER of two hand-entered
 * earnings rows for one company (owner ruling 2026-10-07: email follows the
 * earlier date; the later row is ignored for email until the user deletes
 * one of the two). Symbol and date are public calendar data.
 *
 * Its own file so the wording is unit-testable without importing the Hub's
 * server component (which pulls in the database singleton).
 */
export function emailFollowsEarlierCopy(
  symbol: string,
  emailRowDate: string,
  entryCount: number,
  today: string,
): string {
  const remedy = `Delete one of the ${entryCount} entries to settle the date.`;
  // A date already behind us is not worth naming: say it has passed instead.
  if (emailRowDate < today) {
    return (
      `Email follows your earliest ${symbol} entry, whose date has already passed. ` + remedy
    );
  }
  return `Email follows your earlier ${symbol} entry (${emailRowDate}). ` + remedy;
}
