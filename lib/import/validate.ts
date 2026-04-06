import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedHolding,
  ParsedPrice,
  ParsedSnapshot,
} from "./types";

// ── Known transaction types ─────────────────────────────────────────

/** Allowlist of valid transaction types (UPPERCASE). */
export const VALID_TRANSACTION_TYPES = new Set([
  "BUY",
  "SELL",
  "DIVIDEND",
  "REINVESTMENT",
  "INTEREST",
  "TAX_WITHHELD",
  "TRANSFER",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "DEPOSIT",
  "WITHDRAWAL",
  "FEE",
  "COMMISSION",
  "BUY_TO_OPEN",
  "SELL_TO_CLOSE",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "BUY_TO_COVER",
  "EXERCISED",
  "ASSIGNED",
  "EXPIRED",
  "REDEMPTION",
  "EXCHANGE",
  "CORPORATE_ACTION",
  "SPINOFF",
  "MERGER",
  "SPLIT",
  "RETURN_OF_CAPITAL",
  "SHORT_SELL",
]);

// ── Individual validators ───────────────────────────────────────────

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Check that a string is a valid YYYY-MM-DD date. */
export function isValidDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
  );
}

/** Check that a number is finite and non-negative. */
export function isValidQuantity(qty: number | null | undefined): boolean {
  if (qty == null) return true; // optional field
  return Number.isFinite(qty) && qty >= 0;
}

/** Check that a price is finite and non-negative (allowing zero for expired options). */
export function isValidPrice(price: number | null | undefined): boolean {
  if (price == null) return true; // optional field
  return Number.isFinite(price) && price >= 0;
}

/** Check that a transaction type is in the known allowlist. */
export function isValidTransactionType(type: string): boolean {
  return VALID_TRANSACTION_TYPES.has(type.toUpperCase());
}

// ── Validation report ───────────────────────────────────────────────

export interface SkippedRow {
  category: "transaction" | "holding" | "price" | "snapshot";
  index: number;
  reason: string;
  symbol?: string;
}

export interface ValidationReport {
  /** Critical issues — rows excluded from the validated result. */
  skippedRows: SkippedRow[];
  /** Non-critical issues — rows included but flagged. */
  warnings: string[];
  /** The cleaned result with invalid rows removed. */
  validatedResult: ParsedImportResult;
}

// ── Main validator ──────────────────────────────────────────────────

/**
 * Validate a parsed import result before committing to the database.
 * Removes rows with critical errors (bad dates, NaN quantities) and
 * flags non-critical issues as warnings.
 */
export function validateParsedResult(
  parsed: ParsedImportResult,
): ValidationReport {
  const skippedRows: SkippedRow[] = [];
  const warnings: string[] = [];

  // ── Transactions ────────────────────────────────────────────────
  const validTransactions: ParsedTransaction[] = [];
  for (let i = 0; i < parsed.transactions.length; i++) {
    const txn = parsed.transactions[i];
    let skip = false;

    if (!isValidDate(txn.tradeDate)) {
      skippedRows.push({
        category: "transaction",
        index: i,
        reason: `Invalid trade date: "${txn.tradeDate}"`,
        symbol: txn.symbol,
      });
      skip = true;
    }

    if (txn.settlementDate && !isValidDate(txn.settlementDate)) {
      // Non-critical: clear the bad settlement date but keep the row
      warnings.push(
        `Transaction #${i + 1} (${txn.symbol ?? "no symbol"}): invalid settlement date "${txn.settlementDate}" — cleared`,
      );
      txn.settlementDate = undefined;
    }

    if (!isValidQuantity(txn.quantity)) {
      skippedRows.push({
        category: "transaction",
        index: i,
        reason: `Invalid quantity: ${txn.quantity}`,
        symbol: txn.symbol,
      });
      skip = true;
    }

    if (txn.amount != null && !Number.isFinite(txn.amount)) {
      skippedRows.push({
        category: "transaction",
        index: i,
        reason: `Invalid amount: ${txn.amount}`,
        symbol: txn.symbol,
      });
      skip = true;
    }

    if (!isValidTransactionType(txn.type)) {
      warnings.push(
        `Transaction #${i + 1} (${txn.symbol ?? "no symbol"}): unknown type "${txn.type}" — importing as-is`,
      );
    }

    if (!skip) {
      validTransactions.push(txn);
    }
  }

  // ── Holdings ────────────────────────────────────────────────────
  const validHoldings: ParsedHolding[] = [];
  for (let i = 0; i < parsed.holdings.length; i++) {
    const h = parsed.holdings[i];
    let skip = false;

    if (!isValidDate(h.asOfDate)) {
      skippedRows.push({
        category: "holding",
        index: i,
        reason: `Invalid as-of date: "${h.asOfDate}"`,
        symbol: h.symbol,
      });
      skip = true;
    }

    if (!Number.isFinite(h.quantity)) {
      skippedRows.push({
        category: "holding",
        index: i,
        reason: `Invalid quantity: ${h.quantity}`,
        symbol: h.symbol,
      });
      skip = true;
    }

    if (!skip) {
      validHoldings.push(h);
    }
  }

  // ── Prices ──────────────────────────────────────────────────────
  const validPrices: ParsedPrice[] = [];
  for (let i = 0; i < parsed.prices.length; i++) {
    const p = parsed.prices[i];
    let skip = false;

    if (!isValidDate(p.date)) {
      skippedRows.push({
        category: "price",
        index: i,
        reason: `Invalid date: "${p.date}"`,
        symbol: p.symbol,
      });
      skip = true;
    }

    if (!isValidPrice(p.closePrice)) {
      skippedRows.push({
        category: "price",
        index: i,
        reason: `Invalid price: ${p.closePrice}`,
        symbol: p.symbol,
      });
      skip = true;
    }

    if (!skip) {
      validPrices.push(p);
    }
  }

  // ── Snapshots ───────────────────────────────────────────────────
  const validSnapshots: ParsedSnapshot[] = [];
  for (let i = 0; i < parsed.snapshots.length; i++) {
    const s = parsed.snapshots[i];
    let skip = false;

    if (!isValidDate(s.monthEndDate)) {
      skippedRows.push({
        category: "snapshot",
        index: i,
        reason: `Invalid month-end date: "${s.monthEndDate}"`,
      });
      skip = true;
    }

    if (!Number.isFinite(s.totalValue)) {
      skippedRows.push({
        category: "snapshot",
        index: i,
        reason: `Invalid total value: ${s.totalValue}`,
      });
      skip = true;
    }

    if (!skip) {
      validSnapshots.push(s);
    }
  }

  // ── Summary warning ─────────────────────────────────────────────
  if (skippedRows.length > 0) {
    warnings.unshift(
      `Validation: ${skippedRows.length} row(s) excluded due to invalid data`,
    );
  }

  return {
    skippedRows,
    warnings,
    validatedResult: {
      ...parsed,
      transactions: validTransactions,
      holdings: validHoldings,
      prices: validPrices,
      snapshots: validSnapshots,
      warnings: [...parsed.warnings, ...warnings],
    },
  };
}
