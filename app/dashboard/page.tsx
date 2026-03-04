import { db } from "@/lib/db";
import {
  getAccountSummaries,
  getPortfolioChartData,
  getPortfolioTotals,
} from "@/lib/queries/dashboard";
import { PerformanceMetrics } from "./components/PerformanceMetrics";
import { AccountSummaryCards } from "./components/AccountSummaryCards";
import { CombinedPortfolioChart } from "./components/CombinedPortfolioChart";
import Link from "next/link";

export default function OverviewPage() {
  const accounts = getAccountSummaries(db);
  const chartData = getPortfolioChartData(db);
  const totals = getPortfolioTotals(db);

  const hasData = totals.snapshotCount > 0;

  return (
    <div className="space-y-6">
      {hasData ? (
        <>
          <PerformanceMetrics totals={totals} />
          <AccountSummaryCards accounts={accounts} />
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
