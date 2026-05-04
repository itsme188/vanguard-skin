/**
 * Factor exposure constants, display labels, and color mappings.
 * Shared between queries, UI, chat tools, and import.
 */

export const FACTOR_COLUMNS = [
  "interest_rate_sensitive",
  "growth_vs_value",
  "cyclical",
  "international_exposure",
  "geopolitical_onshoring",
  "tariff_exposure",
  "ai_exposure",
  "crypto_adjacent",
  "regulatory_risk",
] as const;

export type FactorColumn = (typeof FACTOR_COLUMNS)[number];

export const FACTOR_LABELS: Record<FactorColumn, string> = {
  interest_rate_sensitive: "Rate Sensitivity",
  growth_vs_value: "Growth vs Value",
  cyclical: "Cyclicality",
  international_exposure: "Int'l Exposure",
  geopolitical_onshoring: "Onshoring",
  tariff_exposure: "Tariff Exposure",
  ai_exposure: "AI Exposure",
  crypto_adjacent: "Crypto",
  regulatory_risk: "Regulatory Risk",
};

/** Short labels for mobile / cramped contexts (≤8 chars). */
export const FACTOR_LABELS_SHORT: Record<FactorColumn, string> = {
  interest_rate_sensitive: "Rates",
  growth_vs_value: "Growth",
  cyclical: "Cycle",
  international_exposure: "Int'l",
  geopolitical_onshoring: "Onshore",
  tariff_exposure: "Tariff",
  ai_exposure: "AI",
  crypto_adjacent: "Crypto",
  regulatory_risk: "Reg",
};

/** Standard factor levels ordered from least to most exposure */
export const STANDARD_LEVELS = ["No", "Low", "Moderate", "High", "Very High"] as const;

/** Map factor level → heatmap color (Tailwind-friendly hex) */
export const LEVEL_COLORS: Record<string, string> = {
  // Standard scale
  No: "#64748B",           // slate-500 (gray/neutral)
  Low: "#34D399",          // emerald-400
  Moderate: "#FBBF24",     // amber-400
  High: "#FB923C",         // orange-400
  "Very High": "#F87171",  // rose-400

  // Growth vs Value
  Growth: "#60A5FA",       // blue-400
  Value: "#C9A44E",        // gold

  // Crypto binary
  Yes: "#F87171",          // rose-400

  // International
  International: "#A78BFA", // violet-400

  // Fallback
  Unknown: "#334155",      // slate-700
};

/** Numeric ranking for sort ordering (higher = more exposure) */
export const FACTOR_SORT_RANK: Record<string, number> = {
  "Very High": 5,
  "High": 4,
  "International": 4,  // same tier as High for int'l exposure
  "Moderate": 3,
  "Growth": 3,          // neutral tier for growth_vs_value
  "Value": 2,
  "Low": 2,
  "Yes": 5,             // crypto binary = Very High equivalent
  "No": 1,
  "Unknown": 0,
};

/** Get display color for a factor value */
export function getFactorColor(value: string | null): string {
  if (!value || value === "Unknown") return LEVEL_COLORS.Unknown;
  return LEVEL_COLORS[value] ?? LEVEL_COLORS.Unknown;
}
