/**
 * Repair stored trade-review dollar amounts after the option-multiplier fix
 * in computeTaxLots (2026-07-04).
 *
 * Background: computeTaxLots wrote tax_lot_sales proceeds / cost_basis_allocated /
 * realized_gain_loss WITHOUT the option contract multiplier, so every option
 * round-trip's dollar figures were 100× understated. trade_roundtrips rows are
 * snapshots taken at review-generation time, so they hold the stale values even
 * after tax lots are recomputed.
 *
 * What this does:
 *   1. Recomputes tax lots (computeTaxLots — full rebuild, same as
 *      POST /api/compute/tax-lots).
 *   2. For every trade review, re-derives round-trips from the fresh
 *      tax_lot_sales and rewrites each stored trade_roundtrips row's
 *      entry_cost / exit_proceeds / realized_pnl / return_pct (matched by
 *      sale_transaction_id + entry_date + exit_quantity + entry_price).
 *   3. Recomputes the review's summary columns (total_realized_pnl, best/worst
 *      trade, avg win/loss, profit factor) from the corrected grouped trades.
 *      AI content (review_markdown, grades) is left untouched.
 *
 * Idempotent: values are re-derived, not scaled, so re-running is a no-op.
 *
 * Usage:
 *   npx tsx scripts/repair-option-roundtrip-dollars.ts          # dry run
 *   npx tsx scripts/repair-option-roundtrip-dollars.ts --apply  # write
 */

import Database from "better-sqlite3";
import path from "path";
import { computeTaxLots } from "../lib/compute/tax-lots";
import {
  getRoundTrips,
  computeGroupedTrades,
  computeGroupedSummary,
  filterFullyCoveredTrades,
  type RoundTrip,
} from "../lib/compute/trade-roundtrips";

const APPLY = process.argv.includes("--apply");
const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function matchKey(
  saleTransactionId: number | null,
  entryDate: string,
  exitQuantity: number,
  entryPrice: number
): string {
  return `${saleTransactionId}|${entryDate}|${exitQuantity}|${entryPrice.toFixed(6)}`;
}

function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // Step 1 — recompute tax lots with the multiplier fix
  console.log("Recomputing tax lots...");
  const result = computeTaxLots(db);
  console.log(
    `  lots=${result.lotsCreated} sales=${result.salesProcessed} totalRealizedGain=$${result.totalRealizedGain.toFixed(2)}\n`
  );
  if (!APPLY) {
    // computeTaxLots already wrote inside its own transaction; in dry-run mode
    // we still want the fresh values to PREVIEW roundtrip changes, but we must
    // not persist anything. Do the whole preview inside a rolled-back txn.
    console.log("(dry run: all changes below will be rolled back)\n");
  }

  const reviews = db
    .prepare(
      `SELECT id, account_id, period_start, period_end FROM trade_reviews ORDER BY id`
    )
    .all() as Array<{
    id: number;
    account_id: number;
    period_start: string;
    period_end: string;
  }>;

  const updateRoundtrip = db.prepare(
    `UPDATE trade_roundtrips
     SET entry_cost = ?, exit_proceeds = ?, realized_pnl = ?, return_pct = ?
     WHERE id = ?`
  );

  const updateSummary = db.prepare(
    `UPDATE trade_reviews
     SET total_realized_pnl = ?, best_trade_pnl = ?, best_trade_symbol = ?,
         worst_trade_pnl = ?, worst_trade_symbol = ?, avg_win = ?, avg_loss = ?,
         profit_factor = ?
     WHERE id = ?`
  );

  let totalRowsUpdated = 0;

  const work = db.transaction(() => {
    for (const review of reviews) {
      const fresh = getRoundTrips(
        db,
        review.account_id,
        review.period_start,
        review.period_end
      );
      const freshByKey = new Map<string, RoundTrip>();
      for (const rt of fresh) {
        freshByKey.set(
          matchKey(rt.saleTransactionId, rt.entryDate, rt.exitQuantity, rt.entryPrice),
          rt
        );
      }

      const stored = db
        .prepare(
          `SELECT id, symbol, sale_transaction_id, entry_date, entry_price,
                  exit_quantity, entry_cost, exit_proceeds, realized_pnl
           FROM trade_roundtrips WHERE review_id = ?`
        )
        .all(review.id) as Array<{
        id: number;
        symbol: string;
        sale_transaction_id: number | null;
        entry_date: string;
        entry_price: number;
        exit_quantity: number;
        entry_cost: number;
        exit_proceeds: number;
        realized_pnl: number;
      }>;

      let updated = 0;
      let unmatched = 0;
      for (const row of stored) {
        const match = freshByKey.get(
          matchKey(row.sale_transaction_id, row.entry_date, row.exit_quantity, row.entry_price)
        );
        if (!match) {
          unmatched++;
          continue;
        }
        const changed =
          Math.abs(match.entryCost - row.entry_cost) > 0.005 ||
          Math.abs(match.exitProceeds - row.exit_proceeds) > 0.005 ||
          Math.abs(match.realizedPnl - row.realized_pnl) > 0.005;
        if (!changed) continue;
        console.log(
          `  review ${review.id} ${row.symbol}: cost $${row.entry_cost.toFixed(2)}→$${match.entryCost.toFixed(2)} ` +
            `proceeds $${row.exit_proceeds.toFixed(2)}→$${match.exitProceeds.toFixed(2)} ` +
            `pnl $${row.realized_pnl.toFixed(2)}→$${match.realizedPnl.toFixed(2)}`
        );
        updateRoundtrip.run(
          match.entryCost,
          match.exitProceeds,
          match.realizedPnl,
          match.returnPct,
          row.id
        );
        updated++;
      }

      // Recompute review summary from the fresh, fully-covered grouped trades
      // (same filter generateTradeReview applied when the review was created).
      const grouped = filterFullyCoveredTrades(computeGroupedTrades(fresh));
      if (grouped.length > 0) {
        const s = computeGroupedSummary(grouped);
        updateSummary.run(
          s.totalRealizedPnl,
          s.bestTradePnl,
          s.bestTradeSymbol,
          s.worstTradePnl,
          s.worstTradeSymbol,
          s.avgWin,
          s.avgLoss,
          s.profitFactor,
          review.id
        );
        console.log(
          `  review ${review.id} summary: totalPnl $${s.totalRealizedPnl.toFixed(2)}, ` +
            `best ${s.bestTradeSymbol} $${s.bestTradePnl.toFixed(2)}, worst ${s.worstTradeSymbol} $${s.worstTradePnl.toFixed(2)}` +
            (unmatched > 0 ? ` (${unmatched} stored rows had no fresh match — left as-is)` : "")
        );
      }

      totalRowsUpdated += updated;
    }

    if (!APPLY) {
      throw new Error("DRY_RUN_ROLLBACK");
    }
  });

  try {
    work();
  } catch (e) {
    if (e instanceof Error && e.message === "DRY_RUN_ROLLBACK") {
      console.log(
        `\nDry run complete — ${totalRowsUpdated} roundtrip rows would change. Re-run with --apply.`
      );
      console.log(
        "NOTE: the tax-lot recompute in step 1 was still persisted (it's the standard rebuild path, not part of the dry-run diff)."
      );
      return;
    }
    throw e;
  }

  console.log(`\nDone. ${totalRowsUpdated} roundtrip rows updated.`);
}

main();
