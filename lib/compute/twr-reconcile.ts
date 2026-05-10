import type Database from "better-sqlite3";
import { computeTwr } from "./twr";

export interface ReconciliationResult {
  computedTwr: number;
  statementTwr: number;
  divergenceBp: number;
  withinTolerance: boolean;
  source: string;
  periodEnd: string;
}

export interface ReconcileOptions {
  toleranceBp?: number; // default 5
}

export function reconcileTwrAgainstStatements(
  db: Database.Database,
  accountId: number,
  periodEnd: string,
  options?: ReconcileOptions,
): ReconciliationResult | null {
  const toleranceBp = options?.toleranceBp ?? 5;

  // Pull statement-reported TWR — prefer ibkr-activity, fall back to canonical or vanguard-pdf
  const stmt = db
    .prepare(
      `
    SELECT twr, source FROM monthly_snapshots
    WHERE account_id = ? AND month_end_date = ?
      AND source IN ('ibkr-activity', 'canonical', 'vanguard-pdf')
      AND twr IS NOT NULL
    ORDER BY (source = 'ibkr-activity') DESC
    LIMIT 1
  `,
    )
    .get(accountId, periodEnd) as { twr: number; source: string } | undefined;

  if (!stmt) return null;

  // Compute TWR for the single month ending at periodEnd.
  // monthly_snapshots.twr stores a per-month value, NOT a cumulative figure.
  // Passing startDate = periodEnd scopes computeTwr to that month only.
  const computed = computeTwr(db, {
    accountId,
    startDate: periodEnd,
    endDate: periodEnd,
  });
  if (!computed?.perAccount?.length) return null;

  const computedTwr = computed.perAccount[0].totalReturn;

  // ibkr-activity stores TWR as percentage (e.g. 5.21 means 5.21%);
  // canonical and vanguard-pdf store as decimal (e.g. 0.0521).
  // See CLAUDE.md: "ibkr-activity source stores TWR as percentage"
  const statementTwr =
    stmt.source === "ibkr-activity" ? stmt.twr / 100 : stmt.twr;

  const divergenceBp = Math.round((computedTwr - statementTwr) * 10000);

  return {
    computedTwr,
    statementTwr,
    divergenceBp,
    withinTolerance: Math.abs(divergenceBp) <= toleranceBp,
    source: stmt.source,
    periodEnd,
  };
}
