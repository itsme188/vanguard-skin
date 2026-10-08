import { hasKnownBasis } from "@/lib/compute/known-basis";

export interface GainRatioRow {
  cost_basis: number | null | undefined;
  unrealized_gain: number | null | undefined;
}

export interface GainRatioParts<Row extends GainRatioRow> {
  rows: Row[];
  totalGain: number | null;
  grossBasis: number | null;
  ratio: number | null;
}

/**
 * Aggregate gain percent over the same denominator row gain uses: gross
 * known basis. Short proceeds are stored as negative basis, but their weight
 * in a blended gain percent is |basis|, not a subtraction from the base.
 */
export function computeAggregateGainRatio<Row extends GainRatioRow>(
  rows: Row[],
): GainRatioParts<Row> {
  const inGain = rows.filter((row) => row.unrealized_gain != null && hasKnownBasis(row));
  if (inGain.length === 0) {
    return { rows: [], totalGain: null, grossBasis: null, ratio: null };
  }

  const totalGain = inGain.reduce((sum, row) => sum + row.unrealized_gain!, 0);
  const grossBasis = inGain.reduce((sum, row) => sum + Math.abs(row.cost_basis!), 0);

  return {
    rows: inGain,
    totalGain,
    grossBasis,
    ratio: grossBasis > 0 ? totalGain / grossBasis : null,
  };
}
