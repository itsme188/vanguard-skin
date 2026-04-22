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

export const RESEARCH_DOC_PDF_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export type ResearchDocumentType =
  | "analyst_report"
  | "research_note"
  | "market_analysis"
  | "industry_primer"
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
  sentiment: ResearchDocumentSentiment | null;
  target_prices: Array<{ symbol: string; price: number; horizon?: string }>;
  raw_text: string;
  ai_model: string;
}

const EXTRACTION_PROMPT = `You are reading a research PDF (analyst report, bank research note, market analysis, or industry primer). Extract structured metadata AND the full plain-text body.

Return ONLY valid JSON matching this exact schema (no markdown, no code fences, no commentary):

{
  "title": "<best document title from cover/header>",
  "author": "<primary author name, or null>",
  "source": "<firm or publication — e.g. 'Goldman Sachs', 'Bernstein Research', 'Morgan Stanley'; null if unclear>",
  "document_type": "analyst_report" | "research_note" | "market_analysis" | "industry_primer" | "other",
  "publication_date": "YYYY-MM-DD" | null,
  "summary": "<2-4 sentence plain-text summary of the document's core thesis — do NOT hallucinate content that is not in the PDF>",
  "key_points": ["<bullet 1>", "<bullet 2>", "..."],
  "mentioned_symbols": ["AAPL", "NVDA", "..."] (upper-case ticker symbols mentioned; empty array if none),
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed" | null,
  "target_prices": [
    {"symbol": "NVDA", "price": 1200, "horizon": "12mo"}
  ],
  "raw_text": "<full plain-text body of the document — preserve paragraph breaks with \\n\\n, preserve table cell separators with \\t, strip decorative whitespace, keep every sentence — this IS the searchable corpus>"
}

Rules:
- Do NOT summarize raw_text — it must be the complete document body.
- mentioned_symbols: only real tickers, uppercase, no duplicates, no company names.
- target_prices: only explicit numeric targets the author states; omit if none.
- sentiment: reflect the author's stated view; use null if not a directional call.
- Dates: if only "Q1 2026" or "March 2026" is given, resolve to last day of period (2026-03-31).
- If content is ambiguous, prefer null over guessing.`;

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
    max_tokens: 16000,
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

  const rawText = textBlock.text;
  // Claude occasionally wraps JSON in ```json fences despite the prompt.
  const unfenced = rawText
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new ResearchPdfExtractionError(
      "Claude response was not valid JSON",
      unfenced.slice(0, 300),
    );
  }

  return normalizeExtracted(parsed, modelId);
}

// ─── Normalization helpers ───────────────────────────────────────

const DOC_TYPES: ResearchDocumentType[] = [
  "analyst_report",
  "research_note",
  "market_analysis",
  "industry_primer",
  "other",
];

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

  return {
    title,
    author,
    source,
    document_type: documentType,
    publication_date: pubDate,
    summary,
    key_points: keyPoints,
    mentioned_symbols: mentionedSymbols,
    sentiment,
    target_prices: targetPrices,
    raw_text: rawText,
    ai_model: modelId,
  };
}

// Export for testing
export { normalizeExtracted };
