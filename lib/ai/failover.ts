/**
 * Provider failover executor (provider-failover design slice 2, 2026-11-02:
 * docs/superpowers/specs/2026-11-02-provider-failover-design.md §4, §8, §9).
 *
 * When a failover-ENABLED feature's call fails with an account-level
 * classification on its primary provider — billing, auth or config, per the
 * shared classifier (lib/gmail/enrichment-failure.ts) — the call is retried on
 * the next provider in the fixed order anthropic → openai → workers-ai (the
 * Cloudflare AI Gateway compat route), each leg at most once, at the SAME
 * tier the feature asks for (the per-provider tables in lib/ai/model-tiers.ts).
 *
 * What does NOT switch providers:
 *   - rate_limit / outage / network: those keep today's wait-and-retry on the
 *     same provider (design §4);
 *   - article-level errors (refusal, malformed output, bad request, unknown);
 *   - any feature outside the rollout set (see below), including the parked
 *     ones: native web_search features and raw-SDK PDF features never reach
 *     this module at all (they do not call the lib/ai wrappers' failover path
 *     or are not in the ceiling).
 *
 * If no leg serves the call, the PRIMARY provider's original error is
 * rethrown untouched, so callers park/count exactly as before (the prepare
 * pipeline reads it through accountFailureOf; nothing here spends an attempt).
 * A leg whose provider is not configured (no key, no gateway) is skipped:
 * it is inert, never an error.
 *
 * ROLLOUT (owner directive 2026-11-03: "make it automatic"). Every feature
 * inside the ceiling is failover-ENABLED BY DEFAULT; the owner can switch one
 * off (an explicit opt-out, Settings -> AI failover) and that stays off. The
 * ceiling bounds it either way: a parked feature never fails over whatever the
 * defaults or the saved settings say. Earlier slices shipped with an empty
 * rollout pending the section 8 parity runs; this supersedes that for the
 * ceiling features, by the owner's decision. The PDF seam keeps its own gate
 * (lib/ai/pdf-extraction.ts), unchanged.
 *
 * lib/ai imports no db: the switch is reported through an injected recorder
 * (lib/db.ts registers the SQLite-backed one), the same seam shape as
 * override-source.ts.
 */
import { APIError } from "@anthropic-ai/sdk";
import type { LanguageModel } from "ai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { FEATURE_MODELS, expandSpec, resolveFeatureModel, type ResolvedModel } from "@/lib/ai/models";
import { resolveProviderTierModel, type Tier } from "@/lib/ai/model-tiers";
import { getModelForResolved } from "@/lib/ai/provider";
import { classifyEnrichmentError } from "@/lib/gmail/enrichment-failure";
import { classifyAnthropicError } from "@/lib/ai/classify-anthropic-error";

export type FailoverProvider = ResolvedModel["provider"];

/** Fixed fallback order (design §1). A feature only falls to providers AFTER its primary. */
export const PROVIDER_ORDER: readonly FailoverProvider[] = ["anthropic", "openai", "workers-ai"];

/** Design §4 "auto-failover eligible": the ceiling of what may ever be enabled. */
export const FAILOVER_ELIGIBLE_CEILING: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  "chat",
  "dailyDigestSynthesis",
  "overnightCommentary",
  "briefing",
  "tradeReviewMain",
  "tradeReviewMainLarge",
  "tradeReviewQA",
  "newsletterLevelExtraction",
  "newsletterProcessing",
  "factorClassification",
  "securityClassification",
  "sectorVerification",
  "analysisFactorNarrative",
  "analysisMacroThemes",
  "macroEnrichment",
  "filingSectionExtraction",
  "researchMentionVerification",
  "suggestedLevelNarrative",
  "earningsDateVerification",
  "transcriptSummary",
  "earningsDebrief",
  "printWatchFirstPass",
  "printFilingSummary",
  "newsletterBogeyExtraction",
  // Un-parked 2026-11-03 (owner directive): the earnings preview/recap compose
  // (email AND the in-app recap modal) carries Claude's native web search, so it
  // fails over through the raw-search hand-off, to a leg with a search tool only.
  "earningsPreview",
  "earningsRecap",
]);

/**
 * Design §4 "stay parked": native web_search features, raw-SDK PDF features,
 * and the Cloudflare-leg feature (last resort, nowhere further to fall).
 * Listed so a test can pin that none of them is ever in the ceiling.
 */
