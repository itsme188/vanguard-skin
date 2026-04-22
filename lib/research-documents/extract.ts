/**
 * Research PDF → structured metadata + raw text via Claude.
 *
 * One-shot extraction: we pass the PDF as a document content block (Anthropic
 * native PDF support) and ask Claude to return a JSON envelope with title,
 * author, source, document_type, publication_date, summary, key_points,
 * mentioned_symbols, sentiment, target_prices, and raw_text.
 *
 * Design notes:
 *   - Uses `getRawAnthropicClient("researchDocumentExtraction")` so we can
 *     pass the PDF as a `document` content block (AI SDK's file parts don't
 *     yet match the raw Anthropic PDF API's ergonomics).
 *   - Enforces a 25 MB hard cap — Anthropic's PDF limit is 32 MB but the
 *     base64 encoding bloats +33%, so we cap pre-encode.
 *   - One attempt, no retry loop. The Vanguard PDF parser's retry-merge is
 *     needed because its 28-page statements miss 50-70% of holdings on a
 *     single call; research docs are typically <30 pages and don't suffer
 *     the same attention-dilution problem.
 */

import { resolveFeatureModel } from "@/lib/ai/models";
import { getRawAnthropicClient } from "@/lib/ai/provider";

// Anthropic's hard PDF limit is 32 MB; we keep the cap at 32 to match.
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

export interface ExtractedResearchDocument {
  title: string;
  author: string | null;
  source: string | null;
  document_type: ResearchDocumentType;
  publication_date: string | null; // YYYY-MM-DD
  summary: string | null;
  key_points: string[];
  mentioned_symbols: string[]; // uppercase tickers
  tags: string[]; // AI-suggested lowercase tags (user can edit after)
  sentiment: ResearchDocumentSentiment | null;
  target_prices: Array<{ symbol: string; price: number; horizon?: string }>;
  raw_text: string;
  ai_model: string;
}

const RAW_TEXT_BEGIN = "---RAW_TEXT_BEGIN---";
const RAW_TEXT_END = "---RAW_TEXT_END---";

const EXTRACTION_PROMPT = `You are reading a research PDF. It may be any of:
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

Extract structured metadata AND the full plain-text body.

Output format (TWO PARTS, in this exact order):

PART 1 — A single JSON object. No markdown fences, no preamble, just JSON:

{
  "title": "<best document title from cover/header; for articles, the headline; for investor letters, include firm + quarter>",
  "author": "<primary author name, or null>",
  "source": "<firm / publication / fund — e.g. 'Goldman Sachs', 'Bloomberg', 'Lead Edge Capital', 'The Information', 'Artemis Capital'; null if unclear>",
  "document_type": "<one of the values above>",
  "publication_date": "YYYY-MM-DD" | null,
  "summary": "<2-4 sentence plain-text summary of the document's core thesis / content — do NOT hallucinate content that is not in the PDF>",
  "key_points": ["<bullet 1>", "<bullet 2>", "..."],
  "mentioned_symbols": ["AAPL", "NVDA", "..."],
  "suggested_tags": ["<3-8 lowercase tags describing theme, sector, geography, style, or era — e.g. 'semiconductors', 'ai infrastructure', 'founder-led', 'q3 2024', 'value-investing', 'china', 'saas'>"],
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed" | null,
  "target_prices": [
    {"symbol": "NVDA", "price": 1200, "horizon": "12mo"}
  ]
}

PART 2 — On a new line after the JSON, write this exact literal delimiter:

${RAW_TEXT_BEGIN}

Then dump the FULL plain-text body of the document. No JSON escaping — write newlines as real newlines, quotes as real quotes. Preserve paragraph breaks with blank lines. Preserve table cell separators with tabs. Strip decorative whitespace. Keep every sentence — this IS the searchable corpus.

End with this exact literal delimiter on its own line:

${RAW_TEXT_END}

Rules:
- Do NOT summarize the body — it must be the complete document text.
- mentioned_symbols: only real tickers, uppercase, no duplicates, no company names.
- suggested_tags: useful for future retrieval; prefer sector/theme/style over the literal content ("semiconductors" good, "nvda" redundant since it's in mentioned_symbols). 3-8 tags, lowercase, no hashtags.
- target_prices: only explicit numeric targets the author states; omit if none. For articles / essays / investor letters with no price target, pass an empty array.
- sentiment: reflect the author's stated view; use null if not a directional call (most articles + primers).
- Dates: if only "Q1 2026" or "March 2026" is given, resolve to last day of period (2026-03-31).
- If content is ambiguous, prefer null over guessing.
- Do NOT output anything outside of PART 1 JSON and PART 2 body. No explanation text.`;

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

