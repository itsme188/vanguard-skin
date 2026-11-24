// Display-only labels for the Analysis Diagnostics cards. Each card's percent
// is taken over a different denominator when a short is held; the strings
// here say which. No figure is computed here.

export const PERCENT_BASIS = {
  /** Breakdown "%": signed net sum of the scope's holdings, shorts in. */
  breakdown: "% of net holdings value",
  /** Breakdown "Net exp %" and the Net exposure badge: net worth (holdings plus broker cash). */
  breakdownExposure: "% of net worth",
  breakdownCaption:
    "Breakdown: % is of net holdings value (longs minus shorts, no broker cash); none is shown when that is zero or negative. Net exp % is delta-adjusted exposure over net worth (holdings plus cash, the Portfolio strip's figure), the same base as the Net exposure badge; money-market funds count as no exposure, and none is shown when net worth is not on file or is 5% of gross exposure or less.",
  /** Concentration: sum of absolute market values, per position (not delta exposure). */
  concentration: "% of gross market value",
  concentrationCaption:
    "Concentration is by market value per position: each weight is a % of gross market value (longs plus the size of shorts).",
  /** Risk Decomposition top-5: gross. */
  riskTop5: "% of gross market value",
  riskTop5Caption:
    "Top-5 and bar weights are by market value per position: a % of gross market value (longs plus the size of shorts).",
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