export const FAILOVER_PARKED: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  "scheduleVerification",
  "etfSectorWeights",
  "earningsBogeysExtraction",
  "pdfParsing",
  "researchDocumentExtraction",
  "armedBogeyDeepRead",
  "alertSuggestion",
]);

let enabledSource: (() => ReadonlySet<FeatureKey>) | null = null;
let disabledSource: (() => ReadonlySet<FeatureKey>) | null = null;

/**
 * Inject the COMPLETE effective set (tests, or a context that wants a fixed
 * rollout). When registered it decides alone: a feature is on only if it is in
 * the set. null restores the default-on rule below.
 */
export function setFailoverEnabledSource(fn: (() => ReadonlySet<FeatureKey>) | null): void {
  enabledSource = fn;
}

/**
 * Inject the owner's explicit opt-outs (lib/db.ts registers the settings-backed
 * reader). A feature in this set stays off whatever the default says.
 */
export function setFailoverDisabledSource(fn: (() => ReadonlySet<FeatureKey>) | null): void {
  disabledSource = fn;
}

/** On by default inside the ceiling; off when outside it or explicitly disabled. */
export function isFailoverEnabled(feature: FeatureKey): boolean {
  if (!FAILOVER_ELIGIBLE_CEILING.has(feature)) return false;
  if (enabledSource) return enabledSource().has(feature);
  return !(disabledSource?.().has(feature) ?? false);
}

/**
 * The earnings print-prep features the settings UX can switch as ONE group
 * (design §7 "one-click group toggle"). Every member is inside the ceiling;
 * the preview/recap web_search features are deliberately absent (parked).
 */
export const EARNINGS_PREP_FAILOVER_GROUP: readonly FeatureKey[] = [
  "newsletterBogeyExtraction",
  "printWatchFirstPass",
  "printFilingSummary",
  "transcriptSummary",
  "earningsDebrief",
  "earningsDateVerification",
];

let fallbackSource: (() => Readonly<Record<string, readonly string[]>>) | null = null;

/**
 * Inject the per-feature ordered fallback lists (feature -> provider-qualified
 * specs, e.g. ["openai/$workhorse"]). lib/db.ts registers the settings-backed
 * reader; null (and an absent feature) means the default order.
 */
export function setFailoverFallbackSource(
  fn: (() => Readonly<Record<string, readonly string[]>>) | null,
): void {
  fallbackSource = fn;
}

/** The failure kinds that switch providers (design §4). */
export type FailoverTriggerKind = "billing" | "auth" | "config";
const TRIGGER_KINDS: ReadonlySet<string> = new Set<FailoverTriggerKind>(["billing", "auth", "config"]);

/** The switch-triggering kind of a caught error, or null (rate limit, outage, article-level, unknown...). */
export function failoverTriggerKind(err: unknown): FailoverTriggerKind | null {
  // A raw `@anthropic-ai/sdk` APIError (the raw-client call sites): the shared raw
  // classifier decides, and only billing / auth switch. Rate limits, overloads and
  // content errors stay with the primary, exactly as for the AI SDK errors below.
  if (err instanceof APIError) {
    const kind = classifyAnthropicError(err)?.kind;
    return kind === "billing" || kind === "auth" ? kind : null;
  }
  const c = classifyEnrichmentError(err);
  return c.scope === "account" && TRIGGER_KINDS.has(c.kind) ? (c.kind as FailoverTriggerKind) : null;
}

const TIER_BY_TOKEN: Record<string, Tier> = {
  $frontier: "frontier",
  $workhorse: "workhorse",
  $cheap: "cheap",
};

/** The tier a feature asks for, from its code default (an override to a concrete id keeps the default's tier). */
function tierOf(feature: FeatureKey): Tier | null {
  const spec = FEATURE_MODELS[feature];
  const slash = spec.indexOf("/");
  return slash === -1 ? null : (TIER_BY_TOKEN[spec.slice(slash + 1)] ?? null);
}

