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

// ---------------------------------------------------------------------------
// Signal aggregation
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

const MIN_SIGNAL_THRESHOLD = 2;

export interface ArticleSignal {
  id: number;
  subject: string;
  sentiment: string | null;
  mentioned_symbols: string[];
  excerpt: string;
}
export interface EventSignal {
  id: number;
  event_date: string;
  event_type: string;
  symbol: string | null;
  actual_value: string | null;
  reaction_snapshot: string | null;
}
export interface AlertSignal {
  id: number;
  symbol: string;
  triggered_at: string;
}
export interface MacroSignalBlob {
  articleCount: number;
  enrichedEventCount: number;
  alertCount: number;
  totalSignalCount: number;
  underThreshold: boolean;
  articles: ArticleSignal[];
  enrichedEvents: EventSignal[];
  alerts: AlertSignal[];
}

export function buildMacroSignalBlob(
  db: Database.Database,
  _scope: string,
  weekOf: string
): MacroSignalBlob {
  const articleRows = db.prepare(
    `SELECT id, subject, sentiment, mentioned_symbols, substr(raw_text, 1, 2000) AS excerpt
     FROM research_articles
     WHERE datetime(received_at) >= datetime(?, '-7 days')
     ORDER BY datetime(received_at) DESC
     LIMIT 60`
  ).all(weekOf) as Array<{
    id: number; subject: string; sentiment: string | null;
    mentioned_symbols: string | null; excerpt: string;
  }>;

  const articles: ArticleSignal[] = articleRows.map((r) => {
    let symbols: string[] = [];
    try { symbols = r.mentioned_symbols ? JSON.parse(r.mentioned_symbols) : []; } catch { symbols = []; }
    return { id: r.id, subject: r.subject, sentiment: r.sentiment, mentioned_symbols: symbols, excerpt: r.excerpt };
  });

  const eventRows = db.prepare(
    `SELECT id, event_date, event_type, symbol, actual_value, reaction_snapshot
     FROM calendar_events
     WHERE datetime(event_date) >= datetime(?, '-7 days')
       AND enriched_at IS NOT NULL
     ORDER BY event_date DESC
     LIMIT 30`
  ).all(weekOf) as EventSignal[];

  const alertRows = db.prepare(
    `SELECT la.id, s.symbol, la.triggered_at
     FROM level_alerts la
     JOIN securities s ON s.id = la.security_id
     WHERE datetime(la.triggered_at) >= datetime(?, '-7 days')
     ORDER BY la.triggered_at DESC
     LIMIT 30`
  ).all(weekOf) as AlertSignal[];

  const articleCount = articles.length;
  const enrichedEventCount = eventRows.length;
  const alertCount = alertRows.length;
  const totalSignalCount = articleCount + enrichedEventCount;
  const underThreshold = articleCount < MIN_SIGNAL_THRESHOLD && enrichedEventCount < 1;

  return {
    articleCount, enrichedEventCount, alertCount, totalSignalCount, underThreshold,
    articles, enrichedEvents: eventRows, alerts: alertRows,
  };
}
