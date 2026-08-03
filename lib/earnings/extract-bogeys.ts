/**
 * Extract per-symbol earnings bogeys from a multi-symbol PDF
 * (e.g., TMT Breakout's "earnings this week" preview page).
 *
 * Pipeline:
 *   1. Send the PDF to Claude with a structured-output prompt asking for
 *      a JSON array of `{symbol, eps_consensus, eps_whisper,
 *      revenue_consensus, revenue_whisper, segment_breakdown,
 *      guidance_notes, notes}`.
 *   2. Caller fans out per-symbol matches against calendar_events for the
 *      target week and inserts one earnings_bogeys row per match.
 *
 * The model intentionally has access to the full PDF (native document
 * content block) so it can read tables + layout reliably. Sonnet 4.6 is
 * plenty for structured extraction; Opus would be overkill.
 */

import { APIError } from "@anthropic-ai/sdk";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { coercePercent, parseLargeUSD } from "@/lib/format";

/**
 * User-presentable extraction failure. `message` is safe to render
 * verbatim in the UI — raw upstream payloads (which embed request_ids
 * and API internals) are logged server-side only, never thrown.
 */
export class BogeysExtractionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: "invalid_pdf" | "upstream",
  ) {
    super(message);
    this.name = "BogeysExtractionError";
  }
}

export interface ExtractedBogey {
  symbol: string;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
  /** Absolute percent (a sheet's "±6%" → 6); null when the sheet gives none. */
  expected_move_pct: number | null;
  segment_breakdown: Record<string, { consensus?: number; whisper?: number }> | null;
  guidance_notes: string | null;
  notes: string | null;
}

export interface ExtractBogeysResult {
  bogeys: ExtractedBogey[];
  modelId: string;
  rawResponse: string;
}

const EXTRACTION_PROMPT = `You are looking at a multi-symbol earnings preview / bogeys page (e.g., TMT Breakout, Vital Knowledge, or a sell-side weekly).

Extract one entry per company mentioned. For each, capture the bogeys analysts and traders are watching for the upcoming print:
- EPS consensus (Street average) and EPS whisper (above-consensus number traders are positioning for)
- Revenue consensus and revenue whisper, in USD
- The expected/implied earnings MOVE the sheet states for the name (e.g., "expected move ±6%", "options pricing a 5.5% move") as an absolute percent number
- Any segment-level breakdown (e.g., GLW: Optical $1.5B / Display $0.9B)
- Guidance bogeys (e.g., "FY26 revenue guide $19.5–20.0B")
- Any other relevant notes (catalyst risk, key call topics)

Output ONLY a JSON array. No prose, no markdown fences. Each entry must have this exact shape (use null for fields not mentioned):

[
  {
    "symbol": "GLW",
    "eps_consensus": 0.46,
    "eps_whisper": 0.50,
    "revenue_consensus_usd": 3850000000,
    "revenue_whisper_usd": 3900000000,
    "expected_move_pct": 6.0,
    "segment_breakdown": {"Optical": {"consensus": 1500000000, "whisper": 1520000000}},
    "guidance_notes": "FY26 revenue guide $19.5–20.0B",
    "notes": "Key topic: optical fiber capacity expansion"
  }
]

Strict rules:
- Symbols must be the listed ticker symbol, uppercase, no exchange prefix.
- Numbers are RAW (not abbreviated): 4_345_000_000 not "$4.34B". When the document writes "$4.34B" you MUST convert to 4340000000.
- Use null (not 0, not "") for any field the document doesn't mention for that company.
- Do not invent companies not on the page.
- If a company is mentioned but no bogeys are given, still include an entry with all numeric fields null and the qualitative info in "notes".`;

/** Upload media types the extraction accepts (Claude document/image blocks). */
export type BogeysUploadMediaType =
  | "application/pdf"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

const IMAGE_MEDIA_TYPES = new Set<BogeysUploadMediaType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const EXTENSION_TO_MEDIA: Record<string, BogeysUploadMediaType> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Resolve an upload's media type from its MIME type, falling back to the file
 * extension (browsers sometimes send an empty `File.type`). Returns null for
 * anything the Claude API can't take as a document/image block — notably HEIC,
 * which iPhone *photos* use; iPhone *screenshots* are PNG and are fine.
 */
