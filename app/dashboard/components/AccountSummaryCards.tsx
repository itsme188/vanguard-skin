import type { AccountSummary } from "@/lib/queries/dashboard";
import Link from "next/link";

function formatCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null) return "\u2014";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function daysAgo(dateStr: string): number {
  const then = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

function formatShortDate(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

const ACCOUNT_DOTS: Record<string, string> = {
  "Vanguard Taxable": "bg-gold",
  "Vanguard Roth IRA": "bg-blue",
  "IBKR": "bg-up",
};

export function AccountSummaryCards({
  accounts,
  twrByAccount,
}: {
  accounts: AccountSummary[];
  twrByAccount?: Map<number, { totalReturn: number; annualizedReturn: number | null }>;
}) {
  if (accounts.every((a) => a.latestValue === null)) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {accounts.map((account) => {
        // Two-tier display: canonical statement value + mid-month estimate
        const hasEstimate = account.estimatedValue != null
          && account.canonicalValue != null
          && account.canonicalDate != null
          && account.dataSource !== "tws_live";
        const estimateChange = hasEstimate
          ? account.estimatedValue! - account.canonicalValue!
          : null;
        const canonicalChange = account.canonicalValue != null && account.previousValue != null
          ? account.canonicalValue - account.previousValue
          : null;
        const canonicalChangePct = canonicalChange != null && account.previousValue != null && account.previousValue !== 0
          ? (canonicalChange / account.previousValue) * 100
          : null;

        return (
          <Link
            key={account.id}
            href={`/dashboard/accounts?id=${account.id}`}
            aria-label={`${account.name} — ${account.latestValue !== null ? formatCurrency(account.latestValue) : "no data"}`}
            className="group rounded-xl border border-edge bg-panel p-5 hover:border-edge-strong hover:bg-raised/50 transition-all focus-ring"
          >
            {/* Header: account name + date label */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${ACCOUNT_DOTS[account.name] ?? "bg-ink-faint"}`}
                />
                <h3 className="text-sm font-medium text-ink-dim group-hover:text-ink transition-colors">
                  {account.name}
                </h3>
              </div>
              <span
                className={`text-[11px] font-mono ${
                  account.dataSource === "tws_live" ? "text-up" :
                  account.dataQuality === "live" ? "text-up" :
                  account.dataQuality === "recent" ? "text-ink-faint" :
                  "text-ink-faint"
                }`}
              >
                {account.dataSource === "tws_live"
                  ? `live ${account.latestDate}`
                  : hasEstimate
                    ? `${formatShortDate(account.canonicalDate!)} statement`
                    : account.latestDate}
              </span>
            </div>

            {/* Primary value: canonical (statement) or live */}
            <div className="text-2xl font-semibold font-mono tabular-nums tracking-tight">
              {hasEstimate
                ? formatCurrency(account.canonicalValue)
                : formatCurrency(account.latestValue)}
            </div>

            {/* Primary change: statement-to-statement or live change */}
            {hasEstimate ? (
              canonicalChange !== null && (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className={`text-sm font-mono tabular-nums ${canonicalChange >= 0 ? "text-up" : "text-down"}`}>
                    {canonicalChange >= 0 ? "+" : ""}{formatCurrency(canonicalChange)}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono tabular-nums ${
                    canonicalChangePct != null && canonicalChangePct >= 0
                      ? "bg-up-tint text-up" : "bg-down-tint text-down"
                  }`}>
                    {formatPercent(canonicalChangePct)}
                  </span>
                </div>
              )
            ) : (
              account.monthlyChange !== null && (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className={`text-sm font-mono tabular-nums ${account.monthlyChange >= 0 ? "text-up" : "text-down"}`}>
                    {account.monthlyChange >= 0 ? "+" : ""}{formatCurrency(account.monthlyChange)}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono tabular-nums ${
                    account.monthlyChangePercent != null && account.monthlyChangePercent >= 0
                      ? "bg-up-tint text-up" : "bg-down-tint text-down"
                  }`}>
                    {formatPercent(account.monthlyChangePercent)}
                  </span>
                </div>
              )
            )}

            {/* Secondary: mid-month estimate (only for statement-based accounts) */}
            {hasEstimate && (
              <div className="mt-3 pt-2.5 border-t border-edge/50">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-mono tabular-nums text-gold/80">
                    ~{formatCurrency(account.estimatedValue)}
                  </span>
                  <span className="text-[10px] font-mono text-gold/60">
                    est. +{daysAgo(account.canonicalDate!)}d
                  </span>
                </div>
                {estimateChange !== null && (
                  <div className="mt-0.5 text-[11px] font-mono text-ink-faint">
                    {estimateChange >= 0 ? "+" : ""}{formatCurrency(estimateChange)} since statement
                  </div>
                )}
              </div>
            )}

            {/* TWR */}
            {twrByAccount?.get(account.id) && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-faint">
                <span>TWR</span>
                <span
                  className={`font-mono tabular-nums ${
                    twrByAccount.get(account.id)!.totalReturn >= 0
                      ? "text-up"
                      : "text-down"
                  }`}
                >
                  {formatPercent(
                    twrByAccount.get(account.id)!.totalReturn * 100
                  )}
                </span>
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
