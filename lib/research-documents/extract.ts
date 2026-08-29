/**
 * Research PDF → structured metadata + raw text via Claude.
 *
 * Architecture: TWO calls run in parallel for better UX.
 *   1. extractResearchMetadata — small output (~2K tokens), fast (~30-60s).
 *      Returns title / author / source / type / summary / tags / symbols /
 *      sentiment / targets. No raw body.
 *   2. extractResearchRawText — large output (~10-30K tokens), slow (~2-4m).
 *      Returns the full plain-text body of the document.
 *
 * The POST route awaits metadata, inserts a row with processing_state=
 * 'pending_body' + placeholder raw_text, responds to the client fast, and
 * updates the row in the background when raw_text resolves.
 *
 * Design notes:
 *   - Uses getRawAnthropicClient so we can pass the PDF as a document content
 *     block (native Anthropic PDF support).
 *   - 32 MB PDF cap matches Anthropic's hard limit.
 *   - Both calls stream (via .stream().finalMessage()) so the SDK's long-
 *     request guard doesn't reject big max_tokens values.
 */

import { resolveFeatureModel } from "@/lib/ai/models";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { classifyAnthropicError } from "@/lib/ai/classify-anthropic-error";

export const RESEARCH_DOC_PDF_MAX_BYTES = 32 * 1024 * 1024; // 32 MB

export type ResearchDocumentType =
  | "analyst_report"
  | "research_note"
  | "market_analysis"
  | "industry_primer"
  | "investor_letter"
  | "earnings_presentation"
  | "article"
  | "book_summary_or_essay"
  | "macro_note"
  | "other";

export type ResearchDocumentSentiment =
  | "bullish"
  | "bearish"
  | "neutral"
  | "mixed";

export interface ExtractedResearchMetadata {
  title: string;
  author: string | null;
  source: string | null;
  document_type: ResearchDocumentType;
  publication_date: string | null; // YYYY-MM-DD
  summary: string | null;
  key_points: string[];
  mentioned_symbols: string[]; // uppercase tickers
  tags: string[]; // lowercase thematic tags
  sentiment: ResearchDocumentSentiment | null;
  target_prices: Array<{ symbol: string; price: number; horizon?: string }>;
  ai_model: string;
}

// Backward-compat alias: tests + callers that want both metadata + raw_text.
export interface ExtractedResearchDocument extends ExtractedResearchMetadata {
  raw_text: string;
}

// ─── Errors ──────────────────────────────────────────────────────

export class ResearchPdfTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `PDF is ${(bytes / (1024 * 1024)).toFixed(1)} MB; exceeds the ${(
        RESEARCH_DOC_PDF_MAX_BYTES /
        (1024 * 1024)
      ).toFixed(0)} MB limit.`,
    );
    this.name = "ResearchPdfTooLargeError";
  }
}

export class ResearchPdfExtractionError extends Error {
  public readonly rawSnippet: string;
  constructor(message: string, rawSnippet: string) {
    super(message);
    this.name = "ResearchPdfExtractionError";
    this.rawSnippet = rawSnippet;
  }
}

// ─── Prompts ─────────────────────────────────────────────────────

