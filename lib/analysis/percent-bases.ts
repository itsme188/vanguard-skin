// Display-only labels for the Analysis Diagnostics cards. Each card's percent
// is taken over a different denominator when a short is held; the strings
// here say which. No figure is computed here.

export const PERCENT_BASIS = {
  /** Breakdown "%" and "Net exp %": signed net sum of the scope, shorts in. */
  breakdown: "% of net value",
  breakdownCaption:
    "Breakdown: % is of net value (longs minus shorts). Net exp % is delta-adjusted exposure over the same net value.",
  /** Concentration: sum of absolute values. */
  concentration: "% of gross exposure",
  concentrationCaption:
    "Concentration: each weight is a % of gross exposure (longs plus the size of shorts).",
  /** Risk Decomposition top-5: gross. */
  riskTop5: "% of gross exposure",
  riskTop5Caption:
    "Top-5 and bar weights are a % of gross exposure (longs plus the size of shorts).",
  /** Factor heatmap Weight: signed net sum per symbol. */
  factorWeight: "% of net value",
  factorWeightCaption:
    "Weight is a % of net value (longs minus shorts).",
  /** Position risk Weight: long-only, priced, unmatured. */
  positionRiskWeight: "% of long holdings",
  positionRiskWeightCaption:
    "Weight is a % of long holdings (priced, unmatured longs only; shorts excluded).",
} as const;

export const GEOGRAPHY_BUCKET_DEFINITIONS: Readonly<Record<string, string>> = {
  International: "outside the US, not otherwise broken out",
  "International Developed": "developed markets outside the US",
  Global: "US and non-US together",
};

/**
 * Definition for a catch-all geography bucket, or null. Applies to the
 * geography dimension ONLY ("International" is also a stored
 * international-exposure factor label). The group_name itself is never
 * rewritten: drill-down and donut colours key on the raw string.
 */
export function geographyBucketDefinition(
  dimension: string,
  groupName: string,
): string | null {
  if (dimension !== "geography") return null;
  return Object.prototype.hasOwnProperty.call(GEOGRAPHY_BUCKET_DEFINITIONS, groupName)
    ? GEOGRAPHY_BUCKET_DEFINITIONS[groupName]
    : null;
}
