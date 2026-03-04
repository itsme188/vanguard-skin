import type { PortfolioTotals } from "@/lib/queries/dashboard";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function PerformanceMetrics({ totals }: { totals: PortfolioTotals }) {
  if (totals.snapshotCount === 0) {
    return null;
  }

  return (
    <div className="flex items-baseline gap-6 flex-wrap">
      <div>
        <span className="text-[11px] text-ink-faint uppercase tracking-widest">
          Portfolio Value
        </span>
        <div className="text-4xl font-semibold font-mono tabular-nums tracking-tight mt-1">
          {formatCurrency(totals.totalValue)}
        </div>
      </div>

      {totals.totalPreviousValue > 0 && (
        <div className="flex items-center gap-3">
          <span
            className={`text-lg font-mono tabular-nums ${
              totals.totalChange >= 0 ? "text-up" : "text-down"
            }`}
          >
            {totals.totalChange >= 0 ? "+" : ""}
            {formatCurrency(totals.totalChange)}
          </span>
          <span
            className={`text-sm px-2 py-0.5 rounded font-mono tabular-nums ${
              totals.totalChangePercent >= 0
                ? "bg-up-tint text-up"
                : "bg-down-tint text-down"
            }`}
          >
            {totals.totalChangePercent >= 0 ? "+" : ""}
            {totals.totalChangePercent.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}
