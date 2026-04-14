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
      {accounts.map((account) => (
        <Link
          key={account.id}
          href={`/dashboard/accounts?id=${account.id}`}
          aria-label={`${account.name} — ${account.latestValue !== null ? formatCurrency(account.latestValue) : "no data"}`}
          className="group rounded-xl border border-edge bg-panel p-5 hover:border-edge-strong hover:bg-raised/50 transition-all focus-ring"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${ACCOUNT_DOTS[account.name] ?? "bg-ink-faint"}`}
              />
              <h3 className="text-sm font-medium text-ink-dim group-hover:text-ink transition-colors">
                {account.name}
              </h3>
            </div>
            {account.latestDate && (
              <span
                className={`text-[11px] font-mono ${
                  account.dataQuality === "live" ? "text-up" :
                  account.dataQuality === "recent" ? "text-ink-faint" :
                  "text-gold"
                }`}
                title={
                  account.dataQuality === "live"
                    ? "All prices from today"
                    : account.dataQuality === "recent"
                      ? "Prices within 3 days"
                      : account.holdingsAsOf
                        ? `Holdings from ${account.holdingsAsOf} — values estimated`
                        : "Values estimated from stale data"
                }
              >
                {account.latestDate}
                {account.dataQuality === "estimated" && " (est.)"}
              </span>
            )}
          </div>

          <div className="text-2xl font-semibold font-mono tabular-nums tracking-tight">
            {account.dataQuality === "estimated" && account.latestValue !== null ? "~" : ""}
            {formatCurrency(account.latestValue)}
          </div>

          {account.monthlyChange !== null && (
            <div className="mt-2 flex items-center gap-2">
              <span
                className={`text-sm font-mono tabular-nums ${
                  account.monthlyChange >= 0 ? "text-up" : "text-down"
                }`}
              >
                {account.monthlyChange >= 0 ? "+" : ""}
                {formatCurrency(account.monthlyChange)}
              </span>
              <span
                className={`text-xs px-1.5 py-0.5 rounded font-mono tabular-nums ${
                  account.monthlyChangePercent !== null &&
                  account.monthlyChangePercent >= 0
                    ? "bg-up-tint text-up"
                    : "bg-down-tint text-down"
                }`}
              >
                {formatPercent(account.monthlyChangePercent)}
              </span>
            </div>
          )}

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
      ))}
    </div>
  );
}
