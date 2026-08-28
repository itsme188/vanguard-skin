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

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import { resolveScope } from "@/lib/queries/accounts";
import {
  getCachedNarrative,
  upsertNarrative,
} from "@/lib/queries/analysis-narratives";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";
import { getFactorHeatmap } from "@/lib/queries/analysis";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import type { DefenseAnalysis, HedgeBadge, PairClassification } from "@/lib/compute/hedging";

// ─── Surface registry ────────────────────────────────────────────────────────

export const NARRATIVE_SURFACES = [
  "factor-analysis",
  "risk-metrics",
  "position-risk",
  "factor-heatmap",
  "defense",
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
  /** sha256 of the inputs this prose was rendered from; null for legacy rows. */
  inputFingerprint: string | null;
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
  defense:
    "You are reviewing the portfolio's defensive posture. In 2-4 sentences: state how much of the long book is protected and through what (same-name hedges vs index/sector puts), name the largest UNPROTECTED exposures, and flag any hedge that looks expensive or nearly decayed (use the badges). Plain prose, no headers, no advice to buy anything new. All ratio/pct fields in the context are decimal fractions (0.18 = 18%) — convert before narrating. A negative monthlyBleedPct means the hedge COLLECTS premium (short-option income), not a cost — never call it expensive.",
};

// ─── Input fingerprinting (cache-invalidation-on-drift) ──────────────────────

/**
 * The narrative cache is keyed on (scope, surface, week) only, so Monday's
 * prose keeps being served all week even after the portfolio moves under it —
 * the defect behind "cached Defense narrative says 30% protected while the card
 * says 11%, and names a SPY put that no longer exists".
 *
 * The fix is a fingerprint over the inputs the PROMPT was rendered from. The
 * general rule for every surface: fingerprint the same object that gets
 * serialized into the prompt. The Defense surface narrows that to the
 * materially narrative-relevant fields (below) so ordinary dollar/price drift
 * doesn't cry wolf, while a changed hedge, badge, ratio, or bet does.
 *
 * Comparison happens on READ (see isNarrativeDrifted) and never regenerates —
 * regeneration stays an explicit POST, because it costs a paid model call.
 */

/** Significant digits kept when hashing numbers. High enough that every real
 *  change survives and integer ids stay exact; low enough that IEEE-754 tail
 *  noise (0.1+0.2 === 0.30000000000000004) can't manufacture a false drift. */
const NUMERIC_PRECISION_DIGITS = 12;

/**
 * Deterministic JSON serialization for hashing: object keys sorted, ARRAY
 * MEMBERS sorted by their own canonical form, numbers precision-normalized.
 *
 * Sorting arrays is deliberate — a hedge book that comes back in a different
 * SQL order is the same hedge book, and a re-ordering must never look like a
 * change. It does mean element order carries no signal, which is correct here:
 * nothing in these narratives depends on list order that isn't also captured by
 * the values themselves.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(Number(value.toPrecision(NUMERIC_PRECISION_DIGITS)));
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  // Functions/symbols never appear in these input objects.
  return "null";
}

/**
 * sha256 hex digest over (surfaceKey, canonicalized inputs). Pure — same
 * inputs in any key/array order always yield the same digest. The surface key
 * is part of the preimage so two surfaces that happen to build identical input
 * objects still get distinct fingerprints.
 */
export function fingerprintNarrativeInputs(
  surfaceKey: string,
  inputs: unknown
): string {
  return createHash("sha256")
    .update(`${surfaceKey}\u0000${canonicalJson(inputs)}`)
    .digest("hex");
}

/** 1 / 0.005 — the rounding grid is half a percentage point. */
const HALF_PP_STEPS_PER_UNIT = 200;

/**
 * Round a decimal-fraction ratio (0.18 = 18%) to the nearest 0.5pp. Coverage
 * percentages tick with every price; only a half-point move is something a
 * 2-4 sentence narrative could actually have said differently.
 */
function roundToHalfPp(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Number(
    (Math.round(v * HALF_PP_STEPS_PER_UNIT) / HALF_PP_STEPS_PER_UNIT).toFixed(3)
  );
}

/**
 * How many ranked exposures the Defense prompt actually sees
 * (`buildSurfaceInputs`'s `topExposures: result.rankedExposures.slice(0, N)`).
 * Shared by the prompt payload and the fingerprint so the two can never drift
 * out of sync again — the whole point of this fix was that the fingerprint had
 * silently stopped covering a field the prompt was reading.
 */
export const DEFENSE_TOP_EXPOSURES_N = 10;

