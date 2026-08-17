import { db } from "@/lib/db";
import { getGivingView, type GivingYear } from "@/lib/queries/giving-view";
import type { ReconciliationReport } from "@/lib/compute/donation-reconciliation";
import { EmptySection } from "../EmptySection";
import { GivingYearSection } from "./GivingYearSection";
import { ReconciliationStrip } from "./ReconciliationStrip";

/**
 * Analysis > Giving (Task 13) — charitable giving ledger by year: donated
 * stock (cost basis, LT/ST split, capital-gains avoided) and cash gifts,
 * plus a reconciliation strip surfacing unmatched TRANSFER_OUT/IN legs.
 *
 * Server component: calls getGivingView(db) directly, same pattern as
 * PerformanceView/DefenseView (no client-side fetch for the initial
 * render). Account-agnostic (spec §10) — NO scope prop; giving is a
 * portfolio-wide ledger, never sliced by account scope. Mutations live in
 * the client islands below (GivingYearSection, ReconciliationStrip,
 * LotAssignmentDrawer).
 */
export async function GivingView() {
  let data: { years: GivingYear[]; reconciliation: ReconciliationReport };
  try {
    data = getGivingView(db);
  } catch {
    throw new Error("Failed to load giving data. The database may be unavailable.");
  }

  const { years, reconciliation } = data;
  const hasDonations = years.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Analysis · Giving</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          Charitable giving by year — donated stock cost basis, capital gains avoided, and cash gifts.
        </p>
      </div>

      <ReconciliationStrip report={reconciliation} />

      {hasDonations ? (
        <div className="space-y-6">
          {years.map((year) => (
            <GivingYearSection key={year.year} year={year} />
          ))}
        </div>
      ) : (
        <EmptySection
          title="Giving"
          reason="No donations recorded yet."
          hint="Donations are detected from imported TRANSFER_OUT rows and Vanguard/IBKR statement charitable-transfer activity — import a statement or CSV covering a donation to see it here."
        />
      )}
    </div>
  );
}
