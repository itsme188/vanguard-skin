import type Database from "better-sqlite3";
import type { TradeReview, TradeRoundtrip } from "@/lib/types";

export interface TradeReviewWithAccount extends TradeReview {
  account_name: string;
}

export interface PriorReviewSummary {
  periodStart: string;
  periodEnd: string;
  totalTrades: number;
  winRate: number;
  totalRealizedPnl: number;
  avgHoldingDays: number | null;
  profitFactor: number | null;
  reviewMarkdown: string;
  cumulativePatterns: string | null;
}

export function getTradeReviews(
  db: Database.Database,
  accountId: number,
  year?: number
): TradeReviewWithAccount[] {
  const conditions = ["tr.account_id = ?"];
  const params: (number | string)[] = [accountId];

  if (year) {
    conditions.push("tr.period_start >= ? AND tr.period_start <= ?");
    params.push(`${year}-01-01`, `${year}-12-31`);
  }

  return db
    .prepare(
      `SELECT tr.*, a.name AS account_name
       FROM trade_reviews tr
       JOIN accounts a ON a.id = tr.account_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY tr.period_start DESC`
    )
    .all(...params) as TradeReviewWithAccount[];
}

export function getTradeReviewById(
  db: Database.Database,
  reviewId: number
): TradeReviewWithAccount | null {
  return (
    (db
      .prepare(
        `SELECT tr.*, a.name AS account_name
         FROM trade_reviews tr
         JOIN accounts a ON a.id = tr.account_id
         WHERE tr.id = ?`
      )
      .get(reviewId) as TradeReviewWithAccount) ?? null
  );
}

export function getTradeReviewByPeriod(
  db: Database.Database,
  accountId: number,
  periodStart: string
): TradeReviewWithAccount | null {
  return (
    (db
      .prepare(
        `SELECT tr.*, a.name AS account_name
         FROM trade_reviews tr
         JOIN accounts a ON a.id = tr.account_id
         WHERE tr.account_id = ? AND tr.period_start = ?`
      )
      .get(accountId, periodStart) as TradeReviewWithAccount) ?? null
  );
}

/**
 * `is_synthetic_close` is derived at READ time (via the stored
 * `sale_transaction_id`) rather than persisted on `trade_roundtrips` —
 * the transaction's `type` is the single source of truth, and re-deriving
 * here means a row's synthetic status can never drift from the current
 * ledger state, unlike a copy frozen at review-generation time. NULL when
 * `sale_transaction_id` is null (legacy rows predating that column) or the
 * transaction was deleted; both read as "not synthetic".
 */
export function getTradeRoundtrips(
  db: Database.Database,
  reviewId: number
): (TradeRoundtrip & { security_type: string | null; is_synthetic_close: boolean })[] {
  const rows = db
    .prepare(
      `SELECT trt.*, s.security_type,
              (t.type = 'RECONCILE_CLOSE') AS is_synthetic_close
       FROM trade_roundtrips trt
       LEFT JOIN securities s ON s.id = trt.security_id
       LEFT JOIN transactions t ON t.id = trt.sale_transaction_id
       WHERE trt.review_id = ?
       ORDER BY trt.exit_date, trt.symbol`
    )
    .all(reviewId) as Array<
    TradeRoundtrip & { security_type: string | null; is_synthetic_close: number | null }
  >;
  return rows.map((r) => ({ ...r, is_synthetic_close: Boolean(r.is_synthetic_close) }));
}

/**
 * Get condensed summaries of prior reviews for cumulative pattern analysis.
 * Returns most recent N reviews before the given period.
 */
export function getPriorReviewSummaries(
  db: Database.Database,
  accountId: number,
  beforePeriod: string,
  limit: number = 6
): PriorReviewSummary[] {
  const rows = db
    .prepare(
      `SELECT
        period_start, period_end,
        total_trades, win_rate, total_realized_pnl,
        avg_holding_days, profit_factor,
        review_markdown, cumulative_patterns
       FROM trade_reviews
       WHERE account_id = ? AND period_start < ?
       ORDER BY period_start DESC
       LIMIT ?`
    )
    .all(accountId, beforePeriod, limit) as Array<{
    period_start: string;
    period_end: string;
    total_trades: number;
    win_rate: number;
    total_realized_pnl: number;
    avg_holding_days: number | null;
    profit_factor: number | null;
    review_markdown: string;
    cumulative_patterns: string | null;
  }>;

  return rows.map((r) => ({
    periodStart: r.period_start,
    periodEnd: r.period_end,
    totalTrades: r.total_trades,
    winRate: r.win_rate,
    totalRealizedPnl: r.total_realized_pnl,
    avgHoldingDays: r.avg_holding_days,
    profitFactor: r.profit_factor,
    reviewMarkdown: r.review_markdown,
    cumulativePatterns: r.cumulative_patterns,
  }));
}