export interface DefenseFingerprintExposure {
  /**
   * Position within the prompt's ranked-exposure slice (0 = largest). WHICH
   * identity holds a rank is itself narrative-relevant — the prompt is
   * instructed to "name the largest UNPROTECTED exposures" — so unlike the
   * other collections here, this array is intentionally NOT reordering-
   * tolerant: two exposures swapping rank must change the hash even though
   * canonicalJson sorts array members, because each element's own `rank`
   * field travels with it into that sort.
   */
  rank: number;
  underlying: string;
  securityId: number | null;
  /** hedged_long | hedged_short | amplified | unhedged | speculative — the
   *  literal protected/unprotected verdict the prompt narrates per exposure. */
  classification: PairClassification;
  hasAmplifiers: boolean;
  /** Same-name (tier-1) hedge coverage, decimal fraction rounded to 0.5pp. */
  tier1CoveragePct: number | null;
  /** Sector/index-put coverage backing this exposure, rounded to 0.5pp. */
  sectorProxyCoveragePct: number | null;
  /** Share of the long book, decimal fraction rounded to 0.5pp — a ratio,
   *  not a dollar figure, so ordinary price noise doesn't move it. */
  pctOfBook: number | null;
}

export interface DefenseFingerprintInputs {
  /** Every hedge in the book: position id + its badge set. */
  hedges: Array<{ id: number; badges: HedgeBadge[] }>;
  /** Protection ratio, decimal fraction, rounded to 0.5pp. */
  protectionRatio: number | null;
  /** Per-sector coverage, decimal fractions rounded to 0.5pp. */
  sectorCoverage: Array<{ sector: string; coveragePct: number | null }>;
  /** Security ids of the standalone (unpaired) bets. */
  standaloneBetIds: number[];
  /**
   * The top DEFENSE_TOP_EXPOSURES_N ranked exposures, in prompt order, with
   * identity + the protection fields the prompt narrates about each one.
   * Codex's finding: the prompt names the largest unprotected exposures, but
   * the fingerprint had no field covering them — selling/replacing a top
   * exposure left every hashed field unchanged while the cached prose still
   * named the exited position. Dollar exposure/notional are deliberately
   * excluded (portfolio noise the model is forbidden from quoting anyway).
   */
  topExposures: DefenseFingerprintExposure[];
}

/**
 * Reduce a DefenseAnalysis to just what the narrative can materially assert.
 *
 * Codex's amendment to the ids-plus-three-aggregates first cut: the badges
 * matter as much as the ids, because "flag any hedge that looks expensive or
 * nearly decayed" is literally in the prompt — a hedge that silently loses its
 * `expensive` badge makes the cached prose wrong even though the book is
 * otherwise identical.
 *
 * Uses the FULL hedgeScores list, not the top-15 slice the prompt sees: a
 * hedge leaving the book is a book change regardless of where it ranked, and
 * over-reporting drift only costs a banner (and an optional refresh), whereas
 * under-reporting it reproduces the original finding.
 *
 * Deliberately EXCLUDED: raw dollar exposures, notionals, thetas, prices. They
 * move every tick and the prompt forbids the model from quoting dollars anyway.
 */
export function buildDefenseFingerprintInputs(
  analysis: DefenseAnalysis
): DefenseFingerprintInputs {
  const hedges = analysis.hedgeScores
    .map((h) => ({ id: h.securityId, badges: [...h.badges].sort() }))
    .sort((a, b) => a.id - b.id);

  const sectorCoverage = analysis.sectorCoverage
    .map((sc) => ({
      sector: sc.sector,
      coveragePct: roundToHalfPp(sc.coveragePct),
    }))
    .sort((a, b) => a.sector.localeCompare(b.sector));

  const standaloneBetIds = Array.from(
    new Set(
      analysis.standaloneBets.flatMap((b) =>
        b.instruments.map((i) => i.securityId)
      )
    )
  ).sort((a, b) => a - b);

  // Deliberately NOT sorted by identity — rank order IS the signal (see
  // DefenseFingerprintExposure.rank doc). Sliced to the same N the prompt's
  // `topExposures` uses, from the same rankedExposures the prompt reads.
  const topExposures: DefenseFingerprintExposure[] = analysis.rankedExposures
    .slice(0, DEFENSE_TOP_EXPOSURES_N)
    .map((r, rank) => ({
      rank,
      underlying: r.underlying,
      securityId: r.securityId,
      classification: r.classification,
      hasAmplifiers: r.hasAmplifiers,
      tier1CoveragePct: roundToHalfPp(r.tier1CoveragePct),
      sectorProxyCoveragePct: roundToHalfPp(r.sectorProxyCoveragePct),
      pctOfBook: roundToHalfPp(r.pctOfBook),
    }));

  return {
    hedges,
    protectionRatio: roundToHalfPp(analysis.summary.protectionRatio),
    sectorCoverage,
    standaloneBetIds,
    topExposures,
  };
}

// ─── Per-surface context builder ─────────────────────────────────────────────

interface SurfaceInputs {
  /** The JSON blob rendered into the prompt. */
  context: string;
  /** What the fingerprint hashes — the prompt inputs (narrowed, for defense). */
  fingerprintInput: unknown;
}

/**
 * Build a small JSON context blob for the surface. Targeted ~500-800 tokens
 * (under ~3000 chars per surface), plus the fingerprint input for that same
 * context so the two can never drift apart.
 *
 * Multi-account scope handling: every compute fn now takes the FULL resolved
 * account set via `accountIds` (undefined = "all" = whole portfolio), so the
 * context reflects every account in scope — not just the first. Valuations are
 * summed across the set before drawdown/vol/Sharpe; tilts/concentration/
 * heatmap filter with `IN (...)`. No per-account hedging preamble is needed.
 */
