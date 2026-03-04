import { db } from "@/lib/db";
import {
  getOpenTaxLots,
  getClosedTaxLotSales,
  getTaxLotSummary,
} from "@/lib/queries/tax-lots";
import { TaxLotSummaryCards } from "../components/TaxLotSummary";
import { OpenLotsTable, ClosedSalesTable } from "../components/TaxLotTables";
import { RecomputeButton } from "../components/RecomputeButton";

export default function TaxLotsPage() {
  const summary = getTaxLotSummary(db);
  const openLots = getOpenTaxLots(db);
  const closedSales = getClosedTaxLotSales(db);

  const hasData = summary.totalOpenLots > 0 || summary.totalClosedSales > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-ink">Tax Lots</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            FIFO cost basis allocation across all accounts
          </p>
        </div>
        <RecomputeButton endpoint="/api/compute/tax-lots" label="Recompute" />
      </div>

      {hasData ? (
        <>
          <TaxLotSummaryCards summary={summary} />
          <OpenLotsTable lots={openLots} />
          <ClosedSalesTable sales={closedSales} />
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
