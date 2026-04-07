import type Database from "better-sqlite3";
import type { TradeReview } from "@/lib/types";
import type { RoundTrip } from "@/lib/compute/trade-roundtrips";

export interface SaveTradeReviewParams {
  accountId: number;
  periodStart: string;
  periodEnd: string;
  importBatchId?: number | null;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalRealizedPnl: number;
  avgHoldingDays: number | null;
  bestTradePnl: number | null;
  bestTradeSymbol: string | null;
  worstTradePnl: number | null;
  worstTradeSymbol: string | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  reviewMarkdown: string;
  tradeGrades: string | null;
  patternsIdentified: string | null;
  strengths: string | null;
  weaknesses: string | null;
  cumulativePatterns: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Upsert a trade review. If a review already exists for this account+period,
 * it's updated (and the ON DELETE CASCADE removes old roundtrips).
 */
export function saveTradeReview(
  db: Database.Database,
  params: SaveTradeReviewParams
): TradeReview {
  const result = db
    .prepare(
      `INSERT INTO trade_reviews (
        account_id, period_start, period_end, import_batch_id,
        total_trades, winning_trades, losing_trades, win_rate,
        total_realized_pnl, avg_holding_days,
        best_trade_pnl, best_trade_symbol,
        worst_trade_pnl, worst_trade_symbol,
        avg_win, avg_loss, profit_factor,
        review_markdown, trade_grades,
        patterns_identified, strengths, weaknesses, cumulative_patterns,
        model, prompt_tokens, completion_tokens,
        generated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        datetime('now')
      )
      ON CONFLICT(account_id, period_start) DO UPDATE SET
        period_end = excluded.period_end,
        import_batch_id = excluded.import_batch_id,
        total_trades = excluded.total_trades,
        winning_trades = excluded.winning_trades,
        losing_trades = excluded.losing_trades,
        win_rate = excluded.win_rate,
        total_realized_pnl = excluded.total_realized_pnl,
        avg_holding_days = excluded.avg_holding_days,
        best_trade_pnl = excluded.best_trade_pnl,
        best_trade_symbol = excluded.best_trade_symbol,
        worst_trade_pnl = excluded.worst_trade_pnl,
        worst_trade_symbol = excluded.worst_trade_symbol,
        avg_win = excluded.avg_win,
        avg_loss = excluded.avg_loss,
        profit_factor = excluded.profit_factor,
        review_markdown = excluded.review_markdown,
        trade_grades = excluded.trade_grades,
        patterns_identified = excluded.patterns_identified,
        strengths = excluded.strengths,
        weaknesses = excluded.weaknesses,
        cumulative_patterns = excluded.cumulative_patterns,
        model = excluded.model,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        generated_at = datetime('now')`
    )
    .run(
      params.accountId,
      params.periodStart,
      params.periodEnd,
      params.importBatchId ?? null,
      params.totalTrades,
      params.winningTrades,
      params.losingTrades,
      params.winRate,
      params.totalRealizedPnl,
      params.avgHoldingDays ?? null,
      params.bestTradePnl ?? null,
      params.bestTradeSymbol ?? null,
      params.worstTradePnl ?? null,
      params.worstTradeSymbol ?? null,
      params.avgWin ?? null,
      params.avgLoss ?? null,
      params.profitFactor ?? null,
      params.reviewMarkdown,
      params.tradeGrades ?? null,
      params.patternsIdentified ?? null,
      params.strengths ?? null,
      params.weaknesses ?? null,
      params.cumulativePatterns ?? null,
      params.model ?? null,
      params.promptTokens ?? null,
      params.completionTokens ?? null
    );

  // Fetch the upserted row
  const reviewId =
    result.changes > 0
      ? (
          db
            .prepare(
              "SELECT id FROM trade_reviews WHERE account_id = ? AND period_start = ?"
            )
            .get(params.accountId, params.periodStart) as { id: number }
        ).id
      : result.lastInsertRowid;

  return db
    .prepare("SELECT * FROM trade_reviews WHERE id = ?")
    .get(reviewId) as TradeReview;
}

export interface SaveRoundtripParams {
  reviewId: number;
  accountId: number;
  securityId: number;
  symbol: string;
  entryDate: string;
  entryPrice: number;
  entryQuantity: number;
  entryCost: number;
  exitDate: string;
  exitPrice: number;
  exitQuantity: number;
  exitProceeds: number;
  holdingDays: number;
  realizedPnl: number;
  returnPct: number;
  grade?: string | null;
  entryThesis?: string | null;
  exitAssessment?: string | null;
  whatWentWell?: string | null;
  whatWentWrong?: string | null;
}

/**
 * Save round-trips for a review. Matches AI grades by trade_number (grouped trade index).
 * Each lot in a grouped trade gets the same grade — the grade applies to the whole position exit.
 */
export function saveTradeRoundtrips(
  db: Database.Database,
  reviewId: number,
  roundTrips: RoundTrip[],
  groupedTrades?: Array<{ saleTransactionId: number; lots: RoundTrip[] }>,
  grades?: Array<{
    trade_number: number;
    symbol: string;
    exit_date: string;
    grade: string;
    assessment?: string;
    what_worked?: string;
    what_didnt?: string;
    // Legacy fields for backward compat
    entry_thesis?: string;
    exit_assessment?: string;
    what_went_well?: string;
    what_went_wrong?: string;
  }>
): number {
  // Clear existing roundtrips for this review
  db.prepare("DELETE FROM trade_roundtrips WHERE review_id = ?").run(reviewId);

  // Check if sale_transaction_id column exists (migration 021)
  const hasSaleTxCol = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('trade_roundtrips') WHERE name = 'sale_transaction_id'"
    )
    .get() as { cnt: number };

