import type { AccountSummary } from "@/lib/queries/dashboard";
import Link from "next/link";
import { Money, Pct } from "@/lib/privacy/components";

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
            aria-label={`${account.name} portfolio value`}
            className="group rounded-xl border border-edge bg-panel p-5 hover:border-edge-strong hover:bg-raised/50 transition-[border-color,background-color] focus-ring"
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
              <Money value={hasEstimate ? account.canonicalValue : account.latestValue} />
            </div>

            {/* Primary change: statement-to-statement or live change */}
            {hasEstimate ? (
              canonicalChange !== null && (
                <div className="mt-1.5 flex items-center gap-2">
                  <Money
                    value={canonicalChange}
                    signed
                    className={`text-sm font-mono tabular-nums ${canonicalChange >= 0 ? "text-up" : "text-down"}`}
                  />
                  <Pct
                    value={canonicalChangePct}
                    digits={2}
                    signed
                    className={`text-xs font-medium px-1.5 py-0.5 rounded font-mono tabular-nums ${
                      canonicalChangePct != null && canonicalChangePct >= 0
                        ? "bg-up/20 text-up" : "bg-down/20 text-down"
                    }`}
                  />
                </div>
              )
            ) : (
              account.monthlyChange !== null && (
                <div className="mt-1.5 flex items-center gap-2">
                  <Money
                    value={account.monthlyChange}
                    signed
                    className={`text-sm font-mono tabular-nums ${account.monthlyChange >= 0 ? "text-up" : "text-down"}`}
                  />
                  <Pct
                    value={account.monthlyChangePercent}
                    digits={2}
                    signed
                    className={`text-xs font-medium px-1.5 py-0.5 rounded font-mono tabular-nums ${
                      account.monthlyChangePercent != null && account.monthlyChangePercent >= 0
                        ? "bg-up/20 text-up" : "bg-down/20 text-down"
                    }`}
                  />
                </div>
              )
            )}

            {/* Secondary: mid-month estimate (only for statement-based accounts) */}
            {hasEstimate && (
              <div className="mt-3 pt-2.5 border-t border-edge/50">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-mono tabular-nums text-gold/80">
                    ~<Money value={account.estimatedValue} />
                  </span>
                  <span className="text-[11px] font-mono font-medium text-gold-ink">
                    est. +{daysAgo(account.canonicalDate!)}d
                  </span>
                </div>
                {estimateChange !== null && (
                  <div className="mt-0.5 text-[11px] font-mono text-ink-faint">
                    <Money value={estimateChange} signed /> since statement
                  </div>
                )}
              </div>
            )}

            {/* TWR */}
            {twrByAccount?.get(account.id) && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-faint">
                <span>TWR</span>
                <Pct
                  value={twrByAccount.get(account.id)!.totalReturn * 100}
                  digits={2}
                  signed
                  className={`font-mono tabular-nums ${
                    twrByAccount.get(account.id)!.totalReturn >= 0
                      ? "text-up"
                      : "text-down"
                  }`}
                />
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
