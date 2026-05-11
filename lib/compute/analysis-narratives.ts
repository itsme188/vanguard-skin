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

// ─── Scope resolution ────────────────────────────────────────────────────────

/**
 * Resolve a scope string to an array of account IDs (or undefined for "all").
 *
 * Mirrors the pattern in app/dashboard/analysis/page.tsx::resolveAccountIds.
 * Disjoint scopes: vanguard excludes "roth" so all = vanguard + roth + ibkr.
 */
function resolveAccountIds(
  db: Database.Database,
  scope: string
): number[] | undefined {
  if (scope === "all") return undefined;

  const rows = db
    .prepare("SELECT id, name FROM accounts")
    .all() as Array<{ id: number; name: string }>;

  if (scope === "vanguard") {
    const ids = rows
      .filter((r) => {
        const n = r.name.toLowerCase();
        return n.includes("vanguard") && !n.includes("roth");
      })
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  if (scope === "ibkr") {
    const ids = rows
      .filter((r) => r.name.toLowerCase().includes("ibkr"))
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  if (scope === "roth") {
    const ids = rows
      .filter((r) => r.name.toLowerCase().includes("roth"))
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  return undefined;
}

// ─── Per-surface context builder ─────────────────────────────────────────────

/**
 * Build a small JSON context blob for the surface. Targeted ~500-800 tokens
 * (under ~3000 chars per surface).
 *
 * Multi-account scope handling: computeFactorAnalysis / computeRiskMetrics /
 * computePositionRisk each take a SINGLE accountId. For multi-account scopes
 * (vanguard/ibkr/roth/all) we pass the FIRST resolved id (or undefined for
 * "all"). This is a lossy first pass — narrative quality only suffers, not
 * correctness. getFactorHeatmap takes the full array directly.
 */
export function buildContextForSurface(
  db: Database.Database,
  scope: string,
  surface: NarrativeSurface
): string {
  const accountIds = resolveAccountIds(db, scope);
  const firstAccountId = accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

  const emptyMessage =
    "(no data available for this surface yet — likely a fresh portfolio without classifications)";

  if (surface === "factor-analysis") {
    const result = computeFactorAnalysis(db, { accountId: firstAccountId });
    if (!result) return emptyMessage;
    return JSON.stringify(result, null, 2);
  }

  if (surface === "risk-metrics") {
    const result = computeRiskMetrics(db, { accountId: firstAccountId });
    if (!result) return emptyMessage;
    return JSON.stringify(result, null, 2);
  }

  if (surface === "position-risk") {
    const result = computePositionRisk(db, { accountId: firstAccountId, topN: 5 });
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

  // 4. Call Sonnet via AI Gateway.
  const model = getModelForFeature("analysisFactorNarrative");
  const surfacePrompt = SURFACE_PROMPTS[surface];
  const prompt = `${surfacePrompt}\n\nData (JSON):\n${context}`;

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt,
  });

  const narrativeMd = result.text.trim();

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