/**
 * Extract structured metadata + raw text from a research PDF.
 *
 * @param pdfBytes raw PDF bytes (Uint8Array or Buffer)
 * @throws ResearchPdfTooLargeError if PDF exceeds 25 MB
 * @throws ResearchPdfExtractionError if Claude response can't be parsed
 */
export async function extractResearchPdf(
  pdfBytes: Uint8Array,
): Promise<ExtractedResearchDocument> {
  if (pdfBytes.byteLength > RESEARCH_DOC_PDF_MAX_BYTES) {
    throw new ResearchPdfTooLargeError(pdfBytes.byteLength);
  }

  const { modelId } = resolveFeatureModel("researchDocumentExtraction");
  const client = getRawAnthropicClient("researchDocumentExtraction");

  const base64 = Buffer.from(pdfBytes).toString("base64");

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 32000,
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
          {
            type: "text",
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new ResearchPdfExtractionError(
      "Claude response contained no text block",
      JSON.stringify(response.content).slice(0, 200),
    );
  }

  return parseClaudeResponse(textBlock.text, modelId);
}

/**
 * Parse Claude's two-part response: JSON metadata envelope + sentinel-delimited
 * raw body. Exported for unit testing.
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

  // JSON is everything before the delimiter. Strip markdown fences + stray
  // leading/trailing whitespace Claude occasionally emits despite the prompt.
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

  // Raw text: everything after the BEGIN delimiter. Strip the END delimiter
  // if present (not strictly required since we keep up through it, but the
  // prompt asks for it as a clean terminator).
  let rawText = raw.slice(beginIdx + RAW_TEXT_BEGIN.length);
  const endIdx = rawText.indexOf(RAW_TEXT_END);
  if (endIdx !== -1) {
    rawText = rawText.slice(0, endIdx);
  }
  rawText = rawText.trim();

  if (!rawText) {
    throw new ResearchPdfExtractionError(
      "raw_text was empty after the delimiter — nothing to index.",
      raw.slice(Math.max(0, beginIdx - 100), beginIdx + 200),
    );
  }

  // Re-inject raw_text into the metadata object so normalizeExtracted can
  // apply its existing validation rules.
  if (parsedMeta && typeof parsedMeta === "object") {
    (parsedMeta as Record<string, unknown>).raw_text = rawText;
  }

  return normalizeExtracted(parsedMeta, modelId);
}

// ─── Normalization helpers ───────────────────────────────────────

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
  // Preserve first-seen order for dedupe.
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

const SENTIMENTS: ResearchDocumentSentiment[] = [
  "bullish",
  "bearish",
  "neutral",
  "mixed",
];

function normalizeExtracted(raw: unknown, modelId: string): ExtractedResearchDocument {
  if (!raw || typeof raw !== "object") {
    throw new ResearchPdfExtractionError(
      "Extracted payload is not an object",
      String(raw).slice(0, 200),
    );
  }
  const r = raw as Record<string, unknown>;

  const title =
    typeof r.title === "string" && r.title.trim() ? r.title.trim() : "Untitled";
  const rawText = typeof r.raw_text === "string" ? r.raw_text : "";
  if (!rawText) {
    throw new ResearchPdfExtractionError(
      "Extracted payload is missing raw_text — nothing to index",
      JSON.stringify(r).slice(0, 200),
    );
  }

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
    typeof r.publication_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.publication_date)
      ? r.publication_date
      : null;

  const author = typeof r.author === "string" && r.author.trim() ? r.author.trim() : null;
  const source = typeof r.source === "string" && r.source.trim() ? r.source.trim() : null;
  const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null;

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
    raw_text: rawText,
    ai_model: modelId,
  };
}

// Export for testing
export { normalizeExtracted };
