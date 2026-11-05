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
  /** Absent reads as a long lot (callers that predate the side field). */
  is_short?: number | boolean | null;
  /** Absent reads as not pending. A pending lot covers no position. */
  pending_statement?: boolean;
}

export interface LotCoverageGap {
  accountId: number;
  accountName: string;
  /** Which side the position is on: a negative quantity is a short. */
  side: "long" | "short";
  /** Position quantity reported for this account, signed (negative = short). */
  positionQty: number;
  /**
   * Sum of quantity_remaining across this account's SAME-SIDE, non-pending
   * open lots (0 if none). Always a positive share count: a short lot stores
   * a positive quantity with is_short=1.
   */
  coveredQty: number;
  /**
   * |positionQty| - coveredQty, on absolute quantities for both sides.
   * Positive means shares are missing lot history (cost basis for a long,
   * short-sale proceeds for a short); negative means lots over-cover the
   * position (still a disclosable mismatch: the two sources disagree either
   * way).
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
 *
 * Coverage is SIDE-MATCHED (ruling R9 and the pending-lots ruling of
 * 2026-10-26). A short lot stores a positive quantity with is_short=1, so a
 * long position is covered only by long lots and a short position (negative
 * quantity) only by short lots, compared on absolute quantity. Counting the
 * other side would let a short lot of 10 "cover" a long position of 10. A lot
 * pending a statement or a closing entry is closed per the broker, so it
 * covers nothing on either side. A short over LONG lots therefore reads as
 * uncovered here; computeLotSignMismatches names that contradiction on its
 * own line.
 */
export function computeLotCoverageGaps(
  positions: LotCoveragePositionInput[],
  openLots: LotCoverageLotInput[]
): LotCoverageGap[] {
  const longByAccount = new Map<number, number>();
  const shortByAccount = new Map<number, number>();
  for (const lot of openLots) {
    if (lot.pending_statement) continue;
    const bucket = lot.is_short ? shortByAccount : longByAccount;
    bucket.set(lot.account_id, (bucket.get(lot.account_id) ?? 0) + lot.quantity_remaining);
  }

  const gaps: LotCoverageGap[] = [];
  for (const position of positions) {
    const side: "long" | "short" = position.quantity < 0 ? "short" : "long";
    const covered = side === "short" ? shortByAccount : longByAccount;
    const coveredQty = covered.get(position.account_id) ?? 0;
    const missingQty = Math.abs(position.quantity) - coveredQty;
    if (Math.abs(missingQty) > EPSILON) {
      gaps.push({
        accountId: position.account_id,
        accountName: position.account_name,
        side,
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
 * coverage check above only says the short has no short lots; this pair used
 * to print with no note naming the contradiction: a short position with a
 * loss, and directly below it long lots with a gain.
 * The two sources contradict each other (a sign error in a live holdings feed
 * is the usual cause); this does not say which one is right. Per account,
 * like computeLotCoverageGaps. Short lots are the expected lots under a short
 * position and are not counted.
 *
 * Long lots pending a statement or a closing entry are not counted either
 * (OPEN-1, 2026-10-26): a live short row over a long lot is how such a lot
 * becomes pending (the position flipped per live data), and its own chip
 * already explains it.
 */
export function computeLotSignMismatches(
  positions: LotCoveragePositionInput[],
  openLots: LotCoverageLotInput[]
): LotSignMismatch[] {
  const longByAccount = new Map<number, { qty: number; count: number }>();
  for (const lot of openLots) {
    if (lot.is_short) continue;
    if (lot.pending_statement) continue;
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

export interface BasisDisagreementPositionInput extends LotCoveragePositionInput {
  /** Holding cost basis (USD-converted by the page query); null/0 = unknown. */
  cost_basis: number | null;
}

export interface BasisDisagreementLotInput extends LotCoverageLotInput {
  is_short?: number | boolean | null;
  /** Remaining-lot basis (USD-converted). */
  adjusted_cost_basis: number | null;
  pending_statement?: boolean;
  expired_option?: boolean;
}

export interface BasisDisagreement {
  accountId: number;
  accountName: string;
  /** Absolute holding basis. */
  holdingBasis: number;
  /** Absolute sum of the same-side open lots' basis. */
  lotBasis: number;
  /** lotBasis - holdingBasis (positive: the ledger carries more basis). */
  difference: number;
}

/** Relative share of the holding basis below which a gap is rounding noise. */
const BASIS_TOLERANCE_RATIO = 0.005;
/** Absolute floor, in the holding's own currency. */
const BASIS_TOLERANCE_FLOOR = 1;

/**
 * Where the open lots fully cover a position's quantity, do their summed
 * basis and the holding's basis agree? The holding figure is the broker's;
 * the lots are the ledger's. This only DISCLOSES a gap; nothing is changed.
 *
 * Per (account, security), like computeLotCoverageGaps. Skipped: positions
 * with no known basis (the unknown-basis note covers them), pairs with any
 * quantity gap (the coverage note covers them), pairs with a lot pending its
 * statement or an expired option lot, and pairs where a lot has no basis.
 * Shorts: the holding stores proceeds as a negative basis while lots store a
 * positive figure, so absolute values are compared, against short lots only.
 *
 * Tolerance: the larger of 0.5% of the holding basis or 1.00 of the
 * holding's currency. Both bases arrive converted to USD, so the 1.00 floor
 * is scaled by `usdPerUnit` (1 for USD).
 */
export function computeBasisDisagreements(
  positions: BasisDisagreementPositionInput[],
  openLots: BasisDisagreementLotInput[],
  opts: { usdPerUnit?: number } = {}
): BasisDisagreement[] {
  const floor = BASIS_TOLERANCE_FLOOR * (opts.usdPerUnit ?? 1);
  const out: BasisDisagreement[] = [];
  for (const position of positions) {
    if (position.cost_basis == null || position.cost_basis === 0) continue;
    if (Math.abs(position.quantity) <= EPSILON) continue;
    const wantShort = position.quantity < 0;
    const accountLots = openLots.filter(
      (l) => l.account_id === position.account_id && Math.abs(l.quantity_remaining) > EPSILON
    );
    if (accountLots.some((l) => l.pending_statement || l.expired_option)) continue;
    const lots = accountLots.filter((l) => !!l.is_short === wantShort);
    if (lots.length === 0) continue;
    const covered = lots.reduce((s, l) => s + Math.abs(l.quantity_remaining), 0);
    if (Math.abs(Math.abs(position.quantity) - covered) > EPSILON) continue;
    if (lots.some((l) => l.adjusted_cost_basis == null)) continue;

    const holdingBasis = Math.abs(position.cost_basis);
    const lotBasis = Math.abs(lots.reduce((s, l) => s + (l.adjusted_cost_basis ?? 0), 0));
    const difference = lotBasis - holdingBasis;
    const tolerance = Math.max(holdingBasis * BASIS_TOLERANCE_RATIO, floor);
    if (Math.abs(difference) <= tolerance) continue;
    out.push({
      accountId: position.account_id,
      accountName: position.account_name,
      holdingBasis,
      lotBasis,
      difference,
    });
  }
  return out;
}
