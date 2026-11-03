/**
 * Read model for Settings → AI failover (design §7, slice 4): every feature
 * with whether it MAY fail over (the section 4 ceiling), whether it is
 * switched on, and its fallback list (the operator's, or the default order).
 * Pure over its inputs so the route and the tests share it.
 */
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { FEATURE_MODELS } from "@/lib/ai/models";
import { EARNINGS_PREP_FAILOVER_GROUP, FAILOVER_ELIGIBLE_CEILING } from "@/lib/ai/failover";

export interface FailoverFeatureRow {
  key: FeatureKey;
  /** Inside the section 4 ceiling. False rows get no controls. */
  eligible: boolean;
  /** Plain-English reason a parked feature stays parked; null when eligible. */
  parkedReason: string | null;
  enabled: boolean;
  /** The operator's ordered list, or null for the default order. */
  fallbacks: string[] | null;
  /** What the default order is for this feature's tier ("openai/$workhorse", ...). */
  defaultFallbacks: string[];
}

export interface FailoverView {
  features: FailoverFeatureRow[];
  group: { key: "earningsPrep"; label: string; features: FeatureKey[]; allEnabled: boolean };
}

const PARKED_REASON: Partial<Record<FeatureKey, string>> = {
  scheduleVerification: "Uses Claude's built-in web search; stays on Anthropic",
  earningsPreview: "Uses Claude's built-in web search; stays on Anthropic",
  earningsRecap: "Uses Claude's built-in web search; stays on Anthropic",
  etfSectorWeights: "Uses Claude's built-in web search; stays on Anthropic",
  earningsBogeysExtraction: "Reads a PDF directly; stays on Anthropic until the PDF path is proven",
  pdfParsing: "Reads a PDF directly; stays on Anthropic until the PDF path is proven",
  researchDocumentExtraction: "Reads a PDF directly; stays on Anthropic until the PDF path is proven",
  armedBogeyDeepRead: "Reads a PDF directly; stays on Anthropic until the PDF path is proven",
  alertSuggestion: "Already runs on the Cloudflare route; nowhere further to fall",
};

const TIER_TOKEN = /^[^/]+\/(\$(?:frontier|workhorse|cheap))$/;

function defaultFallbacksFor(key: FeatureKey): string[] {
  const token = TIER_TOKEN.exec(FEATURE_MODELS[key])?.[1];
  return token ? [`openai/${token}`, `workers-ai/${token}`] : [];
}

export function buildFailoverView(
  enabled: readonly string[],
  fallbacks: Readonly<Record<string, readonly string[]>>,
): FailoverView {
  const on = new Set(enabled);
  const features = (Object.keys(FEATURE_MODELS) as FeatureKey[]).map((key): FailoverFeatureRow => {
    const eligible = FAILOVER_ELIGIBLE_CEILING.has(key);
    return {
      key,
      eligible,
      parkedReason: eligible ? null : (PARKED_REASON[key] ?? "Stays on its own provider"),
      // A parked feature reads as OFF whatever a stored row says.
      enabled: eligible && on.has(key),
      fallbacks: eligible && fallbacks[key] ? [...fallbacks[key]] : null,
      defaultFallbacks: eligible ? defaultFallbacksFor(key) : [],
    };
  });
  return {
    features,
    group: {
      key: "earningsPrep",
      label: "Earnings print prep",
      features: [...EARNINGS_PREP_FAILOVER_GROUP],
      allEnabled: EARNINGS_PREP_FAILOVER_GROUP.every((k) => on.has(k)),
    },
  };
}
