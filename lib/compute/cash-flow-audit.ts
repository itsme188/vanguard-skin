import type Database from "better-sqlite3";

/**
 * Shared unexplained-cash-flow audit — the single source of truth for
 * "did this account's cash_balance jump without a matching transaction?"
 * Used by BOTH scripts/repair-missing-external-flows.ts (propose synthetic
 * DEPOSIT/WITHDRAWAL rows for the user to review) and
 * lib/queries/data-confidence.ts (degrade the cashAccuracy dimension when a
 * large unexplained delta sits in the risk-metrics window). Both MUST share
 * this one computation so they can never disagree about what "unexplained"
 * means (QA finding: analysis-risk-decomposition--vol-drawdown-sharpe-
 * count-cash-flows-as-returns, 2026-08-12).
 *
 * ── Why this exists ─────────────────────────────────────────────────
 * lib/compute/flow-adjusted.ts's buildFlowAdjustedIndex strips external
 * flows (is_external_flow=1 transactions) out of the daily return series so
 * a deposit/withdrawal doesn't read as a fake market move. That's correct
 * IF every real external flow has a transaction row. It doesn't: a
 * read-only audit of the live ledger found daily_valuations.cash_balance
 * jumping by six figures on dates with ZERO transactions (2026-07-11
 * Vanguard Taxable, next-nearest transaction dates 07-02 and 07-17). With no flow row to net against, that jump reads as a real
 * one-day return and inflates volatility/drawdown/Sharpe (and the AI prose
 * built on top of them).
 *
 * ── Why cash_balance isn't a simple ledger roll-forward ─────────────
 * lib/compute/daily-valuation.ts computes cash_balance as a RESIDUAL PLUG:
 * `monthly_snapshots.total_value − our own computed holdings_value`, held
 * FLAT between anchor snapshots ("cash_balance is therefore a residual on
 * broker-anchored days, not literal cash" — daily-valuation.ts). So within
 * a flat-anchor window, cash_balance never moves regardless of real trading
 * that day (delta = 0 always) — no return-series contamination there. The
 * contamination happens specifically at ANCHOR-TRANSITION points, where
 * cash_balance jumps to reconcile the new anchor. This audit therefore
 * walks consecutive daily_valuations pairs (never a fixed calendar step —
 * weekends/holidays/gaps mean "previous day" is "previous valuation row")
 * and aggregates ALL transactions landing in (prevDate, currDate] against
 * that pair's delta.
 *
 * ── external-flow-candidate vs. internal-shift (2026-08-12 refinement) ──
 * A large, unexplained CASH residual is not automatically a fake return
 * day: risk metrics run on total_value, not cash_balance alone. A
 * read-only follow-up audit found two of the four original candidates
 * (2026-07-13→07-14 and the 2026-07-30→07-31 / 08-02→08-03 round trip)
 * have a cash residual in the six figures while total_value moved smoothly
 * (well under 1% and ~1.7% respectively) — the SPLIT between cash_balance
 * and holdings_value jumped, not the total. Root cause CONFIRMED and FIXED
 * 2026-08-12 (cash-split normalization in lib/compute/daily-valuation.ts,
 * 6c1e34d): the money-market sweep WAS counted as a holding on
 * statement-anchored days and folded into cash on Plaid days, flipping the
 * split at every anchor handoff — the 07-31/08-03 "round trip" was exactly
 * that flip. With the engine normalized (sweep = cash everywhere,
 * statement bonds carried into Plaid days) internal-shift days like these
 * should no longer surface as candidates. Inserting a synthetic flow for
 * a day like this would be actively harmful: total_value already reads
 * correctly for return purposes, so subtracting a flow from it would
 * CREATE a fake flow-adjusted return day (and corrupt TWR/XIRR, which also
 * consume is_external_flow rows) where none existed before.
 *
 * 2026-07-11 is different: total_value itself jumped materially — a real fake-return day regardless of how the cash/holdings
 * split moved underneath it. `classifyCashFlowResidual` distinguishes the
 * two by checking whether the total_value move CORROBORATES the cash
 * residual (same sign, at least half its magnitude) — see that function's
 * doc for the exact rule.
 */

// ── Per-type signed cash direction ──────────────────────────────────

