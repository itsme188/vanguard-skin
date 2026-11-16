/**
 * analysis-narratives.ts — narrative composer for Analysis surfaces.
 *
 * Cache-first: if a row exists in `analysis_narratives` for
 * (scope, surfaceKey, weekOf), return it. On miss, build a per-surface compact
 * JSON context blob from the existing compute fns, call the model the
 * `analysisFactorNarrative` feature resolves to (tier token, lib/ai/models.ts),
 * UPSERT, and return. The stored `model_used` is the model that answered.
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
import { getDefaultBenchmark } from "@/lib/analysis/benchmarks";
import type { DefenseAnalysis, HedgeBadge, PairClassification } from "@/lib/compute/hedging";
import type { FactorHeatmapRow } from "@/lib/queries/analysis";
import { FACTOR_COLUMNS, FACTOR_LABELS, type FactorColumn } from "@/lib/factors";

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
  /**
   * The benchmark this prose was written against, when that is known: set on a
   * fresh factor-analysis generation, null on a cache read (the row stores no
   * benchmark; see `provenNarrativeBenchmark`) and for every other surface.
   */
  benchmark: string | null;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a portfolio analyst writing concise narrative prose. Output 2-3 sentences of plain English. Never include specific dollar amounts. Focus on what the data MEANS, not what it shows.`;

const SURFACE_PROMPTS: Record<NarrativeSurface, string> = {
  "factor-analysis":
    "Summarize the user's portfolio factor exposure in 2-3 sentences. Highlight the dominant tilts (Growth vs Value, AI exposure, Rate sensitivity, Cyclicality, etc.) and what they imply about the user's effective bet on the market regime. Avoid specific dollar amounts. Use plain English, no jargon. The marketRegression figures are measured against the benchmark named in the `benchmark` field: whenever you mention beta, alpha, R-squared, tracking error or correlation, name that benchmark (for example 'beta versus VTI').",
  "risk-metrics":
    "Summarize the portfolio's risk metrics in 2-3 sentences: drawdown profile, volatility, Sharpe, Herfindahl concentration. Note whether risk is concentrated in a few names or diversified. Avoid specific dollar amounts.",
  "position-risk":
    "In 2-3 sentences, identify which positions are driving the portfolio's risk. Mention the top 2-3 risk contributors by name and what makes them risky (size, beta, factor exposure). Avoid specific dollar amounts.",
  "factor-heatmap":
    "Read the heatmap of factor exposures across positions. The data summarises it per factor: each bucket's share of the book (weightPct, percent of total market value), how many positions sit in it and its largest names; `unclassified` is the share with no value for that factor, and `coverage` says how much of the book has any factor data. In 2-3 sentences, call out the most concentrated factor bucket and any surprising holes (e.g., zero crypto exposure, no defensive plays). Avoid specific dollar amounts.",
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
   * The top DEFENSE_TOP_EXPOSURES_N ranked exposures (membership only — no
   * ordinal rank; see the field-construction comment below), with identity +
   * the protection fields the prompt narrates about each one. Codex's first
   * finding: the prompt names the largest unprotected exposures, but the
   * fingerprint had no field covering them — selling/replacing a top exposure
   * left every hashed field unchanged while the cached prose still named the
   * exited position. Dollar exposure/notional are deliberately excluded
   * (portfolio noise the model is forbidden from quoting anyway).
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

  // Sliced to the same N the prompt's `topExposures` uses, from the same
  // rankedExposures the prompt reads. Deliberately NO ordinal rank field:
  // hedging.ts's ranking orders by exact dollar exposure with no tie-break,
  // so near-equal or tied positions can cross or swap order on a rerun with
  // zero economic change (Codex finding) — an ordinal `rank` would hash that
  // coin-flip as drift. canonicalJson already sorts array members by their
  // own serialized form, so this array's canonical shape is a deterministic
  // function of each exposure's identity + rounded fields, not of the input
  // order — a materially different ranking still surfaces through pctOfBook
  // (0.5pp grid) or through membership (a name entering/leaving the top N).
  const topExposures: DefenseFingerprintExposure[] = analysis.rankedExposures
    .slice(0, DEFENSE_TOP_EXPOSURES_N)
    .map((r) => ({
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

/**
 * The benchmark the factor-analysis narrative is regressed against: the same
 * per-scope default the Quantitative Factor Analysis card opens on
 * (`getDefaultBenchmark`). The prose used to be generated against SPY for
 * every scope while the tiles under it opened on VTI or QQQ, so it could
 * state "beta near 1" above a tile reading far lower. The symbol is part of
 * the prompt payload, so it is also part of the fingerprint.
 */
export function narrativeBenchmarkForScope(scope: string): string {
  return getDefaultBenchmark(scope);
}

/** What an empty surface hashes. One builder, so `provenNarrativeBenchmark`
 *  can recognise prose that was written over an empty book. */
function emptyFingerprintInput(surface: NarrativeSurface): { empty: NarrativeSurface } {
  return { empty: surface };
}

/**
 * The benchmark a CACHED narrative was written against, or null when that
 * cannot be shown.
 *
 * `analysis_narratives` has no benchmark column. The benchmark is part of the
 * factor prompt payload, though, so it is part of the stored fingerprint: a
 * stored fingerprint equal to the one computed from today's inputs proves the
 * prose was written against today's benchmark for this scope. Without that
 * proof (drifted, a legacy NULL, a failed compute) the answer is null, never a
 * guess: a row written before the benchmark joined the payload was regressed
 * against SPY whatever the scope. Null too for prose written over an empty
 * book (no regression was run) and for every surface but factor-analysis.
 *
 * Pure: no database read, no write, no model call.
 */
export function provenNarrativeBenchmark(
  scope: string,
  surfaceKey: string,
  storedFingerprint: string | null | undefined,
  currentFingerprint: string | null | undefined
): string | null {
  if (surfaceKey !== "factor-analysis") return null;
  if (storedFingerprint == null || currentFingerprint == null) return null;
  if (storedFingerprint !== currentFingerprint) return null;
  if (
    storedFingerprint ===
    fingerprintNarrativeInputs(surfaceKey, emptyFingerprintInput(surfaceKey))
  ) {
    return null;
  }
  return narrativeBenchmarkForScope(scope);
}

// ─── Factor-heatmap context (aggregates, not the per-position matrix) ────────

/**
 * How many names each heatmap bucket lists, largest first. Enough for the
 * model to name what drives a concentrated bucket; the full per-position
 * matrix (74k-83k characters on the two largest scopes, 2026-11-15) bought
 * nothing the prompt asks for.
 */
export const HEATMAP_TOP_NAMES_PER_BUCKET = 3;

export interface HeatmapBucketSummary {
  bucket: string;
  /** Share of the book in this bucket, percent of total market value (signed: a short reduces it). */
  weightPct: number;
  positions: number;
  /** The largest names by size (absolute weight), largest first. */
  topNames: Array<{ symbol: string; weightPct: number }>;
}

export interface HeatmapFactorSummary {
  factor: FactorColumn;
  label: string;
  /** Heaviest bucket first. */
  buckets: HeatmapBucketSummary[];
  /** Positions with no value for this factor. */
  unclassified: { weightPct: number; positions: number };
}

export interface FactorHeatmapContext {
  coverage: { positions: number; classified: number; classifiedWeightPct: number };
  factors: HeatmapFactorSummary[];
}

/**
 * The bucket a row shows in a heatmap column. MIRROR of the heatmap's
 * `growthValueCellValue` (app/dashboard/components/FactorHeatmap.tsx, a
 * "use client" file a server module must not import): a Blend-style security
 * reads "Blend" on Growth vs Value. Display only, as there.
 */
function heatmapCellValue(row: FactorHeatmapRow, col: FactorColumn): string | null {
  if (col === "growth_vs_value" && row.style && row.style.trim().toLowerCase() === "blend") {
    return "Blend";
  }
  const v = row[col];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function roundToStep(v: number, step: number): number {
  if (!Number.isFinite(v)) return 0;
  return Number((Math.round(v / step) * step).toFixed(2));
}

function weightOf(row: FactorHeatmapRow): number {
  return typeof row.weight_pct === "number" && Number.isFinite(row.weight_pct) ? row.weight_pct : 0;
}

/**
 * Per-factor bucket aggregates of the heatmap rows, with weights rounded to
 * `weightStep` percentage points. No dollar figure: weights are shares of the
 * book.
 */
function summariseHeatmap(rows: FactorHeatmapRow[], weightStep: number): FactorHeatmapContext {
  const classifiedRows = rows.filter((r) => FACTOR_COLUMNS.some((c) => heatmapCellValue(r, c) !== null));
  const factors: HeatmapFactorSummary[] = FACTOR_COLUMNS.map((factor) => {
    const groups = new Map<string, FactorHeatmapRow[]>();
    let unclassifiedWeight = 0;
    let unclassifiedPositions = 0;
    for (const r of rows) {
      const bucket = heatmapCellValue(r, factor);
      if (bucket === null) {
        unclassifiedWeight += weightOf(r);
        unclassifiedPositions++;
        continue;
      }
      const list = groups.get(bucket) ?? [];
      list.push(r);
      groups.set(bucket, list);
    }
    const buckets = [...groups.entries()]
      .map(([bucket, members]) => {
        const weight = members.reduce((a, r) => a + weightOf(r), 0);
        const topNames = [...members]
          .sort((a, b) => Math.abs(weightOf(b)) - Math.abs(weightOf(a)) || a.symbol.localeCompare(b.symbol))
          .slice(0, HEATMAP_TOP_NAMES_PER_BUCKET)
          .map((r) => ({ symbol: r.symbol, weightPct: roundToStep(weightOf(r), weightStep) }));
        return { bucket, weight, members: members.length, topNames };
      })
      .sort((a, b) => b.weight - a.weight || a.bucket.localeCompare(b.bucket))
      .map((b) => ({
        bucket: b.bucket,
        weightPct: roundToStep(b.weight, weightStep),
        positions: b.members,
        topNames: b.topNames,
      }));
    return {
      factor,
      label: FACTOR_LABELS[factor],
      buckets,
      unclassified: { weightPct: roundToStep(unclassifiedWeight, weightStep), positions: unclassifiedPositions },
    };
  });
  return {
    coverage: {
      positions: rows.length,
      classified: classifiedRows.length,
      classifiedWeightPct: roundToStep(
        classifiedRows.reduce((a, r) => a + weightOf(r), 0),
        weightStep,
      ),
    },
    factors,
  };
}

/** What the factor-heatmap prompt sees: weights to 0.1 percentage point. */
export function buildFactorHeatmapContext(rows: FactorHeatmapRow[]): FactorHeatmapContext {
  return summariseHeatmap(rows, 0.1);
}

/**
 * What the factor-heatmap fingerprint hashes: the SAME aggregates the prompt
 * sees, narrowed like the Defense surface's (weights on a 0.5pp grid), so price
 * noise does not read as drift while a material change does: a holding moving
 * to another bucket (bucket position counts), a name entering or leaving the
 * book (position counts, coverage), a change in a bucket's largest names, or
 * a bucket's weight moving half a point. The old fingerprint hashed every
 * row's dollar market value, so it drifted on every price tick.
 */
export function buildFactorHeatmapFingerprintInputs(rows: FactorHeatmapRow[]): FactorHeatmapContext {
  return summariseHeatmap(rows, 0.5);
}

interface SurfaceInputs {
  /** The JSON blob rendered into the prompt. */
  context: string;
  /** What the fingerprint hashes — the prompt inputs (narrowed, for defense). */
  fingerprintInput: unknown;
}

/**
 * Build a compact JSON context blob for the surface (no pretty-print
 * indentation: 20-27% smaller for the same facts, measured 2026-11-15), plus
 * the fingerprint input for that same context so the two can never drift
 * apart. Sizes measured on the real book 2026-11-15: factor-heatmap about
 * 5k-7k characters (was 74k-83k as the per-position matrix; it is now bounded
 * by factors x buckets x top names, not by the number of positions), the
 * other surfaces about 1.3k-10k.
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
    fingerprintInput: emptyFingerprintInput(surface),
  };

  if (surface === "factor-analysis") {
    const benchmark = narrativeBenchmarkForScope(scope);
    const result = computeFactorAnalysis(db, { accountIds, benchmarkSymbol: benchmark });
    if (!result) return empty;
    const payload = { benchmark, ...result };
    return { context: JSON.stringify(payload), fingerprintInput: payload };
  }

  if (surface === "risk-metrics") {
    const result = computeRiskMetrics(db, { accountIds });
    if (!result) return empty;
    return { context: JSON.stringify(result), fingerprintInput: result };
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
    return { context: JSON.stringify(payload), fingerprintInput: payload };
  }

  if (surface === "factor-heatmap") {
    const result = getFactorHeatmap(db, accountIds);
    if (!result || result.length === 0) return empty;
    // Aggregates, not the per-position matrix (see buildFactorHeatmapContext).
    return {
      context: JSON.stringify(buildFactorHeatmapContext(result)),
      fingerprintInput: buildFactorHeatmapFingerprintInputs(result),
    };
  }

  if (surface === "defense") {
    const result = computeDefenseAnalysis(db, accountIds);
    // MIRROR of the empty gate in app/dashboard/components/DefenseView.tsx —
    // the two must change together, or the page renders a full table while the
    // narrative claims there is nothing to assess. A written put carries long
    // delta, so it is neither shortExposure nor a scored hedge, but it is an
    // option position the analysis describes.
    const s = result.summary;
    if (
      s.hedgeCount === 0 &&
      s.shortExposure === 0 &&
      result.standaloneBets.length === 0 &&
      s.optionPositionCount === 0 &&
      s.shortPositionCount === 0
    ) {
      return empty;
    }
    const payload = {
      summary: result.summary,
      sectorCoverage: result.sectorCoverage,
      topExposures: result.rankedExposures.slice(0, DEFENSE_TOP_EXPOSURES_N),
      hedgeScores: result.hedgeScores.slice(0, 15),
      diagnostics: result.diagnostics,
    };
    return {
      context: JSON.stringify(payload),
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
        benchmark: null,
      };
    }
  }

  // 3. Build per-surface context AND the fingerprint of those same inputs, in
  // one pass — the prose and its freshness stamp must describe the identical
  // snapshot, so they can never be built from two different reads of the book.
  const { context, fingerprintInput } = buildSurfaceInputs(db, opts.scope, surface);
  const inputFingerprint = fingerprintNarrativeInputs(surface, fingerprintInput);

  // 4. Call the feature's model. Wrap in try/catch so the caller can
  // distinguish AI errors (network / rate-limit / auth) from validation
  // errors (unknown surface / truncated output / dollar leak).
  const surfacePrompt = SURFACE_PROMPTS[surface];
  const prompt = `${surfacePrompt}\n\nData (JSON):\n${context}`;

  let rawText: string;
  let answeredModelId: string | undefined;
  try {
    const result = await generateTextForFeature("analysisFactorNarrative", {
      system: SYSTEM_PROMPT,
      prompt,
      // Explicit cap (2026-11-12): the provider defaults a 5-generation id to
      // 4,096 output tokens, and default-on thinking counts against it.
      maxOutputTokens: 16_000,
    });
    if (result.finishReason === "length") {
      // A reply cut off at the cap is not a narrative; never cache it.
      throw new Error("narrative reply was cut off at the output cap");
    }
    rawText = result.text;
    answeredModelId = result.answeredModelId;
  } catch (err) {
    // No model family in the text (CLAUDE.md: never name a model in user
    // copy), and `cause` carries the provider's error so the route's
    // accountFailureOf can still tell an out-of-credit account from any
    // other failure.
    if (err instanceof AIRefusalError) {
      throw new Error(
        `narrative generation refused for ${opts.scope}/${opts.surfaceKey}`,
        { cause: err }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `narrative generation failed for ${opts.scope}/${opts.surfaceKey}: ${msg}`,
      { cause: err }
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

  // 5. UPSERT — modelUsed is the model that ANSWERED (the helper reports it,
  // so a failover run is labelled with the model that wrote the prose); the
  // resolved model is only the fallback when the helper reports none.
  const modelUsed =
    typeof answeredModelId === "string" && answeredModelId.length > 0
      ? answeredModelId
      : resolveFeatureModel("analysisFactorNarrative").modelId;
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
    // Just rendered from these inputs, so stored and current are the same.
    benchmark: provenNarrativeBenchmark(
      opts.scope,
      surface,
      inputFingerprint,
      inputFingerprint
    ),
  };
}
