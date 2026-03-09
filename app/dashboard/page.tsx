import { db } from "@/lib/db";
import {
  getAccountSummaries,
  getPortfolioChartData,
  getPortfolioTotals,
} from "@/lib/queries/dashboard";
import { computeTwr } from "@/lib/compute/twr";
import { PerformanceMetrics } from "./components/PerformanceMetrics";
import type { TwrPeriod } from "./components/PerformanceMetrics";
import { AccountSummaryCards } from "./components/AccountSummaryCards";
import { CombinedPortfolioChart } from "./components/CombinedPortfolioChart";
import Link from "next/link";

function computeTwrPeriods(): { periods: TwrPeriod[]; perAccount: Map<number, { totalReturn: number; annualizedReturn: number | null }> } {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const ytdStart = `${year}-01-01`;
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const ytd = computeTwr(db, { startDate: ytdStart, endDate: today });
  const oneYear = computeTwr(db, { startDate: oneYearAgo, endDate: today });
  const inception = computeTwr(db, {});

  const periods: TwrPeriod[] = [
    {
      label: "YTD",
      totalReturn: ytd?.totalReturn ?? null,
      annualizedReturn: ytd?.annualizedReturn ?? null,
    },
    {
      label: "1Y",
      totalReturn: oneYear?.totalReturn ?? null,
      annualizedReturn: oneYear?.annualizedReturn ?? null,
    },
    {
      label: "All",
      totalReturn: inception?.totalReturn ?? null,
      annualizedReturn: inception?.annualizedReturn ?? null,
    },
  ];

  // Build per-account TWR lookup from the "All" computation
  const perAccount = new Map<number, { totalReturn: number; annualizedReturn: number | null }>();
  if (inception) {
    for (const acct of inception.perAccount) {
      perAccount.set(acct.accountId, {
        totalReturn: acct.totalReturn,
        annualizedReturn: acct.annualizedReturn,
      });
    }
  }

  return { periods, perAccount };
}

export default function OverviewPage() {
  const accounts = getAccountSummaries(db);
  const chartData = getPortfolioChartData(db);
  const totals = getPortfolioTotals(db);
  const { periods: twrPeriods, perAccount: twrByAccount } = computeTwrPeriods();

  const hasData = totals.snapshotCount > 0;

  return (
    <div className="space-y-6">
      {hasData ? (
        <>
          <PerformanceMetrics totals={totals} twrPeriods={twrPeriods} />
          <AccountSummaryCards accounts={accounts} twrByAccount={twrByAccount} />
          {chartData.length > 0 && (
            <CombinedPortfolioChart data={chartData} accounts={accounts} />
          )}
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
          <div className="text-ink-faint text-4xl mb-4">$</div>
          <h2 className="text-lg font-medium text-ink mb-2">
            No portfolio data yet
          </h2>
          <p className="text-ink-dim text-sm mb-6 max-w-md mx-auto">
            Import your Vanguard statements or IBKR activity files to see your
            portfolio overview, account balances, and performance charts.
          </p>
          <Link
            href="/dashboard/import"
            className="inline-flex px-5 py-2.5 rounded-lg bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-all"
          >
            Import Files
          </Link>
        </div>
      )}
    </div>
  );
}