const METADATA_PROMPT = `You are reading a research PDF. It may be any of:
  - analyst_report: sell-side / buy-side equity research (Goldman, Morgan Stanley, Bernstein, etc.)
  - research_note: shorter thematic or event-driven note from a research shop
  - market_analysis: cross-asset or market-structure commentary
  - industry_primer: sector / industry deep dive (often 50-200 pages, historical)
  - investor_letter: quarterly / annual fund commentary (Ackman, Lead Edge, Bireme, Artemis, etc.)
  - earnings_presentation: corporate IR deck or earnings call slides
  - article: long-form journalism or magazine piece saved as PDF (The Information, Bloomberg, WSJ feature, n+1 essay)
  - book_summary_or_essay: book chapter summary, evergreen essay, framework piece
  - macro_note: macro / monetary-policy / long-duration framework (10-year market outlook, cycle analyses)
  - other: anything that doesn't fit

Extract structured metadata ONLY. Do NOT extract the full document body — a separate call handles that.

Return a single JSON object (no markdown fences, no preamble, no explanation):

{
  "title": "<best document title from cover/header; for articles, the headline; for investor letters, include firm + quarter>",
  "author": "<primary author name, or null>",
  "source": "<firm / publication / fund — e.g. 'Goldman Sachs', 'Bloomberg', 'Lead Edge Capital', 'The Information', 'Artemis Capital'; null if unclear>",
  "document_type": "<one of the values above>",
  "publication_date": "YYYY-MM-DD" | null,
  "summary": "<depth-proportional summary, MAXIMUM 1500 characters. SHORT notes / articles / essays: 1-2 paragraphs. MEDIUM analyst reports / investor letters: 2-3 paragraphs. LONG primers / earnings decks / macro notes: 3-5 short paragraphs covering thesis, supporting analysis, and conclusions. Use paragraph breaks (double-newline) for multi-paragraph output. Prefer substance over brevity — this summary should substitute for re-reading the document later. Do NOT hallucinate content not in the PDF. HARD CAP: summary must fit in 1500 characters; if longer, prioritize thesis + conclusions and trim middle elaboration.>",
  "key_points": ["<bullet>", "..."],
  "mentioned_symbols": ["AAPL", "NVDA", "..."],
  "suggested_tags": ["<3-8 lowercase tags describing theme, sector, geography, style, or era — e.g. 'semiconductors', 'ai infrastructure', 'founder-led', 'q3 2024', 'value-investing', 'china', 'saas'>"],
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed" | null,
  "target_prices": [{"symbol": "NVDA", "price": 1200, "horizon": "12mo"}]
}

Rules:
- key_points: extract EVERY meaningful takeaway. Short note: 5-8 bullets. Long primer: 25-40. No upper limit. Don't pad, don't under-serve.
- mentioned_symbols: only real tickers, uppercase, no duplicates, no company names.
- suggested_tags: prefer sector/theme/style over literal content ("semiconductors" good, "nvda" redundant).
- target_prices: only explicit numeric targets; empty array if none.
- sentiment: null for most articles and primers where there's no directional call.
- Dates: resolve "Q1 2026" or "March 2026" to last day of period (2026-03-31).
- If content is ambiguous, prefer null over guessing.
- Output ONLY the JSON object. No surrounding text, no code fences.`;

const RAW_TEXT_PROMPT = `Extract the FULL plain-text body of this PDF document. No summary, no metadata, no JSON, no markdown fences, no preamble.

Rules:
- Preserve paragraph breaks with blank lines (double newline).
- Preserve table cell separators with tabs.
- Strip decorative whitespace but keep structural line breaks.
- Include every sentence, caption, and footnote.
- Do NOT summarize or paraphrase.
- Do NOT wrap in JSON or code fences.
- Just the plain text of the document body.

Begin:`;

// ─── Public API ──────────────────────────────────────────────────

/**
 * Fast call: extract structured metadata only. Typically 30-60s for small
 * PDFs, up to 2 min for large graphics-heavy ones.
 */
export async function extractResearchMetadata(
  pdfBytes: Uint8Array,
): Promise<ExtractedResearchMetadata> {
  checkSize(pdfBytes);
  const { modelId } = resolveFeatureModel("researchDocumentExtraction");
  const raw = await callClaudeWithPdf(
    pdfBytes,
    METADATA_PROMPT,
    "researchDocumentExtraction",
    8000, // headroom for long key_points + multi-paragraph summary on dense research notes
  );
  return parseMetadataResponse(raw, modelId);
}

/**
 * Slow call: extract the full plain-text body. Can run 2-4 min for big
 * primers; user-facing callers should not block on this — insert the doc
 * with metadata first and update raw_text when this resolves.
 */
