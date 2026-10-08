import { formatHoldingPeriod } from "@/lib/format";
import { Chip } from "./Chip";

/**
 * Wording for a short lifecycle's day count. "short sale", never the bare
 * word "short": this badge often sits beside a TERM chip that reads "Short"
 * for a short-TERM holding period, and the two are different facts.
 */
export function shortSaleCoverLabel(days: number): string {
  return `short sale · covered +${Math.abs(days)}d`;
}

/** Tooltip that explains the label and why it is not the tax term. */
export function shortSaleCoverTitle(days: number): string {
  const span = Math.abs(days);
  return `Short sale: sold first, bought back (covered) ${span} ${span === 1 ? "day" : "days"} later. This is the direction of the position, not the short-term or long-term tax holding period.`;
}

/**
 * Renders a tax_lot_sales-lineage holding-period day count (directly, or
 * via trade_roundtrips.holding_days / trade-roundtrip aggregates — all the
 * same signed lineage). Negative values are genuine short round-trips (sale
 * paired with a later cover, 1099-B-consistent) — not a defect — so they
 * render as an info chip ("short sale · covered +Nd", with a title) instead
 * of the confusing "-Nd" text. Label only: the stored sign is read, never
 * rewritten, and long-term vs short-term is the engine's decision.
 *
 * `className` is forwarded to the Chip only (the negative branch), so a
 * caller nested inside a `font-mono`/`tabular-nums` numeric cell can reset
 * those for the chip's words without affecting the plain "Nd" text branch,
 * which should keep the surrounding numeric-column styling.
 */
export function HoldingPeriodBadge({
  days,
  className = "",
}: {
  days: number;
  className?: string;
}) {
  if (days < 0) {
    return (
      <Chip
        tone="info"
        size="xs"
        title={shortSaleCoverTitle(days)}
        className={`whitespace-nowrap ${className}`}
      >
        {shortSaleCoverLabel(days)}
      </Chip>
    );
  }
  return <>{formatHoldingPeriod(days)}</>;
}
