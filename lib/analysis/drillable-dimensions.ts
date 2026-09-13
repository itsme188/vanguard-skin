// Single source of truth for which classification dimensions the drill-down
// query (getHoldingsInBucket, lib/queries/drill-down.ts) can actually filter
// on. AllocationDimension (lib/queries/analysis.ts) is a superset — it also
// carries `account`, `credit_rating`, `symbol` and the factor columns, none
// of which getHoldingsInBucket supports (no `a.name` accounts join, no
// credit_rating filter branch, no symbol filter branch).
//
// Pure module — no DB import, no lib/queries/* import — so the client
// component (AnalysisView.tsx, "use client") can import it directly to
// decide whether to render the "click to drill down" affordance, without
// pulling server-only query code into the browser bundle.
//
// [qa:analysis-classification--account-and-credit-rating-rows-advertise-drill-down-but-no-op]
// Before this module existed, drill-down.ts's ALLOWED_CLASSIFICATION_DIMENSIONS
// and AnalysisView.tsx's DRILL_SUPPORTED_DIMENSIONS were two independent
// hand-copies of the same list — the UI copy went stale and kept advertising
// clickability (cursor-pointer, hover highlight, "Click to drill down") for
// `account` and `credit_rating` rows that silently no-op'd on click.

export type DrillableClassificationDimension =
  | "sector"
  | "fund_category"
  | "geography"
  | "market_cap_category"
  | "style"
  | "asset_class"
  | "security_type";

export const DRILLABLE_CLASSIFICATION_DIMENSIONS: ReadonlyArray<DrillableClassificationDimension> = [
  "sector",
  "fund_category",
  "geography",
  "market_cap_category",
  "style",
  "asset_class",
  "security_type",
];

const DRILLABLE_SET: ReadonlySet<string> = new Set(DRILLABLE_CLASSIFICATION_DIMENSIONS);

/** Is `dimension` one getHoldingsInBucket can filter a classification drill-down on? */
export function isDrillableDimension(
  dimension: string
): dimension is DrillableClassificationDimension {
  return DRILLABLE_SET.has(dimension);
}
