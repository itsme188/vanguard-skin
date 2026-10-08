import type { SecurityQuote } from "@/lib/queries/security-quotes";
import { formatUSDPrecise, formatPercent } from "@/lib/format";

/**
 * Compact market-data strip for Security Detail: 52-week range (with the current
 * price's position), implied vol, and 30-day historic vol — captured from the
 * IBKR Web API snapshot (lib/ibkr/market-data.ts → security_quotes).
 *
 * This is PUBLIC market data (any reader can look up a stock's 52-week range or
 * IV); it reveals nothing about the user's holdings, so it uses plain
 * formatters and is NOT privacy-masked. Renders nothing when no quote exists.
 */
/**
 * Where the current price sits against the cached 52-week band (0 = low,
 * 1 = high). The cached band can lag the price, so a price beyond it is
 * reported as `outside` rather than silently pinned to the nearest end — a
 * marker clamped at 100% reads as "exactly at the high" while the printed
 * numbers say the price is above it.
 */
export function rangeMarker(
  currentPrice: number | null,
  low: number,
  high: number,
): { pos: number; outside: "above" | "below" | null } | null {
  if (currentPrice == null) return null;
  const raw = (currentPrice - low) / (high - low);
  return {
    pos: Math.max(0, Math.min(1, raw)),
    outside: currentPrice > high ? "above" : currentPrice < low ? "below" : null,
  };
}

export function QuoteStats({
  quote,
  range,
  currentPrice,
  usdPerUnit = 1,
}: {
  quote: SecurityQuote | null;
  /**
   * The page's one 52-week range — getWeek52Range
   * (lib/queries/security-detail.ts), the same freshness-arbitrated object the
   * stats strip prints. Pass it wherever the strip is on the page too: the
   * stored quote alone can lag the cached bars, which printed two different
   * ranges on one page. `null` = no range to show. Left out entirely, the
   * quote's own range is used (a caller with no strip beside it).
   */
  range?: { low: number; high: number; asOf: string } | null;
  currentPrice: number | null;
  /**
   * FX factor for foreign-currency securities (1 for USD). Quote fields and
   * currentPrice arrive in the security's NATIVE currency; the $-labeled
   * displays below multiply by this, while the range-position ratio stays
   * native (scale-invariant either way).
   */
  usdPerUnit?: number;
}) {
  if (!quote) return null;
  const { iv_underlying, hv_30d, dividend_yield } = quote;
  const shownRange =
    range !== undefined
      ? range
      : quote.week52_high != null && quote.week52_low != null
        ? { low: quote.week52_low, high: quote.week52_high, asOf: quote.as_of_date }
        : null;
  const week52_low = shownRange?.low ?? null;
  const week52_high = shownRange?.high ?? null;
  const hasRange = week52_high != null && week52_low != null && week52_high > week52_low;
  const hasVol = iv_underlying != null || hv_30d != null;
  if (!hasRange && !hasVol && dividend_yield == null) return null;

  const marker = hasRange ? rangeMarker(currentPrice, week52_low!, week52_high!) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-edge bg-panel px-4 py-3">
      {hasRange && (
        <div className="min-w-[200px] flex-1">
          <div className="mb-1 flex items-baseline justify-between text-[11px] font-mono">
            <span
              className="text-ink-faint uppercase tracking-wider"
              title={shownRange ? `as of ${shownRange.asOf}` : undefined}
            >
              52-wk range
            </span>
            {currentPrice != null && (
              <span className="text-ink-dim">{formatUSDPrecise(currentPrice * usdPerUnit)}</span>
            )}
          </div>
          <div className="relative h-1.5 rounded-full bg-muted">
            {marker != null && (
              <div
                className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-full bg-gold"
                // Outside the cached band the marker sits just past the bar's
                // end instead of on it.
                style={{
                  left:
                    marker.outside === "above"
                      ? "calc(100% + 4px)"
                      : marker.outside === "below"
                        ? "-8px"
                        : `calc(${(marker.pos * 100).toFixed(1)}% - 2px)`,
                }}
                title={
                  marker.outside
                    ? `${marker.outside} the cached 52-wk range`
                    : `${(marker.pos * 100).toFixed(0)}% of 52-wk range`
                }
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[11px] font-mono text-ink-faint">
            <span>{formatUSDPrecise(week52_low! * usdPerUnit)}</span>
            <span>{formatUSDPrecise(week52_high! * usdPerUnit)}</span>
          </div>
          {marker?.outside && (
            <div className="mt-1 text-[11px] font-mono text-ink-dim">
              Price is {marker.outside} the cached range · range as of {shownRange?.asOf}
            </div>
          )}
        </div>
      )}

      {iv_underlying != null && (
        <Stat label="Implied vol" value={formatPercent(iv_underlying * 100)} />
      )}
      {hv_30d != null && (
        <Stat label="30d hist vol" value={formatPercent(hv_30d * 100)} />
      )}
      {/* dividend_yield is stored as a PERCENT (3.2 = 3.2%) — see migration 058 */}
      {dividend_yield != null && dividend_yield > 0 && (
        <Stat label="Div yield (TTM)" value={formatPercent(dividend_yield)} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-mono uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="font-mono text-sm text-ink">{value}</div>
    </div>
  );
}
