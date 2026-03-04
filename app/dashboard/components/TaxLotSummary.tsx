import type { TaxLotSummary } from "@/lib/queries/tax-lots";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function GainCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: number;
  sublabel?: string;
}) {
  const isPositive = value >= 0;
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-2">
        {label}
      </div>
      <div
        className={`text-2xl font-semibold font-mono tabular-nums tracking-tight ${
          value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
        }`}
      >
        {isPositive && value !== 0 ? "+" : ""}
        {formatCurrency(value)}
      </div>
      {sublabel && (
        <div className="text-xs text-ink-faint mt-1">{sublabel}</div>
      )}
    </div>
  );
}

export function TaxLotSummaryCards({
  summary,
}: {
  summary: TaxLotSummary;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <GainCard
        label="Unrealized"
        value={summary.totalUnrealizedGain}
        sublabel={`${summary.totalOpenLots} open lot${summary.totalOpenLots !== 1 ? "s" : ""}`}
      />
      <GainCard
        label="Realized"
        value={summary.totalRealizedGain}
        sublabel={`${summary.totalClosedSales} sale${summary.totalClosedSales !== 1 ? "s" : ""}`}
      />
      <GainCard
        label="Long-Term"
        value={summary.longTermGain}
        sublabel="> 365 days"
      />
      <GainCard
        label="Short-Term"
        value={summary.shortTermGain}
        sublabel="≤ 365 days"
      />
    </div>
  );
}
