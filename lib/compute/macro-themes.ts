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

// Signals (articles, enriched events, level alerts) are portfolio-wide —
// scope-specific filtering happens later in the post-process step when we
// attach exposure_bucket + top_contributors from computeFactorAnalysis. The
// _scope param is accepted for interface symmetry with future scope-aware
// expansion (e.g., narrowing alerts to held-only in the scope).
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

// ---------------------------------------------------------------------------
// Theme generation
// ---------------------------------------------------------------------------

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { parseJsonArrayLenient } from "@/lib/ai/extract-json";
import { resolveFeatureModel } from "@/lib/ai/models";
import { resolveScope } from "@/lib/queries/accounts";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { computeFactorAnalysis } from "@/lib/compute/factors";

const SYSTEM_PROMPT = `You are a portfolio analyst identifying the macro themes that actually moved markets this week. Output ONLY valid JSON matching the schema. Never include prose outside the JSON array. 3-5 themes maximum. Each theme must map to one factor_label from the allowed list. Each summary is one sentence, 30-200 chars. Prefer fewer broader themes over many narrow ones — split only when the underlying drivers are independent.`;

const USER_PROMPT_TEMPLATE = `Given the past 7 days of news articles, enriched macro events (CPI/PCE/FOMC actuals + market reactions), and price-level alerts that fired, identify 3-5 macro themes that drove markets this week.

For each theme:
- name: short label (e.g., "Tariff escalation", "AI mania cooling")
- factor_label: one of [interest_rate_sensitive, growth_vs_value, cyclical, international_exposure, geopolitical_onshoring, tariff_exposure, ai_exposure, crypto_adjacent, regulatory_risk]
- direction: "risk-on" | "risk-off" | "neutral"
- summary: one-sentence what it means (30-200 chars)

Output JSON array only. Example:
[{"name":"...","factor_label":"...","direction":"...","summary":"..."}]

Inputs:
{INPUTS_JSON}`;

/**
 * A themes reply we could not turn into validated themes.
 *
 * `message` is USER-FACING — it is what the API returns and the Macro-this-week
 * card renders, so it never carries parser jargon ("Unterminated string in JSON
 * at position 1074"). `detail` carries that raw text plus the head of the reply
 * for the server log. (2026-09-10 QA: the raw SyntaxError message rendered in
 * the card, in red, as the whole card body.)
 */
export class MacroThemesParseError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "MacroThemesParseError";
    this.detail = detail;
  }
}

const UNREADABLE_MESSAGE =
  "The model's reply couldn't be read as themes — try again in a moment.";
const WRONG_SHAPE_MESSAGE =
  "The model's reply didn't match the themes format — try again in a moment.";
const DETAIL_REPLY_CHARS = 120;

function replySnippet(rawText: string): string {
  return rawText.slice(0, DETAIL_REPLY_CHARS);
}

// Parse the model's themes JSON through the project-standard lenient path
// (fence strip → whole-text parse → first-`[`…last-`]` slice, each with the
// C0-control-character retry — see lib/ai/extract-json.ts). That tolerates the
// three shapes Sonnet actually emits despite the "JSON only" system prompt: a
// prose preamble, a trailing sign-off, and unescaped newlines inside a string
// literal. A genuinely unreadable reply (usually a truncated one) throws
// MacroThemesParseError so the failure surfaces in plain English.
export function parseThemesJson(rawText: string): MacroThemeAi[] {
  let raw: unknown[];
  try {
    raw = parseJsonArrayLenient(rawText, "macro themes");
  } catch (err) {
    // parseJsonArrayLenient keeps the underlying SyntaxError as `cause`.
    const parserMsg =
      err instanceof Error
        ? err.cause instanceof Error
          ? err.cause.message
          : err.message
        : String(err);
    const detail = `${parserMsg} — reply began: ${replySnippet(rawText)}`;
    console.error(`[macro-themes] unreadable model reply: ${detail}`);
    throw new MacroThemesParseError(UNREADABLE_MESSAGE, detail);
  }
  try {
    return MacroThemesSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = `${msg} — reply began: ${replySnippet(rawText)}`;
    console.error(`[macro-themes] reply failed schema validation: ${detail}`);
    throw new MacroThemesParseError(WRONG_SHAPE_MESSAGE, detail);
  }
}

export interface GenerateMacroThemesOpts {
  scope: string;
  weekOf: string;
  forceRegen?: boolean;
}

