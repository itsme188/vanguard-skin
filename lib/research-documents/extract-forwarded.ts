/**
 * Forwarded-content → research-document extraction (U6).
 *
 * Siblings to the PDF extractors in `extract.ts`, for the three other content
 * types a forwarded email can carry: a long-read text body, a screenshot
 * image (Claude vision), and a link (Claude web_fetch, with a plain-fetch +
 * sanitize fallback supplied by the caller). All return the same
 * `ExtractedResearchDocument` shape (metadata + raw_text) so the ingest
 * orchestrator can call `createResearchDocument` uniformly.
 *
 * The Claude call is injected (`deps.callClaude`) so unit tests stub it without
 * touching the network — same DI shape as level-scan / newsletter-fetch.
 */
import Anthropic from "@anthropic-ai/sdk";
import { resolveFeatureModel } from "@/lib/ai/models";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { classifyAnthropicError } from "@/lib/ai/classify-anthropic-error";
import {
  normalizeMetadata,
  parseClaudeResponse,
  ResearchPdfExtractionError,
  type ExtractedResearchDocument,
} from "./extract";

const FEATURE = "researchDocumentExtraction" as const;

const DOC_TYPE_LIST =
  "analyst_report | research_note | market_analysis | industry_primer | investor_letter | earnings_presentation | article | book_summary_or_essay | macro_note | other";

/** Metadata-only JSON contract shared by all forwarded extractors. */
const METADATA_JSON_SPEC = `Return ONE JSON object (no markdown fences, no preamble):
{
  "title": "<best title / headline>",
  "author": "<primary author, or null>",
  "source": "<publication / firm / site, or null>",
  "document_type": "<one of: ${DOC_TYPE_LIST}>",
  "publication_date": "YYYY-MM-DD" | null,
  "summary": "<1-5 paragraph summary, MAX 1500 chars, depth-proportional; substitutes for re-reading later. Do NOT hallucinate.>",
  "key_points": ["<every meaningful takeaway>"],
  "mentioned_symbols": ["AAPL", "..."],
  "suggested_tags": ["<3-8 lowercase theme/sector/style tags>"],
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed" | null,
  "target_prices": [{"symbol": "NVDA", "price": 1200, "horizon": "12mo"}]
}
Rules: real uppercase tickers only; explicit numeric targets only (else []); prefer null over guessing.`;

// Sentinel-delimited body — keeps the metadata JSON intact even if the body is
// truncated by the output-token limit (same format as the PDF path's parseClaudeResponse).
function rawTextInstruction(label: string): string {
  return `\n\nThen, AFTER the JSON object, output this exact line on its own:\n---RAW_TEXT_BEGIN---\nand after it, ${label} as plain text — no JSON, no code fences. Preserve paragraph breaks with blank lines.`;
}

const TEXT_PROMPT = `You are reading a piece of research/commentary a user forwarded to file for later. Extract structured metadata ONLY (the raw text is kept separately).\n\n${METADATA_JSON_SPEC}\n\nOutput ONLY the JSON object.`;
const IMAGE_PROMPT = `You are reading a screenshot a user forwarded to file for later (it may be a snippet of an article, chart, tweet, or note).\n\n${METADATA_JSON_SPEC}${rawTextInstruction("a faithful transcription of ALL visible text")}`;
function urlPrompt(url: string): string {
  return `Fetch and read this article the user forwarded to file for later: ${url}\n\nThen extract:\n\n${METADATA_JSON_SPEC}${rawTextInstruction("the COMPLETE article body")}`;
}

// ─── DI seam ─────────────────────────────────────────────────────

export type ClaudeBlock = Anthropic.MessageParam["content"];
export interface ForwardedExtractDeps {
  /** Run a single user-turn with the given content blocks + optional tools; return the text response. */
  callClaude: (args: {
    blocks: ClaudeBlock;
    tools?: Anthropic.Tool[] | unknown[];
    maxTokens: number;
  }) => Promise<string>;
  modelId: string;
}

function defaultDeps(): ForwardedExtractDeps {
  const { modelId } = resolveFeatureModel(FEATURE);
  const client = getRawAnthropicClient(FEATURE);
  return {
    modelId,
    callClaude: async ({ blocks, tools, maxTokens }) => {
      const stream = client.messages.stream({
        model: modelId,
        max_tokens: maxTokens,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: tools as any,
        messages: [{ role: "user", content: blocks }],
      });
      let response;
      try {
        response = await stream.finalMessage();
      } catch (err) {
        // Same boundary as lib/research-documents/extract.ts: an Anthropic
        // SDK APIError's .message embeds the raw JSON body (request_id +
        // internals). Classify it into a plain-language message HERE so the
        // background inbox path never logs/propagates the raw envelope.
        console.error("Forwarded-article extraction upstream error:", err);
        const classification = classifyAnthropicError(err);
        if (classification) {
          throw new ResearchPdfExtractionError(classification.userMessage, "");
        }
        throw err;
      }
      // With a server tool (web_fetch), the response carries multiple text
      // blocks — a pre-fetch preamble then the final answer. Take the LAST
      // text block, which is the model's final JSON output.
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      const last = textBlocks[textBlocks.length - 1];
      if (!last) {
        throw new ResearchPdfExtractionError(
          "Claude response contained no text block",
          JSON.stringify(response.content).slice(0, 200),
        );
      }
      return last.text;
    },
  };
}

// ─── Parsing ─────────────────────────────────────────────────────

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

// ─── Public extractors ───────────────────────────────────────────

/** A forwarded long-read body. raw_text is the input itself (no echo cost). */
export async function extractFromText(
  text: string,
  deps: ForwardedExtractDeps = defaultDeps(),
): Promise<ExtractedResearchDocument> {
  const raw = await deps.callClaude({
    blocks: [{ type: "text", text: `${TEXT_PROMPT}\n\n--- CONTENT ---\n${text.slice(0, 200_000)}` }],
    maxTokens: 8000,
  });
  const metadata = normalizeMetadata(JSON.parse(stripFences(extractJsonObject(raw))), deps.modelId);
  return { ...metadata, raw_text: text.trim() };
}

/** A forwarded screenshot. Claude vision → metadata + a transcription. */
export async function extractFromImage(
  imageBytes: Uint8Array,
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp",
  deps: ForwardedExtractDeps = defaultDeps(),
): Promise<ExtractedResearchDocument> {
  const base64 = Buffer.from(imageBytes).toString("base64");
  const raw = await deps.callClaude({
    blocks: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: IMAGE_PROMPT },
    ],
    maxTokens: 8000,
  });
  return parseClaudeResponse(raw, deps.modelId);
}

/** A forwarded link. Claude web_fetch → metadata + article body. */
export async function extractFromUrl(
  url: string,
  deps: ForwardedExtractDeps = defaultDeps(),
): Promise<ExtractedResearchDocument> {
  const raw = await deps.callClaude({
    blocks: [{ type: "text", text: urlPrompt(url) }],
    tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 }],
    maxTokens: 16000,
  });
  const doc = parseClaudeResponse(raw, deps.modelId);
  return { ...doc, source: doc.source ?? hostOf(url) };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Isolate the first {..last } JSON object so a prose preamble doesn't break parse. */
function extractJsonObject(raw: string): string {
  const s = stripFences(raw);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}
