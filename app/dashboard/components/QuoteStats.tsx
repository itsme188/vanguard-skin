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
export function QuoteStats({
  quote,
  currentPrice,
}: {
  quote: SecurityQuote | null;
  currentPrice: number | null;
}) {
  if (!quote) return null;
  const { iv_underlying, hv_30d, week52_high, week52_low } = quote;
  const hasRange = week52_high != null && week52_low != null && week52_high > week52_low;
  const hasVol = iv_underlying != null || hv_30d != null;
  if (!hasRange && !hasVol) return null;

  // Current price position within the 52-week band (0 = low, 1 = high).
  let pos: number | null = null;
  if (hasRange && currentPrice != null) {
    pos = (currentPrice - week52_low!) / (week52_high! - week52_low!);
    pos = Math.max(0, Math.min(1, pos));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-edge bg-panel px-4 py-3">
      {hasRange && (
        <div className="min-w-[200px] flex-1">
          <div className="mb-1 flex items-baseline justify-between text-[11px] font-mono">
            <span className="text-ink-faint uppercase tracking-wider">52-wk range</span>
            {currentPrice != null && (
              <span className="text-ink-dim">{formatUSDPrecise(currentPrice)}</span>
            )}
          </div>
          <div className="relative h-1.5 rounded-full bg-muted">
            {pos != null && (
              <div
                className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-full bg-gold"
                style={{ left: `calc(${(pos * 100).toFixed(1)}% - 2px)` }}
                title={`${(pos * 100).toFixed(0)}% of 52-wk range`}
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[11px] font-mono text-ink-faint">
            <span>{formatUSDPrecise(week52_low!)}</span>
            <span>{formatUSDPrecise(week52_high!)}</span>
          </div>
        </div>
      )}

      {iv_underlying != null && (
        <Stat label="Implied vol" value={formatPercent(iv_underlying * 100)} />
      )}
      {hv_30d != null && (
        <Stat label="30d hist vol" value={formatPercent(hv_30d * 100)} />
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
