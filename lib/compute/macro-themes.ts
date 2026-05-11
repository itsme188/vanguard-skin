/**
 * macro-themes.ts — Sonnet 4.6 composer for weekly macro themes per scope.
 *
 * Cache-first via analysis_macro_themes. On miss, builds a 7d signal blob
 * from research_articles + calendar_events + level_alerts + factor exposure,
 * calls Sonnet via AI Gateway, validates with Zod, attaches per-scope
 * exposure buckets + top-3 contributors, UPSERTs, returns.
 */

import { z } from "zod";

const FACTOR_LABELS = [
  "interest_rate_sensitive", "growth_vs_value", "cyclical",
  "international_exposure", "geopolitical_onshoring", "tariff_exposure",
  "ai_exposure", "crypto_adjacent", "regulatory_risk",
] as const;

export const ThemeDirection = z.enum(["risk-on", "risk-off", "neutral"]);
export type ThemeDirection = z.infer<typeof ThemeDirection>;

const MacroThemeAiSchema = z.object({
  name: z.string().min(3).max(60),
  factor_label: z.enum(FACTOR_LABELS),
  direction: ThemeDirection,
  summary: z.string().min(15).max(280),
});
export type MacroThemeAi = z.infer<typeof MacroThemeAiSchema>;

export const MacroThemesSchema = z.array(MacroThemeAiSchema).min(1).max(5);

const ContributorSchema = z.object({
  symbol: z.string(),
  weight: z.number(),
});
export const ExposureBucket = z.enum(["low", "moderate", "high", "very-high"]);
export type ExposureBucket = z.infer<typeof ExposureBucket>;

export const MacroThemeSchema = MacroThemeAiSchema.extend({
  exposure_bucket: ExposureBucket,
  top_contributors: z.array(ContributorSchema).max(3),
});
export type MacroTheme = z.infer<typeof MacroThemeSchema>;
