import type Database from "better-sqlite3";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

export interface PerAccountReconciliation {
  accountId: number;
  accountName: string;
  latestStmtMonth: string | null;
  divergenceBp: number | null;
  withinTolerance: boolean | null; // null = not yet reconcilable (no statement or computeTwr returned null)
}

export interface AnalysisTrustState {
  factorCoverage: {
    totalNames: number;
    classified: number;
    percentage: number;
    missingSymbols: string[];
  };
  lastClassification: string | null;
  performanceReconciledThru: string | null; // populated by Slice D
  perAccountReconciliation: PerAccountReconciliation[];
  stalePrices: { count: number; symbols: string[] };
  bondDuration: { totalBonds: number; withDuration: number };
}

const STALE_PRICE_DAYS = 4;

export function getAnalysisTrustState(
  db: Database.Database,
  accountIds?: number[]
): AnalysisTrustState {
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

  // ── Factor coverage ──────────────────────────────────────────────────
  const factorRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT CASE WHEN sf.security_id IS NOT NULL OR sf_u.security_id IS NOT NULL THEN s.id END) AS classified,
      GROUP_CONCAT(CASE WHEN sf.security_id IS NULL AND sf_u.security_id IS NULL THEN s.symbol END) AS missing
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    LEFT JOIN security_factors sf ON sf.security_id = s.id
    -- Options inherit factors from their underlying at query time (same rule
    -- as getFactorHeatmap / getFactorCoverage in lib/queries/analysis.ts) —
    -- count them as classified when the underlying has a factor row, or this
    -- metric contradicts the heatmap it sits above.
    LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
    LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
  `
    )
    .get(...params) as { total: number; classified: number; missing: string | null };

  const total = factorRow.total ?? 0;
  const classified = factorRow.classified ?? 0;
  const missingSymbols = factorRow.missing
    ? factorRow.missing.split(",").filter(Boolean)
    : [];
  const percentage = total > 0 ? classified / total : 0;

  // ── Last classification ──────────────────────────────────────────────
  const lastClassRow = db
    .prepare(`SELECT MAX(updated_at) AS last FROM security_factors`)
    .get() as { last: string | null };

  // ── Stale prices ─────────────────────────────────────────────────────
  // Param order: accountIds first (in CTE), STALE_PRICE_DAYS last (outer WHERE)
  const staleRows = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    ),
    latest_prices AS (
      SELECT p.security_id, MAX(p.date) AS latest_date
      FROM prices p
      JOIN latest l ON l.security_id = p.security_id
      GROUP BY p.security_id
    )
    SELECT s.symbol
    FROM latest_prices lp
    JOIN securities s ON s.id = lp.security_id
    WHERE julianday('now') - julianday(lp.latest_date) > ?
    ORDER BY s.symbol
  `
    )
    .all(...params, STALE_PRICE_DAYS) as { symbol: string }[];

  // ── Bond duration coverage ───────────────────────────────────────────
  const bondRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(s.id) AS total_bonds,
      COUNT(s.duration_years) AS with_duration
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    WHERE LOWER(s.security_type) = 'bond'
  `
    )
    .get(...params) as { total_bonds: number; with_duration: number };

  // ── Performance reconciliation ───────────────────────────────────────
  // Semantic for the rollup field `performanceReconciledThru`: "all accounts agree
  // with statements at least through this month." Take the EARLIEST of each
  // account's most-recent reconciled month — anything past that, at least one
  // account is unreconciled. Per-account detail flows out via `perAccountReconciliation`.
  const accountList = accountIds?.length
    ? (db
        .prepare(
          `SELECT id, name FROM accounts WHERE id IN (${accountIds.map(() => "?").join(",")})`,
        )
        .all(...accountIds) as { id: number; name: string }[])
    : (db.prepare("SELECT id, name FROM accounts").all() as {
        id: number;
        name: string;
      }[]);

  const perAccount: PerAccountReconciliation[] = [];
  let allWithinTolerance = true;
  let earliestReconciledMonth: string | null = null;

  for (const acct of accountList) {
    const latestStmt = db
      .prepare(
        `
      SELECT month_end_date FROM monthly_snapshots
      WHERE account_id = ? AND source IN ('ibkr-activity', 'canonical', 'vanguard-pdf')
        AND twr IS NOT NULL
      ORDER BY month_end_date DESC LIMIT 1
    `,
      )
      .get(acct.id) as { month_end_date: string } | undefined;

    if (!latestStmt) {
      // Account has no statement TWR to reconcile against. New/TWS-only accounts
      // force the rollup to null until a statement import populates a TWR row.
      perAccount.push({
        accountId: acct.id,
        accountName: acct.name,
        latestStmtMonth: null,
        divergenceBp: null,
        withinTolerance: null,
      });
      allWithinTolerance = false;
      continue;
    }

    const r = reconcileTwrAgainstStatements(db, acct.id, latestStmt.month_end_date);
    perAccount.push({
      accountId: acct.id,
      accountName: acct.name,
      latestStmtMonth: latestStmt.month_end_date,
      divergenceBp: r ? r.divergenceBp : null,
      withinTolerance: r ? r.withinTolerance : null,
    });

    if (r?.withinTolerance) {
      if (
        !earliestReconciledMonth ||
        latestStmt.month_end_date < earliestReconciledMonth
      ) {
        earliestReconciledMonth = latestStmt.month_end_date;
      }
    } else {
      // Reconciliation returned null (unresolvable — e.g. single snapshot,
      // no prior-month V_start) OR is out of tolerance.
      allWithinTolerance = false;
    }
  }

  return {
    factorCoverage: { totalNames: total, classified, percentage, missingSymbols },
    lastClassification: lastClassRow.last,
    performanceReconciledThru: allWithinTolerance ? earliestReconciledMonth : null,
    perAccountReconciliation: perAccount,
    stalePrices: {
      count: staleRows.length,
      symbols: staleRows.map((r) => r.symbol),
    },
    bondDuration: {
      totalBonds: bondRow.total_bonds,
      withDuration: bondRow.with_duration,
    },
  };
}