export interface MacroThemesResult {
  themes: MacroTheme[];
  sourceSummary: {
    articles: Array<{ id: number; title: string }>;
    events: Array<{ id: number; symbol: string | null; event_date: string }>;
    alerts: Array<{ id: number; symbol: string }>;
  } | null;
  fromCache: boolean;
  generatedAt: string;
  underThreshold: boolean;
}

const EXPOSURE_THRESHOLDS = { low: 0.05, moderate: 0.15, high: 0.25 } as const;

function bucketExposure(weight: number): ExposureBucket {
  if (weight < EXPOSURE_THRESHOLDS.low) return "low";
  if (weight < EXPOSURE_THRESHOLDS.moderate) return "moderate";
  if (weight < EXPOSURE_THRESHOLDS.high) return "high";
  return "very-high";
}

export async function generateMacroThemes(
  db: Database.Database,
  opts: GenerateMacroThemesOpts
): Promise<MacroThemesResult> {
  if (!opts.forceRegen) {
    const cached = getCachedMacroThemes(db, opts.scope, opts.weekOf);
    if (cached) {
      const themes = JSON.parse(cached.themesJson) as MacroTheme[];
      const sourceSummary = cached.sourceSummary ? JSON.parse(cached.sourceSummary) : null;
      return { themes, sourceSummary, fromCache: true, generatedAt: cached.generatedAt, underThreshold: false };
    }
  }

  const blob = buildMacroSignalBlob(db, opts.scope, opts.weekOf);

  // Under-threshold → empty array + cache it so we don't re-call Sonnet
  // on every page view this week.
  if (blob.underThreshold) {
    upsertMacroThemes(db, {
      scope: opts.scope, weekOf: opts.weekOf, themesJson: "[]",
      sourceSummary: JSON.stringify({ articles: [], events: [], alerts: [], note: "insufficient signal" }),
      modelUsed: "(none — under threshold)",
    });
    return { themes: [], sourceSummary: null, fromCache: false, generatedAt: new Date().toISOString(), underThreshold: true };
  }

  const inputs = {
    articles: blob.articles.map((a) => ({
      id: a.id, subject: a.subject, sentiment: a.sentiment,
      symbols: a.mentioned_symbols, excerpt: a.excerpt.slice(0, 800),
    })),
    enriched_events: blob.enrichedEvents,
    alerts: blob.alerts,
  };
  const prompt = USER_PROMPT_TEMPLATE.replace("{INPUTS_JSON}", JSON.stringify(inputs, null, 2).slice(0, 16000));

  let rawText: string;
  try {
    const result = await generateTextForFeature("analysisMacroThemes", { system: SYSTEM_PROMPT, prompt });
    rawText = result.text.trim();
  } catch (err) {
    if (err instanceof AIRefusalError) {
      throw new Error(`Sonnet macro-themes generation refused`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Sonnet macro-themes generation failed: ${msg}`);
  }

  const parsed = parseThemesJson(rawText);

  // Post-process: attach per-scope exposure bucket + top-3 contributors from
  // computeFactorAnalysis().tilts (per-factor weighted exposure across the 9
  // FACTOR_COLUMNS). Shipped 2026-05-11 — replaces the prior defensive
  // `(as any)?.tilts` cast that always degraded to "low" + empty contributors.
  const accountIds = resolveScope(db, opts.scope);
  const factorResult = computeFactorAnalysis(db, { accountIds });

  const themes: MacroTheme[] = parsed.map((t) => {
    const factorTilt = factorResult.tilts.find((tilt) => tilt.factor === t.factor_label) ?? null;
    const exposureWeight = factorTilt ? factorTilt.exposurePct / 100 : 0;
    const top = factorTilt
      ? factorTilt.topContributors.slice(0, 3).map((c) => ({ symbol: c.symbol, weight: c.weight }))
      : [];
    return { ...t, exposure_bucket: bucketExposure(exposureWeight), top_contributors: top };
  });

  const sourceSummary = {
    articles: blob.articles.slice(0, 10).map((a) => ({ id: a.id, title: a.subject })),
    events: blob.enrichedEvents.slice(0, 10).map((e) => ({ id: e.id, symbol: e.symbol, event_date: e.event_date })),
    alerts: blob.alerts.slice(0, 10).map((a) => ({ id: a.id, symbol: a.symbol })),
  };

  const modelUsed = resolveFeatureModel("analysisMacroThemes").modelId;
  upsertMacroThemes(db, {
    scope: opts.scope, weekOf: opts.weekOf,
    themesJson: JSON.stringify(themes),
    sourceSummary: JSON.stringify(sourceSummary),
    modelUsed,
  });

  return { themes, sourceSummary, fromCache: false, generatedAt: new Date().toISOString(), underThreshold: false };
}
