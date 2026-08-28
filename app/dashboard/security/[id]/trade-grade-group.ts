/**
 * Caption for an AI Trade Grade card that covers more than one stored
 * roundtrip.
 *
 * The trade-review generator writes ONE verdict per (symbol, exit_date) and
 * the storage step copies the grade letter plus all three prose fields onto
 * every trade_roundtrips row sharing that key, so getTradeGradesBySecurity
 * folds those copies into a single card. Without this caption the grade reads
 * as a verdict on one leg — the QA finding had a +$62 / +1.0% QCOM roundtrip
 * carrying an "F" and "Worst trade of the month … trim at -22.3%".
 *
 * Lives in its own module (not page.tsx) so it stays unit-testable: Next.js
 * page files may not carry arbitrary named exports.
 */
export function tradeGradeGroupCaption(
  coversRoundtrips: number,
  exitDate: string
): string | null {
  if (coversRoundtrips <= 1) return null;
  return `Covers ${coversRoundtrips} roundtrips closed ${exitDate} — one assessment for the group`;
}