/** The fallback legs for a feature, in order: later providers than its primary, at the same tier. */
export function failoverTargets(feature: FeatureKey): ResolvedModel[] {
  const listed = configuredTargets(feature);
  if (listed) return listed;
  const tier = tierOf(feature);
  if (!tier) return [];
  const primaryIndex = PROVIDER_ORDER.indexOf(resolveFeatureModel(feature).provider);
  const targets: ResolvedModel[] = [];
  for (const provider of PROVIDER_ORDER.slice(primaryIndex + 1)) {
    const modelId = resolveProviderTierModel(provider, tier);
    if (modelId) targets.push({ provider, modelId });
  }
  return targets;
}

/**
 * The operator's ordered list for a feature (Settings → AI failover), expanded
 * per provider exactly like a model override. An entry that no longer parses,
 * or names the feature's own primary provider, is dropped; an empty result
 * falls back to the default order (null).
 */
function configuredTargets(feature: FeatureKey): ResolvedModel[] | null {
  const specs = fallbackSource?.()[feature];
  if (!specs || specs.length === 0) return null;
  const primary = resolveFeatureModel(feature).provider;
  const out: ResolvedModel[] = [];
  for (const spec of specs) {
    let target: ResolvedModel;
    try {
      target = expandSpec(spec);
    } catch {
      continue;
    }
    if (target.provider === primary || out.some((t) => t.provider === target.provider)) continue;
    out.push(target);
  }
  return out.length > 0 ? out : null;
}

// ── The record of a switch ───────────────────────────────────────────

export interface FailoverEvent {
  feature: FeatureKey;
  /** The primary that failed. */
  from: ResolvedModel;
  /** The leg that served the call. */
  to: ResolvedModel;
  kind: FailoverTriggerKind;
  /** ISO UTC. */
  at: string;
}

let recorder: ((event: FailoverEvent) => void) | null = null;

/** Register (or clear, with null) the durable recorder. lib/db.ts registers it at singleton creation. */
export function setFailoverRecorder(fn: ((event: FailoverEvent) => void) | null): void {
  recorder = fn;
}

/** Log + durably note a served switch (also used by the PDF seam, lib/ai/pdf-extraction.ts). */
export function noteFailover(event: FailoverEvent): void {
  console.warn(
    `[ai] ${event.feature}: ${event.from.provider} account failure (${event.kind}) → served by ` +
      `${event.to.provider} (${event.to.modelId})`,
  );
  try {
    recorder?.(event);
  } catch (err) {
    // Recording is a note for the operator; it must never fail the call that was served.
    console.warn(`[ai] failover record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── The executor ─────────────────────────────────────────────────────

/**
 * Called by a wrapper after its PRIMARY attempt threw `primaryErr`. Returns
 * the result of the first fallback leg that serves the call, or rethrows
 * `primaryErr` (never a fallback's error) when none does.
 *
 * `run` makes the actual call on the model it is handed; it does the same
 * post-processing the primary path does (e.g. the refusal check).
 */
export async function failOverOnAccountFailure<T>(
  feature: FeatureKey,
  primaryErr: unknown,
  run: (model: LanguageModel, target: ResolvedModel) => Promise<T>,
  opts: {
    /**
     * Skip legs that cannot honour the call (e.g. a web-search call can only run on a
     * provider that has a search tool). A skipped leg is never built or called.
     */
    accepts?: (target: ResolvedModel) => boolean;
  } = {},
): Promise<T> {
  if (!isFailoverEnabled(feature)) throw primaryErr;
  const kind = failoverTriggerKind(primaryErr);
  if (!kind) throw primaryErr;
  const from = resolveFeatureModel(feature);
  for (const target of failoverTargets(feature)) {
    if (opts.accepts && !opts.accepts(target)) continue;
    let model: LanguageModel;
    try {
      model = getModelForResolved(feature, target);
    } catch {
      // Not configured (no key / no gateway): the leg is inert.
      console.warn(`[ai] ${feature}: ${target.provider} fallback not configured — skipped`);
      continue;
    }
    try {
      const result = await run(model, target);
      noteFailover({ feature, from, to: target, kind, at: new Date().toISOString() });
      return result;
    } catch (legErr) {
      const legKind = failoverTriggerKind(legErr);
      console.warn(
        `[ai] ${feature}: ${target.provider} fallback failed (${legKind ? `account ${legKind}` : "request-level"})` +
          (legKind ? " — trying the next provider" : " — parking on the original failure"),
      );
      // A request-level failure on a leg ends the chain: the account problem is real and
      // the call is parked as today. Only another account failure moves on.
      if (!legKind) break;
    }
  }
  throw primaryErr;
}
