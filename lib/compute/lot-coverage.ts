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

export interface LotSignMismatch {
  accountId: number;
  accountName: string;
  /** The position quantity as reported: negative (short). */
  positionQty: number;
  /** Sum of quantity_remaining across this account's LONG open lots. */
  longLotQty: number;
  longLotCount: number;
}

/**
 * A SHORT position sitting over LONG open lots in the same account. The
 * coverage check above skips shorts, so this pair used to print with no note:
 * a short position with a loss, and directly below it long lots with a gain.
 * The two sources contradict each other (a sign error in a live holdings feed
 * is the usual cause); this does not say which one is right. Per account,
 * like computeLotCoverageGaps. Short lots are the expected lots under a short
 * position and are not counted.
 */
export function computeLotSignMismatches(
  positions: LotCoveragePositionInput[],
  openLots: Array<LotCoverageLotInput & { is_short?: number | boolean | null }>
): LotSignMismatch[] {
  const longByAccount = new Map<number, { qty: number; count: number }>();
  for (const lot of openLots) {
    if (lot.is_short) continue;
    if (Math.abs(lot.quantity_remaining) <= EPSILON) continue;
    const entry = longByAccount.get(lot.account_id) ?? { qty: 0, count: 0 };
    entry.qty += lot.quantity_remaining;
    entry.count += 1;
    longByAccount.set(lot.account_id, entry);
  }

  const mismatches: LotSignMismatch[] = [];
  for (const position of positions) {
    if (position.quantity >= 0) continue;
    const long = longByAccount.get(position.account_id);
    if (!long) continue;
    mismatches.push({
      accountId: position.account_id,
      accountName: position.account_name,
      positionQty: position.quantity,
      longLotQty: long.qty,
      longLotCount: long.count,
    });
  }
  return mismatches;
}
