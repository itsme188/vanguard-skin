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
 * ROLLOUT. Design §8: "the list is the ceiling, not the rollout" — a feature
 * becomes enabled only after parity validation and a shadow cycle. The
 * executor ships with an EMPTY rollout set, so no live path changes until a
 * feature is deliberately added to FAILOVER_ENABLED_DEFAULT (first candidate
 * per §8.5: newsletterProcessing). The ceiling bounds it either way.
 *
 * lib/ai imports no db: the switch is reported through an injected recorder
 * (lib/db.ts registers the SQLite-backed one), the same seam shape as
 * override-source.ts.
 */
import type { LanguageModel } from "ai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { FEATURE_MODELS, resolveFeatureModel, type ResolvedModel } from "@/lib/ai/models";
import { resolveProviderTierModel, type Tier } from "@/lib/ai/model-tiers";
import { getModelForResolved } from "@/lib/ai/provider";
import { classifyEnrichmentError } from "@/lib/gmail/enrichment-failure";

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
]);

/**
 * Design §4 "stay parked": native web_search features, raw-SDK PDF features,
 * and the Cloudflare-leg feature (last resort, nowhere further to fall).
 * Listed so a test can pin that none of them is ever in the ceiling.
 */
export const FAILOVER_PARKED: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  "scheduleVerification",
  "earningsPreview",
  "earningsRecap",
  "etfSectorWeights",
  "earningsBogeysExtraction",
  "pdfParsing",
  "researchDocumentExtraction",
  "armedBogeyDeepRead",
  "alertSuggestion",
]);

/**
 * The rollout: features whose failover is switched ON. Empty until a feature
 * passes the design §8 parity gate (golden inputs, figure parity, shadow
 * cycle). Adding a name here is the whole "flip"; names outside the ceiling
 * are ignored.
 */
export const FAILOVER_ENABLED_DEFAULT: ReadonlySet<FeatureKey> = new Set<FeatureKey>();

let enabledSource: (() => ReadonlySet<FeatureKey>) | null = null;

/** Inject the rollout set (tests; the slice-4 settings reader). null restores the default. */
export function setFailoverEnabledSource(fn: (() => ReadonlySet<FeatureKey>) | null): void {
  enabledSource = fn;
}

export function isFailoverEnabled(feature: FeatureKey): boolean {
  if (!FAILOVER_ELIGIBLE_CEILING.has(feature)) return false;
  return (enabledSource ? enabledSource() : FAILOVER_ENABLED_DEFAULT).has(feature);
}

/** The failure kinds that switch providers (design §4). */
export type FailoverTriggerKind = "billing" | "auth" | "config";
const TRIGGER_KINDS: ReadonlySet<string> = new Set<FailoverTriggerKind>(["billing", "auth", "config"]);

/** The switch-triggering kind of a caught error, or null (rate limit, outage, article-level, unknown...). */
export function failoverTriggerKind(err: unknown): FailoverTriggerKind | null {
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

function record(event: FailoverEvent): void {
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
): Promise<T> {
  if (!isFailoverEnabled(feature)) throw primaryErr;
  const kind = failoverTriggerKind(primaryErr);
  if (!kind) throw primaryErr;
  const from = resolveFeatureModel(feature);
  for (const target of failoverTargets(feature)) {
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
      record({ feature, from, to: target, kind, at: new Date().toISOString() });
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