/**
 * Per-type signed cash contribution, normalized to the REAL cash direction
 * — not simply the raw stored `amount` sign. Two findings from the live
 * ledger forced this:
 *
 * 1. BUY/BUY_TO_OPEN/BUY_TO_CLOSE/BUY_TO_COVER flip sign by import era: the
 *    "canonical" backfill (pre-2026-04) stored a POSITIVE cost magnitude;
 *    later imports store the correct negative cash-outflow convention.
 *    Trusting the raw sign double-counts roughly half this account's
 *    purchase history in the wrong direction. BUY-family and SELL-family
 *    (incl. SHORT_SELL) types are forced to their definitional direction
 *    via ABS(amount) — never the stored sign.
 * 2. REINVESTMENT always stores the GROSS reinvested amount as a positive
 *    magnitude mirroring the paired DIVIDEND row (net of any same-day
 *    TAX_WITHHELD) — it IS a purchase, not an inflow. Left alone it double-
 *    counts every dividend as +2x cash. Forced to -ABS(amount) so a
 *    DIVIDEND+REINVESTMENT pair nets to zero, matching reality: a
 *    reinvested payout never touches settlement cash.
 *
 * DIVIDEND/INTEREST/FEE/COMMISSION/TAX_WITHHELD/TRANSFER/DEPOSIT/
 * WITHDRAWAL/REDEMPTION/RETURN_OF_CAPITAL trust the stored sign — these can
 * legitimately go either way (margin interest charged vs. earned, a fee
 * credit vs. a charge, sweep-in vs. sweep-out) and showed no era-based flip
 * in the audit.
 *
 * Excluded entirely (contribute 0):
 *   TRANSFER_IN, TRANSFER_OUT — security transfers valued at the
 *     transfer-date market price, not a cash movement (see
 *     flow-adjusted.ts's SIGNED_EXTERNAL_FLOW_SQL comment).
 *   RECONCILE_CLOSE — engine-owned synthetic row; CLAUDE.md invariant:
 *     "never parse, emit, or treat it as user activity."
 *   CORPORATE_ACTION, SPINOFF, MERGER, SPLIT, EXCHANGE, EXERCISED,
 *     ASSIGNED, EXPIRED — security-count/price events; any real cash effect
 *     (e.g. an exercise's strike payment) posts through its own linked
 *     BUY/SELL row (lib/compute/tax-lots.ts's premium-adjustment pass), so
 *     counting these too would double it.
 *   Any other/future type — defaults to 0 rather than guessing.
 */
export const CASH_AFFECTING_SIGNED_SQL = `
  CASE UPPER(type)
    WHEN 'BUY' THEN -ABS(COALESCE(amount, 0))
    WHEN 'BUY_TO_OPEN' THEN -ABS(COALESCE(amount, 0))
    WHEN 'BUY_TO_CLOSE' THEN -ABS(COALESCE(amount, 0))
    WHEN 'BUY_TO_COVER' THEN -ABS(COALESCE(amount, 0))
    WHEN 'REINVESTMENT' THEN -ABS(COALESCE(amount, 0))
    WHEN 'SELL' THEN ABS(COALESCE(amount, 0))
    WHEN 'SELL_TO_CLOSE' THEN ABS(COALESCE(amount, 0))
    WHEN 'SELL_TO_OPEN' THEN ABS(COALESCE(amount, 0))
    WHEN 'SHORT_SELL' THEN ABS(COALESCE(amount, 0))
    WHEN 'DIVIDEND' THEN COALESCE(amount, 0)
    WHEN 'INTEREST' THEN COALESCE(amount, 0)
    WHEN 'FEE' THEN COALESCE(amount, 0)
    WHEN 'COMMISSION' THEN COALESCE(amount, 0)
    WHEN 'TAX_WITHHELD' THEN COALESCE(amount, 0)
    WHEN 'TRANSFER' THEN COALESCE(amount, 0)
    WHEN 'DEPOSIT' THEN COALESCE(amount, 0)
    WHEN 'WITHDRAWAL' THEN COALESCE(amount, 0)
    WHEN 'REDEMPTION' THEN COALESCE(amount, 0)
    WHEN 'RETURN_OF_CAPITAL' THEN COALESCE(amount, 0)
    ELSE 0
  END
`;

// ── Types ────────────────────────────────────────────────────────────

export type CashFlowClassification = "external-flow-candidate" | "internal-shift";

export interface CashFlowResidualPoint {
  accountId: number;
  accountName: string;
  /** Prior valuation_date (exclusive lower bound of the transaction window). */
  fromDate: string;
  /** This valuation_date (inclusive upper bound) — the date the jump lands. */
  toDate: string;
  cashBefore: number;
  cashAfter: number;
  totalValueAtFrom: number;
  totalValueAtTo: number;
  /** cashAfter - cashBefore */
  delta: number;
  /** Sum of cash-affecting transaction amounts in (fromDate, toDate]. */
  explained: number;
  /** delta - explained. What a repair transaction's amount would be. */
  residual: number;
  /** totalValueAtTo - totalValueAtFrom — did the ACCOUNT's total value move,
   *  or just the cash/holdings split underneath it? */
  totalDelta: number;
  /** totalDelta as a fraction of totalValueAtTo (0 when totalValueAtTo is 0). */
  totalDeltaPct: number;
  /** See classifyCashFlowResidual — whether totalDelta corroborates the
   *  cash residual (a real account-value jump, i.e. a fake return day) or
   *  the residual is just cash/holdings being reclassified internally. */
  classification: CashFlowClassification;
}

