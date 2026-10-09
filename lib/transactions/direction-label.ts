import { readIbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
import { transactionTypeLabel } from "@/lib/chart/marker-label";

const SELL_FAMILY = new Set(["SELL", "SELL_TO_OPEN", "SELL_TO_CLOSE", "SHORT_SELL"]);
const BUY_FAMILY = new Set(["BUY", "BUY_TO_OPEN", "BUY_TO_CLOSE", "BUY_TO_COVER"]);

/**
 * DISPLAY-ONLY type for a trade row. The stored type is never changed. When the
 * IBKR direction evidence kept in the notes says a sell-family row opened a
 * position (open, not close) it reads SELL_TO_OPEN; a buy-family row that closed
 * one (close, not open) reads BUY_TO_CLOSE. No evidence, mixed open/close
 * evidence, agreement with the stored type, or a non-trade type: the stored type
 * is returned unchanged. A short is never inferred from an unmatched sale.
 */
export function transactionDisplayType(type: string, notes: string | null | undefined): string {
  const upper = type.toUpperCase();
  const isSell = SELL_FAMILY.has(upper);
  const isBuy = BUY_FAMILY.has(upper);
  if (!isSell && !isBuy) return type;
  const evidence = readIbkrTradeDirection(notes);
  if (!evidence) return type;
  if (isSell && evidence.open && !evidence.close) return "SELL_TO_OPEN";
  if (isBuy && evidence.close && !evidence.open) return "BUY_TO_CLOSE";
  return type;
}

/** Sentence-cased label for the display type ("Sell to open"). */
export function transactionDirectionLabel(type: string, notes: string | null | undefined): string {
  return transactionTypeLabel(transactionDisplayType(type, notes));
}
