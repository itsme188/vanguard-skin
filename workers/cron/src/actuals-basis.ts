/**
 * Worker hand copy of lib/earnings/actuals-basis.ts: the basis line under the
 * recap scoreboard (label, plus the kept vendor figure as a footnote). The
 * Worker bundle cannot cross the Next.js path-alias boundary, so the three
 * helpers the Mac file imports are restated here, above the mirror marker,
 * under the same names. Everything below the marker is byte-identical to the
 * Mac file; test/actuals-basis-parity.test.ts pins that and runs both copies
 * over one case list.
 *
 * Never edit this file alone: change the Mac file, then copy the part below
 * the marker here.
 */
import { isPlausibleEarnings } from "./plausibility";

// PARITY (Mac: lib/format/finnhub-figure.ts::parseFinnhubFigure). Numbers,
// as on the Mac. "Rev 0" is Finnhub's placeholder for "no revenue figure
// published", never a figure; an EPS of exactly 0 is real.
function parseFinnhubFigure(s: string | null | undefined): {
  eps: number | null;
  revenue: number | null;
} {
  if (!s) return { eps: null, revenue: null };
  const out: { eps: number | null; revenue: number | null } = { eps: null, revenue: null };
  const epsMatch = /EPS\s+(-?\d+(?:\.\d+)?)/i.exec(s);
  if (epsMatch) {
    const v = Number(epsMatch[1]);
    out.eps = Number.isFinite(v) ? v : null;
  }
  const revMatch = /Rev\s+([\d.,]+)/i.exec(s);
  if (revMatch) {
    const v = Number(revMatch[1].replace(/,/g, ""));
    out.revenue = Number.isFinite(v) && v !== 0 ? v : null;
  }
  return out;
}

// PARITY (Mac: lib/format/finnhub-figure.ts::formatRevenueUSD over
// lib/format.ts::formatLargeUSD), for the non-negative figures the parser
// above can return. A figure in [$999.95M, $1B) prints "$1.00B".
const groupedInteger = new Intl.NumberFormat("en-US");
function formatRevenueUSD(value: number): string {
  if (!Number.isFinite(value)) return "\u2014";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) {
    const m = `$${(abs / 1_000_000).toFixed(1)}M`;
    return m === "$1000.0M" ? "$1.00B" : m;
  }
  if (abs >= 1_000) return `$${groupedInteger.format(Math.round(abs))}`;
  return `$${abs.toFixed(2)}`;
}

// PARITY (Mac: lib/earnings/actuals-display.ts::actualsAreImplausible).
function actualsAreImplausible(
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

// ── mirrored below this line ──

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
