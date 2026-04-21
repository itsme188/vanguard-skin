export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import {
  getAccountSummaries,
  getPortfolioChartData,
  getPortfolioTotals,
} from "@/lib/queries/dashboard";
import { getDailyValuationsPivoted } from "@/lib/queries/daily-valuations";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { PerformanceMetrics } from "./components/PerformanceMetrics";
import type { TwrPeriod } from "./components/PerformanceMetrics";
import { AccountSummaryCards } from "./components/AccountSummaryCards";
import { CombinedPortfolioChart } from "./components/CombinedPortfolioChart";
import { EmptyState } from "./components/EmptyState";
import { UpcomingEventsCard } from "./components/UpcomingEventsCard";
import { IncomeCard } from "./components/IncomeCard";
import { PeriodComparisonTable } from "./components/PeriodComparisonTable";
import { MorningBriefing } from "./components/MorningBriefing";

function computePerformancePeriods(): { periods: TwrPeriod[]; perAccount: Map<number, { totalReturn: number; annualizedReturn: number | null }> } {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const ytdStart = `${year}-01-01`;
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const threeYearsAgo = new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const ytd = computeTwr(db, { startDate: ytdStart, endDate: today });
  const oneYear = computeTwr(db, { startDate: oneYearAgo, endDate: today });
  const threeYear = computeTwr(db, { startDate: threeYearsAgo, endDate: today });
  const fiveYear = computeTwr(db, { startDate: fiveYearsAgo, endDate: today });
  const inception = computeTwr(db, {});

  // Compute XIRR for each period
  const ytdXirr = computeXirr(db, { startDate: ytdStart, endDate: today });
  const oneYearXirr = computeXirr(db, { startDate: oneYearAgo, endDate: today });
  const threeYearXirr = computeXirr(db, { startDate: threeYearsAgo, endDate: today });
  const fiveYearXirr = computeXirr(db, { startDate: fiveYearsAgo, endDate: today });
  const inceptionXirr = computeXirr(db, {});

  const periods: TwrPeriod[] = [
    {
      label: "YTD",
      totalReturn: ytd?.totalReturn ?? null,
      annualizedReturn: ytd?.annualizedReturn ?? null,
      xirr: ytdXirr?.xirr ?? null,
    },
    {
      label: "1Y",
      totalReturn: oneYear?.totalReturn ?? null,
      annualizedReturn: oneYear?.annualizedReturn ?? null,
      xirr: oneYearXirr?.xirr ?? null,
    },
    {
      label: "3Y",
      totalReturn: threeYear?.totalReturn ?? null,
      annualizedReturn: threeYear?.annualizedReturn ?? null,
      xirr: threeYearXirr?.xirr ?? null,
    },
    {
      label: "5Y",
      totalReturn: fiveYear?.totalReturn ?? null,
      annualizedReturn: fiveYear?.annualizedReturn ?? null,
      xirr: fiveYearXirr?.xirr ?? null,
    },
    {
      label: "All",
      totalReturn: inception?.totalReturn ?? null,
      annualizedReturn: inception?.annualizedReturn ?? null,
      xirr: inceptionXirr?.xirr ?? null,
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
  let accounts, chartData, dailyChartData, totals, twrPeriods: TwrPeriod[], twrByAccount: Map<number, { totalReturn: number; annualizedReturn: number | null }>;
  try {
    accounts = getAccountSummaries(db);
    chartData = getPortfolioChartData(db);
    dailyChartData = getDailyValuationsPivoted(db);
    totals = getPortfolioTotals(db);
    ({ periods: twrPeriods, perAccount: twrByAccount } = computePerformancePeriods());
  } catch {
    throw new Error("Failed to load overview data. The database may be unavailable.");
  }

  const hasData = totals.snapshotCount > 0;

  return (
    <div className="space-y-6">
      {hasData ? (
        <>
          <PerformanceMetrics
            totals={totals}
            twrPeriods={twrPeriods}
            dataQuality={
              accounts.some(a => a.dataQuality === "estimated") ? "estimated" :
              accounts.some(a => a.dataQuality === "recent") ? "recent" :
              accounts.some(a => a.dataQuality === "live") ? "live" :
              null
            }
          />
          <MorningBriefing />
          <AccountSummaryCards accounts={accounts} twrByAccount={twrByAccount} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <UpcomingEventsCard />
            <IncomeCard />
          </div>
          <PeriodComparisonTable />
          {chartData.length > 0 && (
            <CombinedPortfolioChart data={chartData} dailyData={dailyChartData} accounts={accounts} />
          )}
        </>
      ) : (
        <EmptyState
          icon={<span className="text-2xl">$</span>}
          title="No portfolio data yet"
          description="Import your Vanguard statements or IBKR activity files to see your portfolio overview, account balances, and performance charts."
          action={{ label: "Import Files", href: "/dashboard/import" }}
        />
      )}
    </div>
  );
}
