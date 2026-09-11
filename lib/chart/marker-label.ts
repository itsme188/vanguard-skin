/**
 * Transaction-type label helpers.
 *
 * The transaction-type vocabulary (BUY / SELL / BUY_TO_OPEN / SELL_TO_CLOSE /
 * TAX_WITHHELD / REINVESTMENT / …) is a raw uppercase enum straight off the
 * ledger. Equity legs read fine as-is ("BUY", "SELL"), but multi-word types
 * carry an underscore-joined qualifier (BUY_TO_CLOSE, SELL_TO_OPEN,
 * TAX_WITHHELD) that used to leak into user-facing surfaces verbatim,
 * underscores and all. This is NOT chart-only: the per-security candlestick
 * chart's transaction-overlay markers (SecurityChart.tsx), the security-
 * detail transactions table's type chip (TransactionsSection.tsx ~222), and
 * the accounts transaction-history type pill (TransactionHistory.tsx ~110,
 * ~126) all render a transaction type to the user (deep-QA:
 * charts-txn-markers--raw-enum-transaction-type-labels-underscores).
 *
 * Two label forms, because the surfaces disagree on case:
 * - `markerTypeLabel` — chart marker text stays uppercase (matches the
 *   equity legs' "BUY"/"SELL", and space beside the candle is tight); only
 *   the underscores become spaces. Display-only: `isBuy()` in SecurityChart
 *   still matches the raw enum for marker position/shape/colour.
 * - `transactionTypeLabel` — general-purpose label for prose/table/chip
 *   surfaces: de-underscored and sentence-cased (e.g. "Buy to open", "Tax
 *   withheld", "Reinvestment"). Unknown/future types fall through the same
 *   algorithm rather than needing a maintained lookup table, so a new
 *   `lib/types.ts` transaction type never needs a matching entry here.
 */
export function markerTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return type
    .replace(/_+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * General-purpose transaction-type label: de-underscored and sentence-cased
 * ("BUY_TO_OPEN" -> "Buy to open", "TAX_WITHHELD" -> "Tax withheld",
 * "REINVESTMENT" -> "Reinvestment"). Used by table/chip surfaces that show
 * the type as normal prose rather than a tight chart-marker label — see
 * module doc above for which surfaces and why.
 */
export function transactionTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  const words = type.trim().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return "";
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}