export function resolveBogeysUploadMediaType(
  fileName: string,
  mimeType: string,
): BogeysUploadMediaType | null {
  const mime = mimeType.trim().toLowerCase();
  if (mime === "application/pdf") return "application/pdf";
  if (IMAGE_MEDIA_TYPES.has(mime as BogeysUploadMediaType)) {
    return mime as BogeysUploadMediaType;
  }
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  // Only fall back to the extension when the MIME type is absent/generic —
  // a *known* unsupported MIME (image/heic) must not sneak through via ".jpg".
  if (mime === "" || mime === "application/octet-stream") {
    return (ext && EXTENSION_TO_MEDIA[ext]) || null;
  }
  return null;
}

/** Back-compat wrapper — PDF-only callers keep their signature. */
export async function extractBogeysFromPdf(
  pdfBytes: Uint8Array,
): Promise<ExtractBogeysResult> {
  return extractBogeysFromUpload(pdfBytes, "application/pdf");
}

export async function extractBogeysFromUpload(
  fileBytes: Uint8Array,
  mediaType: BogeysUploadMediaType,
): Promise<ExtractBogeysResult> {
  const feature = "earningsBogeysExtraction" as const;
  const { modelId } = resolveFeatureModel(feature);
  const client = getRawAnthropicClient(feature);
  const base64 = Buffer.from(fileBytes).toString("base64");
  const isImage = mediaType !== "application/pdf";

  const fileBlock = isImage
    ? {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType as Exclude<BogeysUploadMediaType, "application/pdf">,
          data: base64,
        },
      }
    : {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: base64,
        },
      };

  const stream = client.messages.stream({
    model: modelId,
    max_tokens: 4_096,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: EXTRACTION_PROMPT }],
      },
    ],
  });

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    // The only user-supplied input in this call is the file itself, so an
    // upstream 400 means the document/image was rejected (corrupt/unreadable).
    console.error("Bogeys extraction upstream error:", err);
    if (err instanceof APIError && err.status === 400) {
      throw new BogeysExtractionError(
        isImage
          ? "That image couldn't be read — try a clearer screenshot (PNG/JPEG) and upload again."
          : "That file couldn't be read as a PDF — try re-exporting it and uploading again.",
        400,
        "invalid_pdf",
      );
    }
    throw new BogeysExtractionError(
      `The AI extraction service failed (${err instanceof APIError && err.status ? `upstream ${err.status}` : "connection error"}). Try again in a minute.`,
      502,
      "upstream",
    );
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Bogeys extraction returned no text block.");
  }

  const raw = textBlock.text;
  const bogeys = parseExtractionResponse(raw);
  return { bogeys, modelId, rawResponse: raw };
}

/**
 * Parse the JSON array Claude returns into typed bogey rows. Tolerant of
 * surrounding markdown fences (some sources nudge Claude into ```json
 * blocks despite the prompt). Coerces stringified numbers ("4.34B") via
 * parseLargeUSD so a sloppy model output doesn't lose the data.
 */
export function parseExtractionResponse(raw: string): ExtractedBogey[] {
  const trimmed = raw
    .trim()
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Bogeys extraction returned non-JSON: ${(err as Error).message}. First 200 chars: ${trimmed.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Bogeys extraction did not return an array.");
  }

  const out: ExtractedBogey[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const symbol = typeof e.symbol === "string" ? e.symbol.trim().toUpperCase() : "";
    if (!symbol) continue;

    const segRaw = e.segment_breakdown;
    const segments = parseSegments(segRaw);

    out.push({
      symbol,
      eps_consensus: coerceNumber(e.eps_consensus),
      eps_whisper: coerceNumber(e.eps_whisper),
      revenue_consensus_usd: coerceNumber(e.revenue_consensus_usd),
      revenue_whisper_usd: coerceNumber(e.revenue_whisper_usd),
      expected_move_pct: coercePercent(e.expected_move_pct),
      segment_breakdown: segments,
      guidance_notes: typeof e.guidance_notes === "string" ? e.guidance_notes : null,
      notes: typeof e.notes === "string" ? e.notes : null,
    });
  }
  return out;
}

function coerceNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseLargeUSD(v);
  return null;
}


function parseSegments(
  v: unknown,
): Record<string, { consensus?: number; whisper?: number }> | null {
  if (!v || typeof v !== "object") return null;
  const out: Record<string, { consensus?: number; whisper?: number }> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const cons = coerceNumber(r.consensus);
    const whis = coerceNumber(r.whisper);
    if (cons == null && whis == null) continue;
    out[k] = {
      ...(cons != null ? { consensus: cons } : {}),
      ...(whis != null ? { whisper: whis } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}
