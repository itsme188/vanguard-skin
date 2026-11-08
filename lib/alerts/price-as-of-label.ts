/**
 * The label over an alerts-page price. "Now" is a claim that the figure is
 * live; a stored close from an earlier Eastern day is dated instead, the way
 * the security hub's hero says "AS OF <date>". Import-free so the client page
 * and a test can both read it.
 *
 * @param priceDate  the stored close's YYYY-MM-DD, or null when unknown
 * @param todayEt    today's Eastern day, YYYY-MM-DD
 */
export function priceAsOfLabel(priceDate: string | null | undefined, todayEt: string): string {
  if (!priceDate) return "Now";
  return priceDate === todayEt ? "Now" : `${priceDate} close`;
}

/** True when the stored close is from before today's Eastern day. */
export function priceIsFromEarlierDay(
  priceDate: string | null | undefined,
  todayEt: string,
): boolean {
  return !!priceDate && priceDate !== todayEt;
}

export const DATED_PRICE_EXPLANATION =
  "The latest stored close for this security, not a live quote. The scanner compares the level against this figure.";
