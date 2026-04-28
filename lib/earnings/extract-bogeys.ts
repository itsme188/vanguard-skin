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

import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { parseLargeUSD } from "@/lib/format";

export interface ExtractedBogey {
  symbol: string;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
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

export async function extractBogeysFromPdf(
  pdfBytes: Uint8Array,
): Promise<ExtractBogeysResult> {
  const feature = "earningsBogeysExtraction" as const;
  const { modelId } = resolveFeatureModel(feature);
  const client = getRawAnthropicClient(feature);
  const base64 = Buffer.from(pdfBytes).toString("base64");

  const stream = client.messages.stream({
    model: modelId,
    max_tokens: 4_096,
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
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const response = await stream.finalMessage();
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
