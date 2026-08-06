import { formatHoldingPeriod } from "@/lib/format";
import { Chip } from "./Chip";

/**
 * Renders a tax_lot_sales-lineage holding-period day count (directly, or
 * via trade_roundtrips.holding_days / trade-roundtrip aggregates — all the
 * same signed lineage). Negative values are genuine short round-trips (sale
 * paired with a later cover, 1099-B-consistent) — not a defect — so they
 * render as an info chip ("short") instead of the confusing "-Nd" text.
 *
 * `className` is forwarded to the Chip only (the negative branch), so a
 * caller nested inside a `font-mono`/`tabular-nums` numeric cell can reset
 * those for the word "short" without affecting the plain "Nd" text branch,
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
      <Chip tone="info" size="xs" className={className}>
        {formatHoldingPeriod(days)}
      </Chip>
    );
  }
  return <>{formatHoldingPeriod(days)}</>;
}
