/**
 * Display-layer plausibility bypass for manually-entered earnings actuals.
 *
 * lib/earnings/plausibility.ts's isPlausibleEarnings guard exists to catch
 * scrape/basis failures (e.g. GAAP-vs-adjusted sign flips, a Finnhub ratio
 * blowup) — it is documented there as NOT applying to a human-entered value:
 * "POST /api/earnings/actuals is the manual override." A row saved through
 * that endpoint (lib/earnings/actuals.ts::saveManualActuals) stamps
 * calendar_events.manual_actuals_at (migration 084); every read surface that
 * runs the plausibility guard must skip it for a manually-stamped row, or a
 * deliberate user entry (e.g. a real GAAP loss against a positive Street
 * consensus) silently renders as "—" even though the save reported success.
 *
 * QA finding: today-earningshub-actuals--manual-override-silently-suppressed-by-plausibility-guard
 */
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { isPlausibleEarnings } from "@/lib/earnings/plausibility";

/**
 * Whether a stored actual should be withheld as implausible. Pre-release
 * rows (no actual) always pass. A manually-stamped row (manualActualsAt
 * non-empty) always passes — the guard is for unattended scrapes, not a
 * value the user deliberately typed in.
 */
export function actualsAreImplausible(
  consensus: string | null,
  actual: string | null,
  manualActualsAt?: string | null,
): boolean {
  if (!actual) return false;
  if (manualActualsAt) return false;
  const c = parseFinnhubFigure(consensus);
  const a = parseFinnhubFigure(actual);
  return !isPlausibleEarnings(c.eps, a.eps, c.revenue, a.revenue);
}
