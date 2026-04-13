-- Migration 023: Add is_short flag to tax_lots for short sale P&L tracking
--
-- SELL_TO_OPEN creates "short" lots where the standard P&L formula
-- (proceeds - cost) produces an inverted sign. This flag allows the
-- FIFO engine to negate the result for correct economic gain/loss.
--
-- Example: SELL_TO_OPEN at $6, BUY_TO_CLOSE at $2
--   Without fix: proceeds ($2) - cost ($6) = -$4 (wrong: looks like a loss)
--   With fix:    negate → +$4 (correct: you profited $4/share)

ALTER TABLE tax_lots ADD COLUMN is_short INTEGER NOT NULL DEFAULT 0;

-- Backfill: mark existing lots opened by SELL_TO_OPEN transactions
UPDATE tax_lots
SET is_short = 1
WHERE acquisition_transaction_id IN (
  SELECT id FROM transactions WHERE LOWER(type) = 'sell_to_open'
);

-- Force recompute: both tables are entirely derived from transactions
-- by computeTaxLots(). Clearing them ensures the engine rebuilds with
-- correct is_short flags and negated P&L on next trigger.
DELETE FROM tax_lot_sales;
DELETE FROM tax_lots;