  const insertSql = hasSaleTxCol.cnt > 0
    ? `INSERT INTO trade_roundtrips (
        review_id, account_id, security_id, symbol,
        entry_date, entry_price, entry_quantity, entry_cost,
        exit_date, exit_price, exit_quantity, exit_proceeds,
        holding_days, realized_pnl, return_pct,
        grade, entry_thesis, exit_assessment, what_went_well, what_went_wrong,
        sale_transaction_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO trade_roundtrips (
        review_id, account_id, security_id, symbol,
        entry_date, entry_price, entry_quantity, entry_cost,
        exit_date, exit_price, exit_quantity, exit_proceeds,
        holding_days, realized_pnl, return_pct,
        grade, entry_thesis, exit_assessment, what_went_well, what_went_wrong
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const stmt = db.prepare(insertSql);

  // Build a map: saleTransactionId → grade (from trade_number index)
  type GradeEntry = NonNullable<typeof grades>[number];
  const gradeByTxId = new Map<number, GradeEntry>();
  if (groupedTrades && grades) {
    for (const grade of grades) {
      const idx = grade.trade_number - 1; // trade_number is 1-indexed
      if (idx >= 0 && idx < groupedTrades.length) {
        gradeByTxId.set(groupedTrades[idx].saleTransactionId, grade);
      }
    }
  }

  const insertAll = db.transaction(() => {
    let count = 0;
    for (const rt of roundTrips) {
      // Match by trade_number via grouped trades (new path)
      let matched = gradeByTxId.get(rt.saleTransactionId);

      // Fallback: match by symbol + exit_date (legacy path)
      if (!matched && grades) {
        matched = grades.find(
          (g) => g.symbol === rt.symbol && g.exit_date === rt.exitDate
        );
      }

      const params: unknown[] = [
        reviewId,
        rt.accountId,
        rt.securityId,
        rt.symbol,
        rt.entryDate,
        rt.entryPrice,
        rt.entryQuantity,
        rt.entryCost,
        rt.exitDate,
        rt.exitPrice,
        rt.exitQuantity,
        rt.exitProceeds,
        rt.holdingDays,
        rt.realizedPnl,
        rt.returnPct,
        matched?.grade ?? null,
        matched?.assessment ?? matched?.entry_thesis ?? null,
        matched?.what_worked ?? matched?.exit_assessment ?? null,
        matched?.what_didnt ?? matched?.what_went_well ?? null,
        matched?.what_went_wrong ?? null,
      ];

      if (hasSaleTxCol.cnt > 0) {
        params.push(rt.saleTransactionId);
      }

      stmt.run(...params);
      count++;
    }
    return count;
  });

  return insertAll();
}
