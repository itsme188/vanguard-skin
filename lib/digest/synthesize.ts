/**
 * synthesize.ts — Cross-source synthesis composer for the evening email.
 *
 * Takes the per-company article buckets produced by group-by-company.ts and
 * uses Sonnet 4.6 (via Cloudflare AI Gateway) to write a narrative synthesis
 * that connects threads across sources.
 *
 * Output rules:
 *   - Must start with a `#` or `##` header.
 *   - 60–150 words per section.
 *   - Citations inline as [SourceName](url).
 *   - `## Also covered` closing section for thin coverage.
 */

import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";
import type { CompanyBucket } from "@/lib/digest/group-by-company";

// ─── Error class ─────────────────────────────────────────────────────────────

export class SynthesisEmptyError extends Error {
  constructor(reason: string) {
    super(`Synthesis returned no usable content: ${reason}`);
    this.name = "SynthesisEmptyError";
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SynthesisInput {
  /** Per-company article buckets from lib/digest/group-by-company.ts */
  buckets: CompanyBucket[];
  /** User's held tickers (from portfolio). */
  heldSymbols: string[];
  /** User's watchlist tickers. */
  watchlist: string[];
  /**
   * Today's anomaly flags — only symbol + company name are passed.
   * No $ amounts or position sizes (privacy rule).
   */
  anomalies: { symbol: string; companyName: string | null }[];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing newsletter coverage for a portfolio investor's day-end recap. Write one section per company/topic that surfaces what mattered TODAY across sources, with citations.

CRITICAL OUTPUT RULES:
- First character must be \`#\`. No preamble, no narration ("I'll now...", "Good, here is..."), no closing commentary.
- Use ## CompanyName as section headers (or ## Macro for the no-symbol bucket).
- Cite sources inline as [SourceName](url) — the SourceName link is mandatory whenever you reference any claim.
- Connect threads ACROSS sources where they exist. If only one source mentions something, say so ("Only Vital Knowledge flagged X today").
- Skip companies/topics with thin coverage (1 article, no portfolio relevance) — weave them into a closing "## Also covered" line at the end.
- 60-150 words per section. Skip if no meaningful synthesis is possible.
- DO NOT include P&L numbers, position sizes, or anything that would reveal what the user owns. Write as if for an analyst peer.`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

const NO_SYMBOL_BUCKET = "(no symbol)";

/**
 * Render one bucket to a compact markdown block for the user prompt.
 *
 *   ## NVDA (NVIDIA Corp)
 *   - Vital Knowledge (bullish) [https://...]: <summary>
 */
function renderBucket(bucket: CompanyBucket): string {
  const isNoSymbol = bucket.symbol === NO_SYMBOL_BUCKET;
  let heading: string;
  if (isNoSymbol) {
    heading = "## Macro";
  } else if (bucket.companyName) {
    heading = `## ${bucket.symbol} (${bucket.companyName})`;
  } else {
    heading = `## ${bucket.symbol}`;
  }

  const lines: string[] = [heading];
  for (const article of bucket.articles) {
    const sentiment = article.sentiment ?? "neutral";
    const url = article.source_url || article.website_url;
    const urlPart = url ? ` [${url}]` : "";
    const summaryText = article.summary ?? article.subject ?? "(no summary)";
    lines.push(`- ${article.source_name} (${sentiment})${urlPart}: ${summaryText}`);
  }

  return lines.join("\n");
}

/**
 * Build the full user prompt for the synthesis call.
 */
function buildSynthesisPrompt(input: SynthesisInput): string {
  const held =
    input.heldSymbols.length > 0 ? input.heldSymbols.join(", ") : "(none)";
  const watchlist =
    input.watchlist.length > 0 ? input.watchlist.join(", ") : "(none)";
  const anomalyList =
    input.anomalies.length > 0
      ? input.anomalies.map((a) => a.symbol).join(", ")
      : "(none)";

  const renderedBuckets = input.buckets
    .map(renderBucket)
    .join("\n\n");

  return [
    `Held tickers: ${held}`,
    `Watchlist: ${watchlist}`,
    `Today's anomaly flags: ${anomalyList}`,
    "",
    "Per-company buckets (today's articles only):",
    "",
    renderedBuckets,
    "",
    "Render the synthesis now.",
  ].join("\n");
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the cross-source synthesis pass using Sonnet 4.6.
 *
 * Throws `SynthesisEmptyError` when:
 *   - The model output was truncated (`finishReason === "length"`).
 *   - After preamble-stripping, the first non-empty line has no `#` header.
 *   - The cleaned text is under 200 characters.
 *
 * @throws SynthesisEmptyError
 */
export async function synthesize(input: SynthesisInput): Promise<string> {
  const model = getModelForFeature("dailyDigestSynthesis");
  const prompt = buildSynthesisPrompt(input);

  const result = await generateText({
    model,
    system: SYNTHESIS_SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: 4096,
  });

  // ── Validation ────────────────────────────────────────────────────────────

  // 1. Truncation guard — if the model ran out of tokens the output is incomplete.
  if (result.finishReason === "length") {
    throw new SynthesisEmptyError("output truncated by max tokens");
  }

  // 2. Strip any model preamble before structural validation.
  const stripped = stripModelPreamble(result.text);

  // 3. Strict header check.
  //    stripModelPreamble is pass-through when no markdown marker is found (it
  //    returns the full input with firstReal=0). For synthesis we require at
  //    least one `#` or `##` header as the first content line.
  const firstNonEmpty = stripped
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (!firstNonEmpty || !firstNonEmpty.trim().startsWith("#")) {
    throw new SynthesisEmptyError("output has no markdown headers");
  }

  // 4. Minimum length guard.
  if (stripped.length < 200) {
    throw new SynthesisEmptyError(
      `output too short (${stripped.length} chars)`,
    );
  }

  return stripped;
}
