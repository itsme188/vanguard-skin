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
  let data: { years: GivingYear[]; reconciliation: ReconciliationReport; conventionPending: boolean };
  try {
    data = getGivingView(db);
  } catch {
    throw new Error("Failed to load giving data. The database may be unavailable.");
  }

  const { years, reconciliation, conventionPending } = data;
  const hasDonations = years.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Analysis · Giving</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          Charitable giving by year — donated stock cost basis, capital gains avoided, and cash gifts.
        </p>
      </div>

      {/* Convention-pending note (WS1 pending-state contract, same tone as
          TradeReviewView's pending banner): the tax-lot dollar convention is
          pending a recompute right now — a small, honest caveat rather than
          hiding the basis/gain-avoided figures below. */}
      {conventionPending && (
        <div className="rounded-lg px-5 py-3 bg-gold/5 border-l-2 border-gold flex items-start gap-2">
          <span aria-hidden className="text-gold text-sm leading-5">⚠</span>
          <p className="text-xs text-ink-dim leading-5">
            <span className="text-gold-ink font-medium">
              Cost-basis figures are pending a recompute.
            </span>{" "}
            Cost-basis figures are pending a recompute under the corrected
            dollar convention and may be unit-inconsistent until the next
            recompute completes.
          </p>
        </div>
      )}

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
          hint="Import your DAF provider's contributions CSV via the Import tab to get started — donations are also detected from Vanguard/IBKR statement charitable-transfer activity."
        />
      )}
    </div>
  );
}
