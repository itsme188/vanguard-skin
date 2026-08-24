/**
 * Cost Basis Reconciliation — compares broker-reported cost basis
 * (from holdings imports) against computed cost basis (from tax lots).
 *
 * Surfaces discrepancies for tax accuracy verification.
 */

import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getTaxConventionState } from "@/lib/compute/tax-convention";

// ─── Types ──────────────────────────────────────────────────────

export interface ReconciliationRow {
  accountId: number;
  accountName: string;
  securityId: number;
  symbol: string;
  securityName: string | null;
  securityType: string | null;
  /** Quantity from latest holdings snapshot */
  holdingsQuantity: number;
  /** Quantity remaining in open tax lots */
  computedQuantity: number;
  quantityDiff: number;
  /** Cost basis from broker (holdings table) — null if not imported */
  brokerCostBasis: number | null;
  /** Cost basis from tax lot computation */
  computedCostBasis: number;
  /** Absolute difference */
  costBasisDiff: number | null;
  /** Percentage variance (null if broker cost basis missing) */
  variancePct: number | null;
  /** True if difference exceeds threshold */
  flagged: boolean;
  /** Reason for flagging */
  flagReason: string | null;
  /** Date of the holdings snapshot */
  holdingsAsOf: string;
}

export interface ReconciliationSummary {
  totalPositions: number;
  positionsWithBrokerBasis: number;
  positionsWithoutBrokerBasis: number;
  positionsMatching: number; // within threshold
  positionsFlagged: number;
  totalBrokerCostBasis: number;
  totalComputedCostBasis: number;
  totalDifference: number;
  rows: ReconciliationRow[];
  /** True when the tax-input generation has moved past the last
   *  computeTaxLots recompute (Task 1's getTaxConventionState) — the
   *  computed dollars below may still reflect a stale mutation. */
  conventionPending: boolean;
}

export interface ReconciliationOptions {
  accountId?: number;
  /** Absolute dollar threshold for flagging (default $100) */
  dollarThreshold?: number;
  /** Percentage threshold for flagging (default 1%) */
  percentThreshold?: number;
}

// ─── Main Function ──────────────────────────────────────────────

