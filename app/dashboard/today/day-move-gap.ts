/**
 * Why the IBKR line on Today has no move to show, or shows one that leaves
 * names out. Wording only: nothing here is stored or computed from holdings.
 *
 * The move is measured on one pair of consecutive trading days (the latest
 * session and the one before it). When that pair cannot be formed, the
 * previous session's price is missing and NO name can be measured; the line
 * says that once. Counting every name as "without a prior close" would blame
 * each holding for one missing session.
 */
export type DayMoveGap = "no_session_pair" | "names_unpriced" | null;

export const NO_PRIOR_SESSION_PRICE_NOTE =
  "The previous session's price is missing, so the move cannot be measured.";

export function dayMoveGap(hasSessionPair: boolean, unpricedCount: number): DayMoveGap {
  if (!hasSessionPair) return "no_session_pair";
  return unpricedCount > 0 ? "names_unpriced" : null;
}