function buildSurfaceInputs(
  db: Database.Database,
  scope: string,
  surface: NarrativeSurface
): SurfaceInputs {
  const accountIds = resolveScope(db, scope);

  const emptyMessage =
    "(no data available for this surface yet — likely a fresh portfolio without classifications)";
  // An empty surface still needs a STABLE fingerprint: two consecutive reads of
  // an empty book must agree, and the first real data must read as drift.
  const empty: SurfaceInputs = {
    context: emptyMessage,
    fingerprintInput: { empty: surface },
  };

  if (surface === "factor-analysis") {
    const result = computeFactorAnalysis(db, { accountIds });
    if (!result) return empty;
    return { context: JSON.stringify(result, null, 2), fingerprintInput: result };
  }

  if (surface === "risk-metrics") {
    const result = computeRiskMetrics(db, { accountIds });
    if (!result) return empty;
    return { context: JSON.stringify(result, null, 2), fingerprintInput: result };
  }

  if (surface === "position-risk") {
    // topN:10 matches the surface's table (PositionRiskCard fetches
    // topN=10) — a narrower topN here would silently drop true top risk
    // contributors that rank outside the top-5 by market value.
    const result = computePositionRisk(db, { accountIds, topN: 10 });
    if (!result) return empty;
    // computePositionRisk's SQL selects candidates ORDER BY market_value
    // DESC (it must, to pick the topN subset before vol/corr can even be
    // computed) — but the table renders them sorted by riskContribution
    // desc (PositionRiskCard.tsx). Re-rank here so the model sees the same
    // "biggest risk contributors" ordering the table shows, not a
    // value-ordered list it would otherwise confabulate from.
    const rankedPositions = [...result.positions].sort((a, b) => {
      if (a.riskContribution == null && b.riskContribution == null) return 0;
      if (a.riskContribution == null) return 1;
      if (b.riskContribution == null) return -1;
      return b.riskContribution - a.riskContribution;
    });
    const payload = { ...result, positions: rankedPositions };
    return { context: JSON.stringify(payload, null, 2), fingerprintInput: payload };
  }

  if (surface === "factor-heatmap") {
    const result = getFactorHeatmap(db, accountIds);
    if (!result || result.length === 0) return empty;
    return { context: JSON.stringify(result, null, 2), fingerprintInput: result };
  }

  if (surface === "defense") {
    const result = computeDefenseAnalysis(db, accountIds);
    if (result.summary.hedgeCount === 0 && result.summary.shortExposure === 0) return empty;
    const payload = {
      summary: result.summary,
      sectorCoverage: result.sectorCoverage,
      topExposures: result.rankedExposures.slice(0, DEFENSE_TOP_EXPOSURES_N),
      hedgeScores: result.hedgeScores.slice(0, 15),
      diagnostics: result.diagnostics,
    };
    return {
      context: JSON.stringify(payload, null, 2),
      fingerprintInput: buildDefenseFingerprintInputs(result),
    };
  }

  // Unreachable — surface is exhaustive.
  return empty;
}

/**
 * Fingerprint of the CURRENT inputs for (scope, surface). Compute-only: it
 * touches the DB but never the model and never writes, so a GET can safely call
 * it to decide whether the cached prose still describes the portfolio.
 */
export function computeNarrativeFingerprint(
  db: Database.Database,
  scope: string,
  surfaceKey: string
): string {
  if (!isNarrativeSurface(surfaceKey)) {
    throw new Error(`unknown surface: ${surfaceKey}`);
  }
  const { fingerprintInput } = buildSurfaceInputs(db, scope, surfaceKey);
  return fingerprintNarrativeInputs(surfaceKey, fingerprintInput);
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
        inputFingerprint: cached.inputFingerprint,
      };
    }
  }

  // 3. Build per-surface context AND the fingerprint of those same inputs, in
  // one pass — the prose and its freshness stamp must describe the identical
  // snapshot, so they can never be built from two different reads of the book.
  const { context, fingerprintInput } = buildSurfaceInputs(db, opts.scope, surface);
  const inputFingerprint = fingerprintNarrativeInputs(surface, fingerprintInput);

  // 4. Call Sonnet via AI Gateway. Wrap in try/catch so the caller can
  // distinguish AI errors (network / rate-limit / auth) from validation
  // errors (unknown surface / truncated output / dollar leak).
  const surfacePrompt = SURFACE_PROMPTS[surface];
  const prompt = `${surfacePrompt}\n\nData (JSON):\n${context}`;

  let rawText: string;
  try {
    const result = await generateTextForFeature("analysisFactorNarrative", {
      system: SYSTEM_PROMPT,
      prompt,
    });
    rawText = result.text;
  } catch (err) {
    if (err instanceof AIRefusalError) {
      throw new Error(
        `Sonnet narrative generation refused for ${opts.scope}/${opts.surfaceKey}`
      );
    }
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
    inputFingerprint,
  });

  return {
    narrativeMd,
    fromCache: false,
    generatedAt: new Date().toISOString(),
    inputFingerprint,
  };
}
