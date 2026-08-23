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
 * Pure formatting core, extracted for testability (no render needed).
 * Resolves whether a non-null delta reads as "unchanged" at the displayed
 * precision, and — when it doesn't — its rounded magnitude string.
 *
 * `isZero` is true when EITHER the raw |value| is below eps OR the value
 * rounds away to "0.00…" at `digits`. The second check matters on its own:
 * a raw delta can clear the eps floor (e.g. 0.004) yet still round to
 * nothing once formatted at digits=2 — without it, the caller would pair a
 * directional arrow with a "0.00" magnitude (and a "-0.00" title).
 */
export function formatWeekOverWeekMagnitude(
  value: number,
  digits: number,
  asPercent: boolean
): { isZero: boolean; magnitude: string } {
  const eps = asPercent ? 0.0001 : 0.001;
  const roundedMagnitude = asPercent
    ? (Math.abs(value) * 100).toFixed(digits)
    : Math.abs(value).toFixed(digits);
  return {
    isZero: Math.abs(value) < eps || Number(roundedMagnitude) === 0,
    magnitude: asPercent ? `${roundedMagnitude}%` : roundedMagnitude,
  };
}

/**
 * Tiny W-o-W delta pill (~10-11px) that renders next to a numeric metric:
 *   ↑ 0.12 / 7d   ↓ 1.50% / 7d   ↔ 0.00 / 7d   —
 *
 * - `value === null`     → em-dash placeholder ("no week-ago data")
 * - |value| < eps, OR the value rounds to "0.00" at `digits` → "↔ 0.00 / 7d"
 *                          rendered in gray (unchanged) — never a directional
 *                          arrow paired with a zero/"-0.00" magnitude
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
  const { isZero, magnitude } = formatWeekOverWeekMagnitude(value, digits, asPercent);
  if (isZero) {
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
  return (
    <span
      className={`text-[10px] ${colorClass} align-middle ml-1.5`}
      title={`${value > 0 ? "+" : "-"}${magnitude} vs 7 days ago`}
    >
      {arrow} {magnitude} / 7d
    </span>
  );
});
