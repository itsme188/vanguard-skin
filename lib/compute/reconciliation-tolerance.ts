/**
 * How far a statement value may sit from the computed value before the
 * reconciliation chip alarms. Owner ruling 2026-10-08: the tolerance scales
 * with the account, with a flat-dollar floor so a small account's rounding
 * residue is never red.
 */
export const RECON_MATCH_TOLERANCE = 0.01;
export const RECON_FLOOR_DOLLARS = 100;
export const RECON_NEUTRAL_PCT = 0.001;
export const RECON_RED_PCT = 0.005;

export type ReconciliationBand = "match" | "within" | "close" | "off";

export function reconciliationBand(
  difference: number | null,
  statementValue: number,
): ReconciliationBand | null {
  if (difference == null || Number.isNaN(difference)) return null;
  const abs = Math.abs(difference);
  if (abs < RECON_MATCH_TOLERANCE) return "match";
  // No usable statement value: every difference counts as a large share, so
  // only the flat floor decides between close and off.
  const share =
    Number.isFinite(statementValue) && statementValue > 0 ? abs / statementValue : Infinity;
  if (share < RECON_NEUTRAL_PCT) return "within";
  if (abs > RECON_FLOOR_DOLLARS && share > RECON_RED_PCT) return "off";
  return "close";
}
