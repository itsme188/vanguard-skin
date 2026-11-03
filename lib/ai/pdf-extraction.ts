/**
 * The provider-neutral PDF seam (provider-failover design slice 3, §5:
 * docs/superpowers/specs/2026-11-02-provider-failover-design.md).
 *
 *   extractFromPdf({ feature, pdfBytes, schema, prompt }) -> { text, provider, modelId }
 *
 * Two implementations, one result shape:
 *   - anthropic: the raw `@anthropic-ai/sdk` streaming call with a native
 *     `document` block — the same request the live bogey path makes today
 *     (extractBogeysFromUpload). The live path itself is NOT rewired to this
 *     module; the primary stays exactly as it was (CLAUDE.md lists the PDF
 *     parsing integration under "What NOT to change").
 *   - openai: the AI SDK `generateObject` with a `file` content part (base64
 *     PDF) at the feature's TIER, from the static table in model-tiers.ts. The
 *     Responses API reads both the text and the page images of the PDF, the
 *     same dual signal Claude's document block gives (design §5).
 * Both return the model's JSON as TEXT so the caller's one existing parser
 * stays the single definition of "what a bogey is" — that is what makes the
 * §8 figure-parity comparison meaningful.
 *
 * The Cloudflare route cannot take a PDF (no document input on the compat
 * endpoint), so PDF failover is anthropic -> openai ONLY and parks when both
 * are down (design §5).
 *
 * ROLLOUT. Same discipline as the general executor (lib/ai/failover.ts): the
 * seam ships DISABLED. `PDF_FAILOVER_ENABLED_DEFAULT` is empty, so
 * `extractFromPdfWithFailover` behaves exactly like the primary until a
 * feature passes the §8 parity gate (scripts/failover-pdf-parity.ts) and is
 * added deliberately.
 *
 * lib/ai imports no db: the switch goes through the recorder seam in
 * failover.ts, as in slice 2.
 */
import { APIError } from "@anthropic-ai/sdk";
import { generateObject, jsonSchema, NoObjectGeneratedError } from "ai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { FEATURE_MODELS, resolveFeatureModel, type ResolvedModel } from "@/lib/ai/models";
import { resolveProviderTierModel, type Tier } from "@/lib/ai/model-tiers";
import { getModelForResolved, getRawAnthropicClient } from "@/lib/ai/provider";
import { classifyAnthropicError } from "@/lib/ai/classify-anthropic-error";
import { failoverTriggerKind, noteFailover, type FailoverTriggerKind } from "@/lib/ai/failover";

export type PdfProvider = "anthropic" | "openai";

export interface PdfExtractionRequest {
  feature: FeatureKey;
  pdfBytes: Uint8Array;
  /** JSON Schema of the OBJECT the model must return (OpenAI structured output needs an object root). */
  schema: Record<string, unknown>;
  prompt: string;
  /** Output token budget; the bogey sheet needs 16k (2026-08-05 truncation). */
  maxOutputTokens?: number;
}

export interface PdfExtractionResult {
  /** The model's JSON, as text. */
  text: string;
  provider: PdfProvider;
  modelId: string;
}

/** The model hit its output budget: the JSON is incomplete. Never retried across providers. */
export class PdfExtractionTruncatedError extends Error {
  constructor(public provider: PdfProvider, public modelId: string) {
    super(`PDF extraction truncated at the output limit (${provider} ${modelId})`);
    this.name = "PdfExtractionTruncatedError";
  }
}

/** The model returned nothing to parse. */
export class PdfExtractionEmptyError extends Error {
  constructor(public provider: PdfProvider, public modelId: string) {
    super(`PDF extraction returned no text (${provider} ${modelId})`);
    this.name = "PdfExtractionEmptyError";
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

// ── Anthropic: today's raw path ──────────────────────────────────────

export async function extractFromPdfAnthropic(req: PdfExtractionRequest): Promise<PdfExtractionResult> {
  const { modelId } = resolveFeatureModel(req.feature);
  const client = getRawAnthropicClient(req.feature);
  const stream = client.messages.stream({
    model: modelId,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf" as const,
              data: Buffer.from(req.pdfBytes).toString("base64"),
            },
          },
          { type: "text", text: req.prompt },
        ],
      },
    ],
  });
  const response = await stream.finalMessage();
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text" || block.text.trim() === "") {
    throw new PdfExtractionEmptyError("anthropic", modelId);
  }
  if (response.stop_reason === "max_tokens") throw new PdfExtractionTruncatedError("anthropic", modelId);
  return { text: block.text, provider: "anthropic", modelId };
}

// ── OpenAI: a file part at the feature's tier ────────────────────────

const TIER_BY_TOKEN: Record<string, Tier> = { $frontier: "frontier", $workhorse: "workhorse", $cheap: "cheap" };