interface ValuationRow {
  valuation_date: string;
  cash_balance: number;
  total_value: number;
}

interface DailyTxnRow {
  trade_date: string;
  signed: number;
}

// ── Classification: does total_value corroborate the cash residual? ──

/**
 * A cash residual is "corroborated" by the total-value move (i.e. a real
 * external-flow-shaped event, not an internal cash/holdings reclassifying)
 * when total_value moved AT LEAST HALF as much as the cash residual, in the
 * SAME direction. Half, not all — a deposit that's partly invested the same
 * day still shows up as mostly-cash with a smaller total_value bump than
 * the deposit itself (some of the "value" was already there, just
 * reshuffled from cash to a position); requiring an exact match would
 * reject genuine flows. An internal cash↔holdings reclassification, by
 * contrast, leaves total_value nearly flat (the empirical cases were
 * <1% and ~1.7% against six-figure cash residuals) — nowhere near half.
 */
export const CORROBORATION_RATIO = 0.5;

export function classifyCashFlowResidual(
  residual: number,
  totalDelta: number
): CashFlowClassification {
  const corroborated =
    Math.abs(totalDelta) >= CORROBORATION_RATIO * Math.abs(residual) &&
    Math.sign(totalDelta) === Math.sign(residual);
  return corroborated ? "external-flow-candidate" : "internal-shift";
}

// ── Core computation ─────────────────────────────────────────────────

/**
 * Walks daily_valuations (ordered by date) for the given accounts (or every
 * account, if omitted) and returns one CashFlowResidualPoint per consecutive
 * pair. Pure data — no thresholding. Callers apply their own bar via
 * `isUnexplainedCashFlow`.
 */
export function computeCashFlowResiduals(
  db: Database.Database,
  opts?: { accountIds?: number[] }
): CashFlowResidualPoint[] {
  // Gracefully returns [] when daily_valuations/transactions don't exist —
  // same precedent as fetchNetFlowsByDate's settings guard (minimal
  // in-memory test DBs, e.g. some data-confidence.ts test fixtures).
  const hasRequiredTables = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('daily_valuations', 'transactions')`
    )
    .get() as { n: number };
  if (hasRequiredTables.n < 2) return [];

  const accountIds = opts?.accountIds;
  const accountFilter = accountIds && accountIds.length > 0
    ? ` WHERE id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const accounts = db
    .prepare(`SELECT id, name FROM accounts${accountFilter} ORDER BY id`)
    .all(...(accountIds ?? [])) as { id: number; name: string }[];

  const valuationsStmt = db.prepare(
    `SELECT valuation_date, cash_balance, total_value
     FROM daily_valuations
     WHERE account_id = ?
     ORDER BY valuation_date ASC`
  );
  const txnsStmt = db.prepare(
    `SELECT trade_date, SUM(${CASH_AFFECTING_SIGNED_SQL}) AS signed
     FROM transactions
     WHERE account_id = ?
     GROUP BY trade_date
     ORDER BY trade_date ASC`
  );

  const points: CashFlowResidualPoint[] = [];

  for (const account of accounts) {
    const valuations = valuationsStmt.all(account.id) as ValuationRow[];
    if (valuations.length < 2) continue;
    const txns = txnsStmt.all(account.id) as DailyTxnRow[];

    let ti = 0;
    // Transactions on/before the first valuation date are already baked
    // into the starting cash figure — same convention as
    // fetchNetFlowsByDate (lib/compute/flow-adjusted.ts).
    while (ti < txns.length && txns[ti].trade_date <= valuations[0].valuation_date) ti++;

    for (let i = 1; i < valuations.length; i++) {
      const prev = valuations[i - 1];
      const curr = valuations[i];

      let explained = 0;
      while (ti < txns.length && txns[ti].trade_date <= curr.valuation_date) {
        explained += txns[ti].signed;
        ti++;
      }

      const delta = curr.cash_balance - prev.cash_balance;
      const residual = delta - explained;
      const totalDelta = curr.total_value - prev.total_value;
      const totalDeltaPct = curr.total_value !== 0 ? totalDelta / curr.total_value : 0;

      points.push({
        accountId: account.id,
        accountName: account.name,
        fromDate: prev.valuation_date,
        toDate: curr.valuation_date,
        cashBefore: prev.cash_balance,
        cashAfter: curr.cash_balance,
        totalValueAtFrom: prev.total_value,
        totalValueAtTo: curr.total_value,
        delta,
        explained,
        residual,
        totalDelta,
        totalDeltaPct,
        classification: classifyCashFlowResidual(residual, totalDelta),
      });
    }
  }

  return points;
}

// ── Thresholds ───────────────────────────────────────────────────────

