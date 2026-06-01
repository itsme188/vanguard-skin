/**
 * analysis-narratives.ts — Sonnet 4.6 narrative composer for Analysis surfaces.
 *
 * Cache-first: if a row exists in `analysis_narratives` for
 * (scope, surfaceKey, weekOf), return it. On miss, build a per-surface JSON
 * context blob from the existing compute fns, call Sonnet via AI Gateway,
 * UPSERT, and return.
 *
 * The system prompt enforces 2-3 sentences of plain English with no specific
 * dollar amounts — the goal is interpretation ("you're betting on a soft
 * landing"), not restatement of the numbers the surface already shows.
 */

import type Database from "better-sqlite3";
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { resolveScope } from "@/lib/queries/accounts";
import {
  getCachedNarrative,
  upsertNarrative,
} from "@/lib/queries/analysis-narratives";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";
import { getFactorHeatmap } from "@/lib/queries/analysis";

// ─── Surface registry ────────────────────────────────────────────────────────

export const NARRATIVE_SURFACES = [
  "factor-analysis",
  "risk-metrics",
  "position-risk",
  "factor-heatmap",
] as const;
export type NarrativeSurface = (typeof NARRATIVE_SURFACES)[number];

function isNarrativeSurface(s: string): s is NarrativeSurface {
  return (NARRATIVE_SURFACES as readonly string[]).includes(s);
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface GenerateOptions {
  scope: string; // "all" | "vanguard" | "ibkr" | "roth"
  surfaceKey: string; // must be in NARRATIVE_SURFACES
  weekOf: string; // YYYY-MM-DD Monday
  forceRegen?: boolean; // skip cache lookup
}

export interface NarrativeResult {
  narrativeMd: string;
  fromCache: boolean;
  generatedAt: string;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a portfolio analyst writing concise narrative prose. Output 2-3 sentences of plain English. Never include specific dollar amounts. Focus on what the data MEANS, not what it shows.`;

const SURFACE_PROMPTS: Record<NarrativeSurface, string> = {
  "factor-analysis":
    "Summarize the user's portfolio factor exposure in 2-3 sentences. Highlight the dominant tilts (Growth vs Value, AI exposure, Rate sensitivity, Cyclicality, etc.) and what they imply about the user's effective bet on the market regime. Avoid specific dollar amounts. Use plain English, no jargon.",
  "risk-metrics":
    "Summarize the portfolio's risk metrics in 2-3 sentences: drawdown profile, volatility, Sharpe, Herfindahl concentration. Note whether risk is concentrated in a few names or diversified. Avoid specific dollar amounts.",
  "position-risk":
    "In 2-3 sentences, identify which positions are driving the portfolio's risk. Mention the top 2-3 risk contributors by name and what makes them risky (size, beta, factor exposure). Avoid specific dollar amounts.",
  "factor-heatmap":
    "Read the heatmap of factor exposures across positions. In 2-3 sentences, call out the most concentrated factor bucket and any surprising holes (e.g., zero crypto exposure, no defensive plays). Avoid specific dollar amounts.",
};

// ─── Per-surface context builder ─────────────────────────────────────────────

/**
 * Build a small JSON context blob for the surface. Targeted ~500-800 tokens
 * (under ~3000 chars per surface).
 *
 * Multi-account scope handling: every compute fn now takes the FULL resolved
 * account set via `accountIds` (undefined = "all" = whole portfolio), so the
 * context reflects every account in scope — not just the first. Valuations are
 * summed across the set before drawdown/vol/Sharpe; tilts/concentration/
 * heatmap filter with `IN (...)`. No per-account hedging preamble is needed.
 */
function buildContextForSurface(
  db: Database.Database,
  scope: string,
  surface: NarrativeSurface
): string {
  const accountIds = resolveScope(db, scope);

  const emptyMessage =
    "(no data available for this surface yet — likely a fresh portfolio without classifications)";

  if (surface === "factor-analysis") {
    const result = computeFactorAnalysis(db, { accountIds });
    if (!result) return emptyMessage;
    return JSON.stringify(result, null, 2);
  }

  if (surface === "risk-metrics") {
    const result = computeRiskMetrics(db, { accountIds });
    if (!result) return emptyMessage;
    return JSON.stringify(result, null, 2);
  }

  if (surface === "position-risk") {
    const result = computePositionRisk(db, { accountIds, topN: 5 });
    if (!result) return emptyMessage;
    return JSON.stringify(result, null, 2);
  }

  if (surface === "factor-heatmap") {
    const result = getFactorHeatmap(db, accountIds);
    if (!result || result.length === 0) return emptyMessage;
    return JSON.stringify(result, null, 2);
  }

  // Unreachable — surface is exhaustive.
  return emptyMessage;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function generateNarrative(
  db: Database.Database,
  opts: GenerateOptions
): Promise<NarrativeResult> {
  // 1. Validate surface key at the boundary.
  if (!isNarrativeSurface(opts.surfaceKey)) {
    throw new Error(`unknown surface: ${opts.surfaceKey}`);
  }
  const surface: NarrativeSurface = opts.surfaceKey;

  // 2. Cache lookup unless force-regen.
  if (!opts.forceRegen) {
    const cached = getCachedNarrative(db, opts.scope, opts.surfaceKey, opts.weekOf);
    if (cached) {
      return {
        narrativeMd: cached.narrativeMd,
        fromCache: true,
        generatedAt: cached.generatedAt,
      };
    }
  }

  // 3. Build per-surface context.
  const context = buildContextForSurface(db, opts.scope, surface);

  // 4. Call Sonnet via AI Gateway. Wrap in try/catch so the caller can
  // distinguish AI errors (network / rate-limit / auth) from validation
  // errors (unknown surface / truncated output / dollar leak).
  const model = getModelForFeature("analysisFactorNarrative");
  const surfacePrompt = SURFACE_PROMPTS[surface];
  const prompt = `${surfacePrompt}\n\nData (JSON):\n${context}`;

  let rawText: string;
  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt,
    });
    rawText = result.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Sonnet narrative generation failed for ${opts.scope}/${opts.surfaceKey}: ${msg}`
    );
  }

  const narrativeMd = rawText.trim();

  // 4a. Defense-in-depth: dollar-amount post-filter. The system prompt is
  // the primary guard against $-leaks; this catches any model that ignored
  // the instruction. Matches `$5`, `$ 5`, `$5,000`, `$5.50`.
  const dollarLeak = /\$\s*\d/.test(narrativeMd);
  if (dollarLeak) {
    throw new Error(
      "Generated narrative leaked specific dollar amounts; AI ignored system prompt"
    );
  }

  // 4b. Min-length sanity. A truncated/empty model response shouldn't
  // poison the week's cache — better to throw and let the caller retry.
  if (narrativeMd.length < 40) {
    throw new Error(
      "Generated narrative too short — likely truncated AI response"
    );
  }

  // 5. UPSERT — modelUsed pulled from resolveFeatureModel(...).modelId so
  // future model swaps in FEATURE_MODELS stay a one-line change.
  const modelUsed = resolveFeatureModel("analysisFactorNarrative").modelId;
  upsertNarrative(db, {
    scope: opts.scope,
    surfaceKey: opts.surfaceKey,
    weekOf: opts.weekOf,
    narrativeMd,
    modelUsed,
  });

  return {
    narrativeMd,
    fromCache: false,
    generatedAt: new Date().toISOString(),
  };
}
