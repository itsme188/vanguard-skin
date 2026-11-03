/**
 * Bogey extraction through the provider-neutral PDF seam
 * (provider-failover design slice 3, §5 "First consumer: bogey extraction").
 *
 * NOT wired into the live path: extractBogeysFromUpload (extract-bogeys.ts)
 * still makes the one raw Anthropic call, untouched. This module is the same
 * extraction expressed over lib/ai/pdf-extraction.ts so that
 *   - the OpenAI leg can be exercised and parity-measured (scripts/
 *     failover-pdf-parity.ts, §8), and
 *   - flipping the feature on later is a call-site swap plus an entry in
 *     PDF_FAILOVER_ENABLED_DEFAULT, not a new build.
 * Both legs go through the ONE parser (`parseExtractionResponse`), which is
 * what makes a figure-parity comparison between providers meaningful.
 */
import {
  extractFromPdfWithFailover,
  PdfExtractionTruncatedError,
  type PdfExtractionRequest,
  type PdfExtractionResult,
} from "@/lib/ai/pdf-extraction";
import {
  EXTRACTION_PROMPT,
  parseExtractionResponse,
  BogeysExtractionError,
  type ExtractedBogey,
} from "@/lib/earnings/extract-bogeys";

const NULLABLE_NUMBER = { type: ["number", "null"] };
const NULLABLE_STRING = { type: ["string", "null"] };

/** JSON Schema of the object root OpenAI structured output requires. Shape only; validation stays in parseExtractionResponse. */
export const BOGEYS_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    bogeys: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          eps_consensus: NULLABLE_NUMBER,
          eps_whisper: NULLABLE_NUMBER,
          revenue_consensus_usd: NULLABLE_NUMBER,
          revenue_whisper_usd: NULLABLE_NUMBER,
          expected_move_pct: NULLABLE_NUMBER,
          segment_breakdown: {
            type: ["object", "null"],
            additionalProperties: {
              type: "object",
              properties: { consensus: NULLABLE_NUMBER, whisper: NULLABLE_NUMBER },
            },
          },
          guidance_notes: NULLABLE_STRING,
          notes: NULLABLE_STRING,
          watch_metrics: {
            type: ["array", "null"],
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                definition: { type: "string" },
                unit: { type: "string" },
                kind: { type: "string" },
                period: { type: "string" },
                basis: { type: "string" },
                consensus: NULLABLE_NUMBER,
                whisper: NULLABLE_NUMBER,
              },
            },
          },
        },
        required: ["symbol"],
      },
    },
  },
  required: ["bogeys"],
};

/** The OpenAI leg answers `{ "bogeys": [...] }`; the Anthropic leg answers the bare array. Both reach the parser as an array. */
function unwrapBogeysText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const inner = (parsed as { bogeys?: unknown }).bogeys;
      if (Array.isArray(inner)) return JSON.stringify(inner);
    }
  } catch {
    // Not clean JSON (a fenced Anthropic answer): the parser's own defenses handle it.
  }
  return text;
}

export interface SeamBogeysResult {
  bogeys: ExtractedBogey[];
  modelId: string;
  provider: PdfExtractionResult["provider"];
  rawResponse: string;
}

type Legs = Parameters<typeof extractFromPdfWithFailover>[1];

export async function extractBogeysFromPdfViaSeam(pdfBytes: Uint8Array, legs?: Legs): Promise<SeamBogeysResult> {
  const req: PdfExtractionRequest = {
    feature: "earningsBogeysExtraction",
    pdfBytes,
    schema: BOGEYS_OBJECT_SCHEMA,
    prompt: EXTRACTION_PROMPT,
  };
  let res: PdfExtractionResult;
  try {
    res = await extractFromPdfWithFailover(req, legs);
  } catch (err) {
    if (err instanceof PdfExtractionTruncatedError) {
      throw new BogeysExtractionError(
        "The sheet had more content than one extraction pass can return — split the upload into fewer symbols per page and try again.",
        422,
        "truncated",
      );
    }
    // Account-level and transport failures propagate untouched, so the caller classifies them as it does today.
    throw err;
  }
  const raw = unwrapBogeysText(res.text);
  try {
    return { bogeys: parseExtractionResponse(raw), modelId: res.modelId, provider: res.provider, rawResponse: raw };
  } catch (err) {
    console.error("Bogeys extraction (seam) unparseable output:", err, "raw:", raw.slice(0, 500));
    throw new BogeysExtractionError(
      "The AI's extraction output couldn't be read. This is usually transient — try the upload again.",
      502,
      "unparseable",
    );
  }
}
