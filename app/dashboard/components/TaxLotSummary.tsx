import type { TaxLotSummary, AccountTaxSummary } from "@/lib/queries/tax-lots";

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
  year,
}: {
  summary: TaxLotSummary;
  year: number;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <GainCard
        label="Unrealized"
        value={summary.totalUnrealizedGain}
        sublabel={`${summary.totalOpenLots} open lot${summary.totalOpenLots !== 1 ? "s" : ""}`}
      />
      <GainCard
        label={`${year} Realized`}
        value={summary.totalRealizedGain}
        sublabel={`${summary.totalClosedSales} sale${summary.totalClosedSales !== 1 ? "s" : ""}`}
      />
      <GainCard
        label={`${year} Long-Term`}
        value={summary.longTermGain}
        sublabel="> 365 days"
      />
      <GainCard
        label={`${year} Short-Term`}
        value={summary.shortTermGain}
        sublabel="calendar year"
      />
    </div>
  );
}

export function AccountSummaryCards({
  accounts,
  year,
}: {
  accounts: AccountTaxSummary[];
  year: number;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-3">
        {year} Short-Term by Account
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {accounts.map((acct) => {
          const isPositive = acct.shortTermGain >= 0;
          return (
            <div
              key={acct.account_id}
              className="rounded-xl border border-edge bg-panel p-4"
            >
              <div className="text-xs text-ink-faint mb-1.5 truncate">
                {acct.account_name}
              </div>
              <div
                className={`text-lg font-semibold font-mono tabular-nums ${
                  acct.shortTermGain === 0
                    ? "text-ink-dim"
                    : isPositive
                      ? "text-up"
                      : "text-down"
                }`}
              >
                {isPositive && acct.shortTermGain !== 0 ? "+" : ""}
                {formatCurrency(acct.shortTermGain)}
              </div>
              <div className="text-[11px] text-ink-faint mt-1">
                {acct.totalClosedSales} sale{acct.totalClosedSales !== 1 ? "s" : ""}
                {acct.longTermGain !== 0 && (
                  <span>
                    {" "}· LT: {acct.longTermGain >= 0 ? "+" : ""}
                    {formatCurrency(acct.longTermGain)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
