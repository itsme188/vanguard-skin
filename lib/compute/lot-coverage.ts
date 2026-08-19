/**
 * Reconciles a security's per-account position quantity against the sum of
 * its open tax lots for that same account. Positions and lots are populated
 * by independent pipelines (statement import vs computeTaxLots), so a
 * position can silently drift from its lot coverage — e.g. a partial lot
 * backfill (150 held, only 125 in lots) or a whole account leg with no lots
 * at all. Comparison is strictly per-account: never sum quantities across
 * accounts, or an over-covered account can mask an under-covered one.
 */

const EPSILON = 1e-6;

export interface LotCoveragePositionInput {
  account_id: number;
  account_name: string;
  quantity: number;
}

export interface LotCoverageLotInput {
  account_id: number;
  quantity_remaining: number;
}

export interface LotCoverageGap {
  accountId: number;
  accountName: string;
  /** Position quantity reported for this account. */
  positionQty: number;
  /** Sum of quantity_remaining across this account's open lots (0 if none). */
  coveredQty: number;
  /**
   * positionQty - coveredQty. Positive means shares are missing lot/cost-basis
   * history; negative means lots over-cover the position (still a
   * disclosable mismatch — the two sources disagree either way).
   */
  missingQty: number;
}

/**
 * Compare each position's quantity against that same account's open-lot
 * coverage. Returns one entry per account whose position quantity and lot
 * coverage disagree by more than a small float-noise epsilon; accounts that
 * reconcile exactly are omitted. Only accounts present in `positions` are
 * considered — an account with lots but no position row is a different
 * (orphaned-lot) situation and out of scope here.
 */
export function computeLotCoverageGaps(
  positions: LotCoveragePositionInput[],
  openLots: LotCoverageLotInput[]
): LotCoverageGap[] {
  const coveredByAccount = new Map<number, number>();
  for (const lot of openLots) {
    coveredByAccount.set(
      lot.account_id,
      (coveredByAccount.get(lot.account_id) ?? 0) + lot.quantity_remaining
    );
  }

  const gaps: LotCoverageGap[] = [];
  for (const position of positions) {
    // Short legs: the position query includes shorts (negative quantity),
    // but tax_lots stores short lots with a POSITIVE quantity_remaining and
    // is_short=1 — comparing a negative position against a positive covered
    // sum produces nonsense (e.g. -3 vs +3 reads as "6 more shares in lots
    // than the position shows"). Signed coverage reconciliation for shorts
    // is out of scope here; skip and disclose nothing for these accounts.
    if (position.quantity < 0) continue;
    const coveredQty = coveredByAccount.get(position.account_id) ?? 0;
    const missingQty = position.quantity - coveredQty;
    if (Math.abs(missingQty) > EPSILON) {
      gaps.push({
        accountId: position.account_id,
        accountName: position.account_name,
        positionQty: position.quantity,
        coveredQty,
        missingQty,
      });
    }
  }
  return gaps;
}
