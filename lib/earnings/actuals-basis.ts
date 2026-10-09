/**
 * The basis line under the recap scoreboard (owner ruling 2026-10-08):
 * "the worksheet or parsed adjusted figure leads, with the vendor figure as a
 * footnote; with no worksheet figure, the vendor figure shows with a basis
 * label."
 *
 * Which figure the scoreboard shows is decided by one stamp:
 *   - `manual_actuals_at` set: `actual_value` is the hand-entered or promoted
 *     worksheet figure (lib/earnings/actuals.ts::saveManualActuals). Label
 *     "adjusted". If the vendor's figure was kept
 *     (`calendar_events.vendor_actual_value`, migration 096) and differs, it
 *     is footnoted.
 *   - not set: `actual_value` is the vendor's figure. Label "vendor".
 *
 * The line is code-rendered and public market data. It adds no delta: the
 * scoreboard's one delta stays against consensus.
 *
 * PARITY: workers/cron/src/fallback-earnings.ts mirrors the two label strings
 * (the cloud recap gets the label only, never the footnote: the snapshot is
 * not read for the vendor figure). workers/cron/test/fallback-earnings.test.ts
 * pins both sides to the same strings. Change both together.
 */
import { formatRevenueUSD, parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";

const VENDOR_BASIS = "Actuals basis: vendor.";
const ADJUSTED_BASIS = "Actuals basis: adjusted (worksheet or hand-entered figure).";

export const ACTUALS_BASIS_VENDOR_LINE = `*${VENDOR_BASIS}*`;
export const ACTUALS_BASIS_ADJUSTED_LINE = `*${ADJUSTED_BASIS}*`;

const epsText = (n: number) => n.toFixed(2);

/**
 * The vendor figure as footnote text, limited to the parts that differ from
 * the figure shown AT THE PRECISION THE SCOREBOARD PRINTS (a vendor figure
 * that prints the same is not a second figure). Null when nothing differs,
 * nothing was kept, or the vendor figure fails the plausibility gate against
 * consensus (the gate applies to every figure the scoreboard shows).
 */
function vendorFootnote(
  shownActual: string | null,
  vendorActual: string | null | undefined,
  consensus: string | null,
): string | null {
  if (!vendorActual) return null;
  if (actualsAreImplausible(consensus, vendorActual, null)) return null;
  const shown = parseFinnhubFigure(shownActual);
  const vendor = parseFinnhubFigure(vendorActual);
  const parts: string[] = [];
  if (vendor.eps != null && (shown.eps == null || epsText(shown.eps) !== epsText(vendor.eps))) {
    parts.push(`EPS ${epsText(vendor.eps)}`);
  }
  if (
    vendor.revenue != null &&
    (shown.revenue == null || formatRevenueUSD(shown.revenue) !== formatRevenueUSD(vendor.revenue))
  ) {
    parts.push(`Revenue ${formatRevenueUSD(vendor.revenue)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface ActualsBasisInput {
  /** The actual the scoreboard is showing (already past its own gate). */
  shownActual: string | null;
  /** Cluster-healed stamp, as every scoreboard caller already reads it. */
  manualActualsAt: string | null | undefined;
  vendorActualValue: string | null | undefined;
  /** The consensus string the scoreboard's delta is anchored on. */
  consensus: string | null;
}

/**
 * One markdown line, or null when the scoreboard shows no actual (a preview,
 * a recap with no actual yet, or a vendor figure blanked as implausible).
 */
export function renderActualsBasisLine(input: ActualsBasisInput): string | null {
  const shown = parseFinnhubFigure(input.shownActual);
  if (shown.eps == null && shown.revenue == null) return null;
  if (!input.manualActualsAt) return ACTUALS_BASIS_VENDOR_LINE;
  const footnote = vendorFootnote(input.shownActual, input.vendorActualValue, input.consensus);
  return footnote == null
    ? ACTUALS_BASIS_ADJUSTED_LINE
    : `*${ADJUSTED_BASIS} For reference, vendor figure (basis may differ): ${footnote}.*`;
}
