import { db } from "@/lib/db";
import {
  getOpenTaxLots,
  getClosedTaxLotSales,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
  getAvailableSaleYears,
  getTaxLotAccountNames,
} from "@/lib/queries/tax-lots";
import { TaxLotSummaryCards, AccountSummaryCards } from "../components/TaxLotSummary";
import { OpenLotsTable, ClosedSalesTable } from "../components/TaxLotTables";
import { RecomputeButton } from "../components/RecomputeButton";
import { YearSelector, AccountSelector } from "../components/YearSelector";

export default async function TaxLotsPage(props: {
  searchParams: Promise<{ year?: string; account?: string }>;
}) {
  const searchParams = await props.searchParams;

  const availableYears = getAvailableSaleYears(db);
  const accountNames = getTaxLotAccountNames(db);
  const currentCalendarYear = new Date().getFullYear();

  const selectedYear = searchParams.year
    ? parseInt(searchParams.year, 10)
    : availableYears.includes(currentCalendarYear)
      ? currentCalendarYear
      : availableYears[0] ?? currentCalendarYear;

  const selectedAccount = searchParams.account ?? "";

  const summary = getTaxLotSummary(db, selectedYear);
  const accountSummaries = getTaxLotSummaryByAccount(db, selectedYear);
  const allOpenLots = getOpenTaxLots(db);
  const allClosedSales = getClosedTaxLotSales(db, selectedYear);

  // Filter by account if selected
  const openLots = selectedAccount
    ? allOpenLots.filter((l) => l.account_name === selectedAccount)
    : allOpenLots;
  const closedSales = selectedAccount
    ? allClosedSales.filter((s) => s.account_name === selectedAccount)
    : allClosedSales;

  const activeSummary = selectedAccount
    ? accountSummaries.find((a) => a.account_name === selectedAccount)
    : null;

  const hasData = summary.totalOpenLots > 0 || summary.totalClosedSales > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-ink">Tax Lots</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            FIFO cost basis &mdash; {selectedYear}
            {selectedAccount ? ` · ${selectedAccount}` : " · all accounts"}
          </p>
        </div>
        <RecomputeButton endpoint="/api/compute/tax-lots" label="Recompute" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {availableYears.length > 0 && (
          <YearSelector years={availableYears} currentYear={selectedYear} />
        )}
        {accountNames.length > 1 && (
          <>
            <div className="w-px h-5 bg-edge" />
            <AccountSelector accounts={accountNames} currentAccount={selectedAccount} />
          </>
        )}
      </div>

      {hasData ? (
        <>
          {selectedAccount && activeSummary ? (
            <TaxLotSummaryCards
              summary={{
                totalOpenLots: openLots.length,
                totalClosedSales: activeSummary.totalClosedSales,
                totalUnrealizedGain: openLots.reduce((sum, l) => sum + (l.unrealized_gain ?? 0), 0),
                totalRealizedGain: activeSummary.totalRealizedGain,
                longTermGain: activeSummary.longTermGain,
                shortTermGain: activeSummary.shortTermGain,
              }}
              year={selectedYear}
            />
          ) : (
            <>
              <TaxLotSummaryCards summary={summary} year={selectedYear} />
              {accountSummaries.length > 1 && (
                <AccountSummaryCards accounts={accountSummaries} year={selectedYear} />
              )}
            </>
          )}

          <OpenLotsTable lots={openLots} showAccount={!selectedAccount} />
          <ClosedSalesTable sales={closedSales} showAccount={!selectedAccount} />
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
          <div className="text-ink-faint text-3xl mb-3 font-mono">FIFO</div>
          <h3 className="text-lg font-medium text-ink mb-2">
            No tax lots computed
          </h3>
          <p className="text-ink-dim text-sm max-w-md mx-auto mb-6">
            Import your transaction data, then click &ldquo;Recompute&rdquo; to generate
            tax lots using FIFO cost basis matching.
          </p>
        </div>
      )}
    </div>
  );
}