/** The OpenAI model for a feature: the static tier table at the feature's code-default tier. */
export function openAiTargetFor(feature: FeatureKey): ResolvedModel | null {
  const spec = FEATURE_MODELS[feature];
  const tier = TIER_BY_TOKEN[spec.slice(spec.indexOf("/") + 1)];
  if (!tier) return null;
  const modelId = resolveProviderTierModel("openai", tier);
  return modelId ? { provider: "openai", modelId } : null;
}

export async function extractFromPdfOpenAI(req: PdfExtractionRequest): Promise<PdfExtractionResult> {
  const target = openAiTargetFor(req.feature);
  if (!target) throw new Error(`No OpenAI tier mapping for feature "${req.feature}"`);
  // Throws "OPENAI_API_KEY is required..." when unconfigured: the executor treats that as an inert leg.
  const model = getModelForResolved(req.feature, target);
  try {
    const res = await generateObject({
      model,
      schema: jsonSchema(req.schema),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: req.pdfBytes, mediaType: "application/pdf", filename: "bogeys.pdf" },
            { type: "text", text: req.prompt },
          ],
        },
      ],
      maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // The bogey object carries a free-keyed segment map, which strict mode cannot express.
      providerOptions: { openai: { strictJsonSchema: false } },
    });
    if (res.finishReason === "length") throw new PdfExtractionTruncatedError("openai", target.modelId);
    return { text: JSON.stringify(res.object), provider: "openai", modelId: target.modelId };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err) && err.finishReason === "length") {
      throw new PdfExtractionTruncatedError("openai", target.modelId);
    }
    throw err;
  }
}

// ── Failover (anthropic -> openai only) ──────────────────────────────

/** Features that may ever use the PDF seam's failover (design §4/§5): bogey extraction first. */
export const PDF_FAILOVER_CEILING: ReadonlySet<FeatureKey> = new Set<FeatureKey>(["earningsBogeysExtraction"]);

/**
 * The PDF rollout: EMPTY until the feature passes the §8 parity gate. The other
 * raw-SDK PDF features (pdfParsing, researchDocumentExtraction,
 * armedBogeyDeepRead) are not in the ceiling and stay parked.
 */
export const PDF_FAILOVER_ENABLED_DEFAULT: ReadonlySet<FeatureKey> = new Set<FeatureKey>();

let enabledSource: (() => ReadonlySet<FeatureKey>) | null = null;

/** Inject the PDF rollout set (tests; a later settings reader). null restores the default. */
export function setPdfFailoverEnabledSource(fn: (() => ReadonlySet<FeatureKey>) | null): void {
  enabledSource = fn;
}

export function isPdfFailoverEnabled(feature: FeatureKey): boolean {
  if (!PDF_FAILOVER_CEILING.has(feature)) return false;
  return (enabledSource ? enabledSource() : PDF_FAILOVER_ENABLED_DEFAULT).has(feature);
}

/**
 * The switch-triggering kind of an error from EITHER leg: a raw
 * `@anthropic-ai/sdk` APIError (billing / auth), or an AI SDK / plain error the
 * shared classifier reads (OpenAI codes, a missing key = config).
 */
export function pdfFailoverTriggerKind(err: unknown): FailoverTriggerKind | null {
  if (err instanceof APIError) {
    const kind = classifyAnthropicError(err)?.kind;
    return kind === "billing" || kind === "auth" ? kind : null;
  }
  return failoverTriggerKind(err);
}

/** Primary (Anthropic raw) first; on a billing/auth/config failure of an enabled feature, OpenAI once. */
export async function extractFromPdfWithFailover(
  req: PdfExtractionRequest,
  legs: {
    anthropic: (r: PdfExtractionRequest) => Promise<PdfExtractionResult>;
    openai: (r: PdfExtractionRequest) => Promise<PdfExtractionResult>;
  } = { anthropic: extractFromPdfAnthropic, openai: extractFromPdfOpenAI },
): Promise<PdfExtractionResult> {
  try {
    return await legs.anthropic(req);
  } catch (primaryErr) {
    if (!isPdfFailoverEnabled(req.feature)) throw primaryErr;
    const kind = pdfFailoverTriggerKind(primaryErr);
    if (!kind) throw primaryErr;
    const from = resolveFeatureModel(req.feature);
    // Skip an unconfigured leg without calling it.
    const target = openAiTargetFor(req.feature);
    if (!target) throw primaryErr;
    try {
      getModelForResolved(req.feature, target);
    } catch {
      console.warn(`[ai] ${req.feature}: openai PDF fallback not configured — skipped`);
      throw primaryErr;
    }
    try {
      const result = await legs.openai(req);
      noteFailover({ feature: req.feature, from, to: target, kind, at: new Date().toISOString() });
      return result;
    } catch (legErr) {
      console.warn(
        `[ai] ${req.feature}: openai PDF fallback failed (${pdfFailoverTriggerKind(legErr) ? "account" : "request-level"}) — parking on the original failure`,
      );
      throw primaryErr;
    }
  }
}