export function reconcileCostBasis(
  db: Database.Database,
  options: ReconciliationOptions = {}
): ReconciliationSummary {
  const dollarThreshold = options.dollarThreshold ?? 100;
  const percentThreshold = options.percentThreshold ?? 1;

  const accountFilter = options.accountId ? "AND h.account_id = ?" : "";
  const params: number[] = [];
  if (options.accountId) params.push(options.accountId);

  // Get current holdings with broker cost basis
  // Per-(account, security) latest date (default keyBy) — a position whose
  // own latest row predates the account's overall newest snapshot must still
  // appear, or it silently vanishes from the reconciliation report (same
  // latent bug fixed for scenarios.ts in PR #46 / commit ae2b4f5).
  const holdings = db
    .prepare(
      `SELECT
        h.account_id,
        a.name AS account_name,
        h.security_id,
        s.symbol,
        s.name AS security_name,
        s.security_type,
        h.quantity,
        h.cost_basis * COALESCE(fx.usd_per_unit, 1) AS broker_cost_basis,
        h.as_of_date
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter })}
         AND LOWER(s.security_type) NOT IN ('mutual fund', 'money market', 'fund', 'money_market')
       ORDER BY a.name, s.symbol`
    )
    .all(...params) as Array<{
    account_id: number;
    account_name: string;
    security_id: number;
    symbol: string;
    security_name: string | null;
    security_type: string | null;
    quantity: number;
    broker_cost_basis: number | null;
    as_of_date: string;
  }>;

  // Get computed cost basis from open tax lots (grouped by account+security)
  // When accountId is provided, only fetch lots for that account
  const lotAccountFilter = options.accountId ? "AND account_id = ?" : "";
  const lotParams: number[] = [];
  if (options.accountId) lotParams.push(options.accountId);

  // Both sides of the reconciliation carry the FX factor so a foreign name
  // compares USD-vs-USD (converting only one side would fake a divergence).
  // tl.cost_basis is the v2 TRUE-DOLLAR total for the lot's ORIGINAL
  // quantity_acquired (bond ÷100, option ×multiplier, fees included) — the
  // still-open share is dollar-proportional, so scaling by
  // quantity_remaining/quantity_acquired yields the correct open-position
  // cost basis without re-deriving the per-unit convention by hand.
  const computedLots = db
    .prepare(
      `SELECT
        tl.account_id,
        tl.security_id,
        SUM(tl.quantity_remaining) AS total_quantity,
        SUM(tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired) * COALESCE(fx.usd_per_unit, 1) AS total_cost_basis
       FROM tax_lots tl
       JOIN securities s ON s.id = tl.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE tl.quantity_remaining > 0
         AND tl.quantity_acquired != 0
         ${lotAccountFilter}
       GROUP BY tl.account_id, tl.security_id`
    )
    .all(...lotParams) as Array<{
    account_id: number;
    security_id: number;
    total_quantity: number;
    total_cost_basis: number;
  }>;

  // Index computed lots for lookup
  const computedMap = new Map<string, { quantity: number; costBasis: number }>();
  for (const lot of computedLots) {
    computedMap.set(`${lot.account_id}-${lot.security_id}`, {
      quantity: lot.total_quantity,
      costBasis: lot.total_cost_basis,
    });
  }

  const rows: ReconciliationRow[] = [];

  for (const h of holdings) {
    const key = `${h.account_id}-${h.security_id}`;
    const computed = computedMap.get(key) ?? { quantity: 0, costBasis: 0 };

    const quantityDiff = Math.abs(h.quantity) - computed.quantity;
    const costBasisDiff =
      h.broker_cost_basis != null
        ? h.broker_cost_basis - computed.costBasis
        : null;
    const variancePct =
      h.broker_cost_basis != null && h.broker_cost_basis !== 0
        ? (costBasisDiff! / h.broker_cost_basis) * 100
        : null;

    // Determine flag status
    let flagged = false;
    let flagReason: string | null = null;

    if (h.broker_cost_basis == null) {
      flagged = true;
      flagReason = "No broker cost basis imported";
    } else if (Math.abs(quantityDiff) > 0.01) {
      flagged = true;
      flagReason = `Quantity mismatch: holdings ${h.quantity} vs lots ${computed.quantity}`;
    } else if (
      Math.abs(costBasisDiff!) > dollarThreshold &&
      Math.abs(variancePct!) > percentThreshold
    ) {
      flagged = true;
      flagReason = `Cost basis variance: $${costBasisDiff!.toFixed(0)} (${variancePct!.toFixed(1)}%)`;
    }

    rows.push({
      accountId: h.account_id,
      accountName: h.account_name,
      securityId: h.security_id,
      symbol: h.symbol,
      securityName: h.security_name,
      securityType: h.security_type,
      holdingsQuantity: h.quantity,
      computedQuantity: computed.quantity,
      quantityDiff,
      brokerCostBasis: h.broker_cost_basis,
      computedCostBasis: computed.costBasis,
      costBasisDiff,
      variancePct,
      flagged,
      flagReason,
      holdingsAsOf: h.as_of_date,
    });
  }

  const withBasis = rows.filter((r) => r.brokerCostBasis != null);
  const matching = withBasis.filter((r) => !r.flagged);
  const conventionPending = !getTaxConventionState(db).recomputeCurrent;

  return {
    totalPositions: rows.length,
    positionsWithBrokerBasis: withBasis.length,
    positionsWithoutBrokerBasis: rows.length - withBasis.length,
    positionsMatching: matching.length,
    positionsFlagged: rows.filter((r) => r.flagged).length,
    totalBrokerCostBasis: withBasis.reduce(
      (sum, r) => sum + (r.brokerCostBasis ?? 0),
      0
    ),
    totalComputedCostBasis: rows.reduce((sum, r) => sum + r.computedCostBasis, 0),
    totalDifference: withBasis.reduce(
      (sum, r) => sum + Math.abs(r.costBasisDiff ?? 0),
      0
    ),
    rows,
    conventionPending,
  };
}
