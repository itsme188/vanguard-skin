/**
 * Transaction-marker label for the per-security candlestick chart.
 *
 * The marker vocabulary (BUY / SELL / BUY_TO_OPEN / SELL_TO_CLOSE / …) is a
 * raw uppercase enum straight off the ledger. Equity legs read fine as-is
 * ("BUY", "SELL"), but option legs carry an underscore-joined qualifier
 * (BUY_TO_CLOSE, SELL_TO_OPEN, BUY_TO_COVER) that leaked into the chart's
 * marker text verbatim — the only surface in the app that renders the
 * underscore enum form to the user (deep-QA:
 * charts-txn-markers--raw-enum-transaction-type-labels-underscores).
 *
 * Marker text stays uppercase (matches the equity legs, and space beside the
 * candle is tight) — only the underscores become spaces. This is display-only:
 * `isBuy()` in SecurityChart still matches the raw enum for marker
 * position/shape/colour.
 */
export function markerTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return type
    .replace(/_+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