export async function extractResearchRawText(
  pdfBytes: Uint8Array,
): Promise<string> {
  checkSize(pdfBytes);
  const raw = await callClaudeWithPdf(
    pdfBytes,
    RAW_TEXT_PROMPT,
    "researchDocumentExtraction",
    32000, // raw_text can be massive
  );
  const trimmed = raw.trim();
  // Strip accidental markdown fences.
  const unfenced = trimmed
    .replace(/^\s*```(?:[a-z]+)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!unfenced) {
    throw new ResearchPdfExtractionError(
      "Raw text response was empty.",
      raw.slice(0, 200),
    );
  }
  return unfenced;
}

/**
 * Legacy combined call (kept for tests + any caller that wants metadata +
 * raw_text in one shot). Prefer the split functions above for UI flows.
 */
export async function extractResearchPdf(
  pdfBytes: Uint8Array,
): Promise<ExtractedResearchDocument> {
  const [metadata, rawText] = await Promise.all([
    extractResearchMetadata(pdfBytes),
    extractResearchRawText(pdfBytes),
  ]);
  return { ...metadata, raw_text: rawText };
}

// ─── Internals ───────────────────────────────────────────────────

function checkSize(pdfBytes: Uint8Array) {
  if (pdfBytes.byteLength > RESEARCH_DOC_PDF_MAX_BYTES) {
    throw new ResearchPdfTooLargeError(pdfBytes.byteLength);
  }
}

async function callClaudeWithPdf(
  pdfBytes: Uint8Array,
  prompt: string,
  feature: FeatureKey,
  maxTokens: number,
): Promise<string> {
  const { modelId } = resolveFeatureModel(feature);
  const client = getRawAnthropicClient(feature);
  const base64 = Buffer.from(pdfBytes).toString("base64");

  const stream = client.messages.stream({
    model: modelId,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    // QA: research-documents-upload--500-renders-raw-anthropic-envelope.
    // An Anthropic SDK APIError's `.message` embeds the raw JSON body
    // (request_id + internals) — that must never reach the client verbatim.
    // Classify it into a plain-language message HERE, at the boundary,
    // before it can propagate up to the route's generic catch-all (which
    // otherwise stringifies err.message straight into the response).
    console.error("Research PDF extraction upstream error:", err);
    const classification = classifyAnthropicError(err);
    if (classification) {
      throw new ResearchPdfExtractionError(classification.userMessage, "");
    }
    throw err;
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new ResearchPdfExtractionError(
      "Claude response contained no text block",
      JSON.stringify(response.content).slice(0, 200),
    );
  }
  return textBlock.text;
}

/**
 * Parse a metadata-only Claude response and normalize fields. No raw_text
 * involved. Exported for unit testing.
 */
export function parseMetadataResponse(
  raw: string,
  modelId: string,
): ExtractedResearchMetadata {
  const jsonText = raw
    .trim()
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ResearchPdfExtractionError(
      "Metadata response was not valid JSON.",
      jsonText.slice(0, 500),
    );
  }
  return normalizeMetadata(parsed, modelId);
}

// ─── Normalization ───────────────────────────────────────────────

const DOC_TYPES: ResearchDocumentType[] = [
  "analyst_report",
  "research_note",
  "market_analysis",
  "industry_primer",
  "investor_letter",
  "earnings_presentation",
  "article",
  "book_summary_or_essay",
  "macro_note",
  "other",
];

const SENTIMENTS: ResearchDocumentSentiment[] = [
  "bullish",
  "bearish",
  "neutral",
  "mixed",
];

/**
 * Normalize free-text tags: lowercase, trim, strip weird chars, dedupe, cap
 * per-tag length + collection size. Accepts an array or a single string.
 * Exported for the mutation layer to reuse on user-edited tags.
 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9\s&+\-./]/g, " ") // allow common separators, strip emoji/control
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((t) => t.length > 0 && t.length <= 40);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cleaned) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 15) break;
  }
  return out;
}

export function normalizeMetadata(
  raw: unknown,
  modelId: string,
): ExtractedResearchMetadata {
  if (!raw || typeof raw !== "object") {
    throw new ResearchPdfExtractionError(
      "Extracted payload is not an object",
      String(raw).slice(0, 200),
    );
  }
  const r = raw as Record<string, unknown>;

  const title =
    typeof r.title === "string" && r.title.trim() ? r.title.trim() : "Untitled";

  const documentTypeRaw = typeof r.document_type === "string" ? r.document_type : "";
  const documentType: ResearchDocumentType = DOC_TYPES.includes(
    documentTypeRaw as ResearchDocumentType,
  )
    ? (documentTypeRaw as ResearchDocumentType)
    : "other";

  const sentimentRaw = typeof r.sentiment === "string" ? r.sentiment : null;
  const sentiment: ResearchDocumentSentiment | null =
    sentimentRaw && SENTIMENTS.includes(sentimentRaw as ResearchDocumentSentiment)
      ? (sentimentRaw as ResearchDocumentSentiment)
      : null;

  const pubDate =
    typeof r.publication_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.publication_date)
      ? r.publication_date
      : null;

  const author =
    typeof r.author === "string" && r.author.trim() ? r.author.trim() : null;
  const source =
    typeof r.source === "string" && r.source.trim() ? r.source.trim() : null;
  const summary =
    typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null;

  const keyPoints = Array.isArray(r.key_points)
    ? r.key_points.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];

  const mentionedRaw = Array.isArray(r.mentioned_symbols) ? r.mentioned_symbols : [];
  const mentionedSymbols = Array.from(
    new Set(
      mentionedRaw
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 10 && /^[A-Z0-9.\-]+$/.test(s)),
    ),
  );

  const targetPricesRaw = Array.isArray(r.target_prices) ? r.target_prices : [];
  const targetPrices = targetPricesRaw
    .map((tp): { symbol: string; price: number; horizon?: string } | null => {
      if (!tp || typeof tp !== "object") return null;
      const t = tp as Record<string, unknown>;
      const symbol = typeof t.symbol === "string" ? t.symbol.trim().toUpperCase() : "";
      const price = typeof t.price === "number" && Number.isFinite(t.price) ? t.price : NaN;
      const horizon = typeof t.horizon === "string" ? t.horizon.trim() : undefined;
      if (!symbol || !Number.isFinite(price)) return null;
      return horizon ? { symbol, price, horizon } : { symbol, price };
    })
    .filter((x): x is { symbol: string; price: number; horizon?: string } => x !== null);

  const tags = normalizeTags(r.suggested_tags ?? r.tags);

  return {
    title,
    author,
    source,
    document_type: documentType,
    publication_date: pubDate,
    summary,
    key_points: keyPoints,
    mentioned_symbols: mentionedSymbols,
    tags,
    sentiment,
    target_prices: targetPrices,
    ai_model: modelId,
  };
}

// ─── Backward-compat: combined parser + normalizer (tests only) ───

const RAW_TEXT_BEGIN = "---RAW_TEXT_BEGIN---";
const RAW_TEXT_END = "---RAW_TEXT_END---";

/**
 * Parse the legacy combined Claude response (JSON + sentinel-delimited raw
 * body). Retained because existing tests rely on it and it's still useful
 * for any future "one-shot" callers. The production POST route uses the
 * split functions (extractResearchMetadata + extractResearchRawText).
 */
export function parseClaudeResponse(
  raw: string,
  modelId: string,
): ExtractedResearchDocument {
  const beginIdx = raw.indexOf(RAW_TEXT_BEGIN);
  if (beginIdx === -1) {
    throw new ResearchPdfExtractionError(
      `Claude response missing ${RAW_TEXT_BEGIN} delimiter — raw_text could not be located.`,
      raw.slice(0, 500),
    );
  }

  let jsonText = raw.slice(0, beginIdx).trim();
  jsonText = jsonText
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsedMeta: unknown;
  try {
    parsedMeta = JSON.parse(jsonText);
  } catch {
    throw new ResearchPdfExtractionError(
      "Metadata JSON (PART 1) did not parse.",
      jsonText.slice(0, 500),
    );
  }

  let rawText = raw.slice(beginIdx + RAW_TEXT_BEGIN.length);
  const endIdx = rawText.indexOf(RAW_TEXT_END);
  if (endIdx !== -1) rawText = rawText.slice(0, endIdx);
  rawText = rawText.trim();
  if (!rawText) {
    throw new ResearchPdfExtractionError(
      "raw_text was empty after the delimiter — nothing to index.",
      raw.slice(Math.max(0, beginIdx - 100), beginIdx + 200),
    );
  }

  const metadata = normalizeMetadata(parsedMeta, modelId);
  return { ...metadata, raw_text: rawText };
}

/**
 * Legacy combined normalizer, back-compatible with tests that pass a payload
 * containing raw_text alongside metadata fields.
 */
export function normalizeExtracted(
  raw: unknown,
  modelId: string,
): ExtractedResearchDocument {
  if (!raw || typeof raw !== "object") {
    throw new ResearchPdfExtractionError(
      "Extracted payload is not an object",
      String(raw).slice(0, 200),
    );
  }
  const r = raw as Record<string, unknown>;
  const rawText = typeof r.raw_text === "string" ? r.raw_text : "";
  if (!rawText) {
    throw new ResearchPdfExtractionError(
      "Extracted payload is missing raw_text — nothing to index",
      JSON.stringify(r).slice(0, 200),
    );
  }
  const metadata = normalizeMetadata(raw, modelId);
  return { ...metadata, raw_text: rawText };
}
