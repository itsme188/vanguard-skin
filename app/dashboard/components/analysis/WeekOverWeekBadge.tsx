import { memo } from "react";

interface Props {
  /** Numeric delta (positive or negative). null means "no week-ago data". */
  value: number | null;
  /** "neutral" (gray): direction-ambiguous metrics like beta. "signed": green/red (alpha, return). */
  kind?: "neutral" | "signed";
  /** Decimal places. Default 2. */
  digits?: number;
  /** Format the delta as a percent (multiply by 100, append "%"). Default false. */
  asPercent?: boolean;
}

/**
 * Tiny W-o-W delta pill (~10-11px) that renders next to a numeric metric:
 *   ↑ 0.12 / 7d   ↓ 1.50% / 7d   ↔ 0.00 / 7d   —
 *
 * - `value === null`     → em-dash placeholder ("no week-ago data")
 * - |value| < eps        → "↔ 0.00 / 7d" rendered in gray (unchanged)
 * - kind="signed"        → green when value > 0, red when value < 0
 * - kind="neutral"       → gray regardless of sign (use for direction-ambiguous
 *                          metrics like beta, volatility, herfindahl)
 *
 * The eps threshold is 0.001 (or 0.0001 when `asPercent` so 0.01% != "unchanged").
 */
export const WeekOverWeekBadge = memo(function WeekOverWeekBadge({
  value,
  kind = "neutral",
  digits = 2,
  asPercent = false,
}: Props) {
  if (value === null) {
    return (
      <span
        className="text-[9px] text-ink-faint align-middle ml-1.5"
        title="no week-ago data"
      >
        —
      </span>
    );
  }
  // Treat tiny |value| < eps as zero.
  const eps = asPercent ? 0.0001 : 0.001;
  if (Math.abs(value) < eps) {
    return (
      <span
        className="text-[10px] text-ink-faint align-middle ml-1.5"
        title="unchanged vs 7 days ago"
      >
        ↔ 0.00 / 7d
      </span>
    );
  }
  const arrow = value > 0 ? "↑" : "↓";
  const colorClass =
    kind === "signed"
      ? value > 0
        ? "text-up"
        : "text-down"
      : "text-ink-faint";
  const magnitude = asPercent
    ? `${(Math.abs(value) * 100).toFixed(digits)}%`
    : Math.abs(value).toFixed(digits);
  return (
    <span
      className={`text-[10px] ${colorClass} align-middle ml-1.5`}
      title={`${value > 0 ? "+" : "-"}${magnitude} vs 7 days ago`}
    >
      {arrow} {magnitude} / 7d
    </span>
  );
});