/**
 * Empirically calibrated against the live ledger (2026-08-12 read-only
 * audit) rather than left at the task's illustrative $1,000/0.5%, which
 * flagged 13-16 candidates per Vanguard account — mostly ordinary
 * day-to-day noise from the daily Plaid cash-residual anchor (live since
 * 2026-07-11), not missing transactions:
 *   - Roth IRA (no daily trading): residual noise tops out ~3.2% of
 *     account value on days with zero transactions — indistinguishable
 *     from a "missing flow" by the explained-only signal alone.
 *   - Vanguard Taxable (active trading): noise on days with zero/near-zero
 *     explained activity tops out ~1.7%.
 *   - The target bug (2026-07-11 Vanguard Taxable): >10% of account
 *     value, zero transactions that date.
 * A 5%-of-account-value relative floor sits 4-7x above both noise ceilings
 * and well below the target signal.
 */
export const DEFAULT_RESIDUAL_ABS_FLOOR = 5_000; // dollars
export const DEFAULT_RESIDUAL_REL_FLOOR = 0.05; // 5% of that day's total account value
/** "explained" must be at/below this to count as "(near) zero transactions
 *  that date" — the literal bug signature. Without this gate, a day with a
 *  real, mostly-explained deposit (e.g. 2026-07-17: $200k DEPOSIT plus
 *  heavy same-day trading) can still show a large residual purely because
 *  this module's simplified per-type cash model doesn't net broker
 *  sweep/settlement bookkeeping exactly — flagging it would propose a
 *  bogus second flow on top of a day that's already explained. */
export const DEFAULT_EXPLAINED_NEGLIGIBLE_FLOOR = 2_000; // dollars

/** More sensitive bar for the data-confidence dimension — an early warning
 *  ("this looks off"), not a "propose a fix" bar. Task-specified 2% of
 *  account value. */
export const CONFIDENCE_RESIDUAL_REL_FLOOR = 0.02;
export const CONFIDENCE_RESIDUAL_ABS_FLOOR = 1_000;

export interface UnexplainedCashFlowFloors {
  absFloor?: number;
  relFloor?: number;
  explainedNegligibleFloor?: number;
}

/**
 * True when `point` looks like a genuine unexplained external cash flow —
 * not settlement noise. Two gates, both required:
 *
 * 1. `explained` (recorded ledger activity in the window) is itself
 *    negligible — the literal bug signature ("zero transactions that
 *    date").
 * 2. `residual` clears BOTH an absolute and a relative floor — the
 *    relative gate matters for small accounts, the absolute gate matters
 *    so a big swing in a small account isn't swamped by a tiny relative
 *    floor.
 */
export function isUnexplainedCashFlow(
  point: CashFlowResidualPoint,
  floors: UnexplainedCashFlowFloors = {}
): boolean {
  const absFloor = floors.absFloor ?? DEFAULT_RESIDUAL_ABS_FLOOR;
  const relFloor = floors.relFloor ?? DEFAULT_RESIDUAL_REL_FLOOR;
  const negligibleFloor = floors.explainedNegligibleFloor ?? DEFAULT_EXPLAINED_NEGLIGIBLE_FLOOR;

  if (Math.abs(point.explained) > negligibleFloor) return false;

  const absResidual = Math.abs(point.residual);
  if (absResidual <= absFloor) return false;

  const relBasis = Math.abs(point.totalValueAtTo);
  if (relBasis <= 0) return true;
  return absResidual > relBasis * relFloor;
}

/**
 * Splits a flagged-candidate list by classification. Only
 * `externalFlowCandidates` should ever get a proposed INSERT — see
 * classifyCashFlowResidual's doc for why inserting a flow for an
 * `internalShifts` entry would create a fake return day instead of fixing
 * one.
 */
export function partitionCandidates(points: CashFlowResidualPoint[]): {
  externalFlowCandidates: CashFlowResidualPoint[];
  internalShifts: CashFlowResidualPoint[];
} {
  return {
    externalFlowCandidates: points.filter((p) => p.classification === "external-flow-candidate"),
    internalShifts: points.filter((p) => p.classification === "internal-shift"),
  };
}

// ── Account scoping ──────────────────────────────────────────────────

/**
 * IBKR trades daily and settles very differently from a statement-fed
 * Vanguard account (margin, multi-leg options, frequent same-day sweeps) —
 * the same per-type cash model produces 10x the candidate volume there,
 * including at least one clear data-entry outlier (a single day's
 * "explained" off by ~$16M). Callers exclude IBKR-named accounts rather
 * than trying to find a bar high enough to be safe for both account styles.
 * Same heuristic as lib/queries/data-confidence.ts's scoreHoldingsRecency.
 */
export function isLikelyIbkrAccountName(name: string): boolean {
  return name.toLowerCase().includes("ibkr");
}
