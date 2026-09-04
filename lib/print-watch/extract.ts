/**
 * Extraction model call — ported from scripts/spike-bakeoff-parse.ts (task-4,
 * 2026-08-20). Sends ONE representation of a print's text to the model with
 * a fixed list of contract lines and gets back one candidate per metric_id
 * via a forced tool call. Pure LLM I/O: no db, no fs, no adapter knowledge —
 * lib/print-watch/contracts.ts builds `contracts`, an adapter builds
 * `representationText` (lib/print-watch/representations.ts or a raw wire
 * text), and this module never sees the bogey-derived `expected` map
 * (contracts.ts's parallel structure) — the call signature has no slot for
 * it, so it cannot leak into the prompt.
 *
 * NOTES ON THE MODEL CALL (ported gotchas, repo-wide precedent)
 *   - The model id is NEVER hardcoded: resolveTier("workhorse", …) falling
 *     back to TIER_STATIC_FALLBACK.workhorse (== SONNET_MODEL) when no live
 *     catalog is available. This module never touches the db, so it always
 *     resolves against an empty catalog unless `opts.model` is given.
 *   - Output comes back through a FORCED tool call (tool_choice:
 *     {type:"tool"}). Every object node in the tool's JSON schema carries
 *     additionalProperties:false (repo gotcha: Anthropic 400s without it).
 *   - No `temperature`: sampling parameters are rejected (400) on the
 *     current Sonnet tier.
 *   - One malformed/empty response gets ONE retry — same C0-control-char
 *     handling precedent as lib/ai/extract-json.ts +
 *     lib/securities/verify-sector-tags.ts.
 *   - The client is injectable (`opts.anthropic: AnthropicLike`) so callers
 *     — and every test — never construct a real @anthropic-ai/sdk client
 *     unless they explicitly opt in.
 */

import Anthropic from "@anthropic-ai/sdk";

import { SONNET_MODEL } from "@/lib/claude-models";
import { resolveTier } from "@/lib/ai/model-tiers";
import { getAnthropicApiKey } from "@/lib/env";
import type { LineContract, ParseCandidate } from "@/lib/print-watch/types";

// ---------------------------------------------------------------------------
// injection seam
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the Anthropic client this module needs — same "…Like"
 * injection-seam convention as lib/print-watch/dj-adapter.ts::IBApiLike and
 * lib/print-watch/ir-rss-adapter.ts::FetchLike. A real `new Anthropic(...)`
 * instance satisfies this structurally; tests pass a `{ messages: { create
 * } }` stub and never touch the network.
 */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

// ---------------------------------------------------------------------------
// prompt + tool (ported from scripts/spike-bakeoff-parse.ts::SYSTEM_PROMPT/TOOL)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a deterministic figure-extraction engine for an earnings "print watch". You read ONE earnings document and report, for a fixed list of contract lines, exactly what that document states — nothing more.

NON-NEGOTIABLE RULES

1. NEVER guess and NEVER compute. Report only figures the document prints. Do NOT derive EPS from net income and a share count. Do NOT compute a margin from two other numbers. Do NOT compute a growth rate from two columns. Do NOT convert a range into a midpoint or a midpoint into a range. If the figure is not printed, it is not disclosed.
2. A metric the document does not state -> return that metric_id with not_disclosed = true and no value. Abstention is a CORRECT answer. A wrong number is far worse than a missing one.
3. BASIS must match the contract exactly. GAAP and non-GAAP / adjusted figures are DIFFERENT metrics. If the contract asks for non-GAAP and the document prints only GAAP (or the reverse), that is not_disclosed — never substitute.
4. PERIOD must match the contract exactly. Documents carry prior-year comparatives, six-month / year-to-date columns, and forward guidance. Pick the column or row that matches the contract's period. If only a different period is printed, that is not_disclosed.
5. SEGMENT must match. A consolidated figure is not a segment figure, and a segment figure is not consolidated.
6. UNITS — "value" must be normalized to the contract's unit and currency:
   - absolute currency amount -> whole units. A table headed "in millions" printing 1,234.5 means 1234500000. A release sentence saying "$1.23 billion" means 1230000000.
   - per-share amount -> the per-share number as printed (1.23).
   - percent -> the percent as printed, NOT the decimal (12.3, never 0.123).
   - count (shares, customers, employees, stores) -> the whole count, expanding any "in millions/thousands" table scale.
   - basis points -> as printed.
7. SIGN: parentheses or a leading minus mean negative. A loss is negative.
8. RANGES (guidance): value = the LOW end, value_high = the HIGH end, both normalized. "at least X" / "approximately X" / "greater than X" -> value = X and no value_high. Never invent the missing end of a range.
9. GUIDANCE SUPERSESSION: a document may print BOTH a PRIOR guidance range and an UPDATED (revised — reaffirmed, raised, or lowered) guidance range for the same metric side by side, in the same table or paragraph. When prior and updated ranges both appear, report the UPDATED range — never the prior one, even though the prior range sits right next to it for comparison. Note in location_hint which column/label you took.
10. raw_text = the figure exactly as printed, including $ signs, commas, %, parentheses, and any adjacent scale word.
11. snippet = at most 200 characters copied VERBATIM from the document text you were given, containing the figure. Copy it character for character. Never paraphrase and never reconstruct.
12. location_hint = where you found it. For a table representation use the table index plus the row label and column header, e.g. TABLE 3 | row "Total revenue" | col "Three Months Ended June 30, 2026". Otherwise use the nearest heading or section name.
13. Return EXACTLY ONE entry per contract metric_id — no extras, no duplicates, no invented metric ids. Use the metric_id string verbatim.

If two places in the document print the same metric and they disagree, report the one from the primary results table for the contract's period and say so in location_hint.`;

const TOOL_NAME = "emit_candidates";

// Every object node carries additionalProperties:false — Anthropic 400s without it.
const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Report one extraction candidate per contract metric_id, in the same order as the contract list.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        description: "Exactly one entry per contract metric_id.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            metric_id: {
              type: "string",
              description: "The contract metric_id, verbatim.",
            },
            not_disclosed: {
              type: "boolean",
              description:
                "true when this document does not state the metric on the contract's basis/period/segment.",
            },
            value: {
              type: "number",
              description:
                "Normalized to the contract unit (dollars not millions; percents as printed). Omit when not_disclosed.",
            },
            value_high: {
              type: "number",
              description: "High end of a printed range. Omit unless the document prints a range.",
            },
            raw_text: {
              type: "string",
              description: "The figure exactly as printed in the document.",
            },
            snippet: {
              type: "string",
              description:
                "Up to 200 characters copied verbatim from the document, containing the figure.",
            },
            location_hint: {
              type: "string",
              description:
                "Table index + row label + column header, or the nearest heading.",
            },
          },
          required: ["metric_id", "not_disclosed"],
        },
      },
    },
    required: ["candidates"],
  },
};

const MAX_OUTPUT_TOKENS = 16_384;

function buildUserMessage(contracts: LineContract[], representationText: string): string {
  return [
    "=== CONTRACT LINES (extract exactly these, one candidate each) ===",
    JSON.stringify(contracts, null, 2),
    "",
    "=== DOCUMENT ===",
    representationText,
    "=== END OF DOCUMENT ===",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// model resolution — never a hardcoded id
// ---------------------------------------------------------------------------

/**
 * This module has no db access, so it can never read the live model catalog
 * (unlike scripts/spike-bakeoff-parse.ts's readCachedModelCatalog peek).
 * resolveTier against an empty catalog already returns
 * TIER_STATIC_FALLBACK.workhorse (== SONNET_MODEL); the try/catch is
 * defensive parity with the spike, not load-bearing (resolveTier never
 * throws today).
 */
function resolveExtractionModelId(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return resolveTier("workhorse", []);
  } catch {
    return SONNET_MODEL;
  }
}

function defaultClient(): AnthropicLike {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for print-watch extraction (extractCandidates) — pass opts.anthropic to inject a client instead.",
    );
  }
  return new Anthropic({ apiKey, maxRetries: 2 });
}

// ---------------------------------------------------------------------------
// candidate parsing (defensive — ported from scripts/spike-bakeoff-parse.ts)
// ---------------------------------------------------------------------------

/**
 * Replace C0 control characters with spaces. Models intermittently emit raw
 * unescaped control characters inside JSON string literals ("Bad control
 * character in string literal") — same retry precedent as
 * lib/ai/extract-json.ts and lib/securities/verify-sector-tags.ts.
 */
function stripC0(text: string): string {
  let out = "";
  for (const ch of text) out += ch.charCodeAt(0) < 32 ? " " : ch;
  return out;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
    const n = Number(cleaned);
    if (Number.isFinite(n) && cleaned.trim() !== "") return n;
  }
  return null;
}

function asText(v: unknown, cap: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

function normalizeCandidates(input: unknown): ParseCandidate[] {
  if (!input || typeof input !== "object") return [];
  const rawList = (input as Record<string, unknown>).candidates;
  if (!Array.isArray(rawList)) return [];
  const out: ParseCandidate[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const metricId = asText(obj.metric_id, 200);
    if (!metricId) continue;
    const value = asNumber(obj.value);
    const notDisclosed =
      obj.not_disclosed === true ||
      obj.not_disclosed === "true" ||
      (obj.not_disclosed === undefined && value === null);
    out.push({
      metric_id: metricId,
      not_disclosed: notDisclosed,
      value: notDisclosed ? null : value,
      value_high: notDisclosed ? null : asNumber(obj.value_high),
      raw_text: asText(obj.raw_text, 400),
      snippet: asText(obj.snippet, 200),
      location_hint: asText(obj.location_hint, 400),
    });
  }
  return out;
}

/** Fallback path when the model answered in prose instead of the forced tool. */
function candidatesFromText(text: string): ParseCandidate[] {
  const stripped = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const attempt = (s: string): ParseCandidate[] => {
    const parsed: unknown = JSON.parse(s);
    if (Array.isArray(parsed)) return normalizeCandidates({ candidates: parsed });
    return normalizeCandidates(parsed);
  };
  const objStart = stripped.indexOf("{");
  const objEnd = stripped.lastIndexOf("}");
  const arrStart = stripped.indexOf("[");
  const arrEnd = stripped.lastIndexOf("]");
  const slices: string[] = [];
  // A bare top-level `[...]` response wraps a nested `{...}` (the candidate
  // object itself). If the object slice were tried first, JSON.parse on it
  // succeeds (it's a legally-formed object) but normalizeCandidates finds no
  // `.candidates` property on it and legitimately returns [] WITHOUT
  // throwing — which would short-circuit this loop before the real array
  // slice ever runs. Try whichever delimiter pair is OUTERMOST first so the
  // true payload gets first crack.
  const arrayIsOuter = arrStart !== -1 && arrEnd > arrStart && (objStart === -1 || arrStart <= objStart);
  if (arrayIsOuter) {
    slices.push(stripped.slice(arrStart, arrEnd + 1));
    if (objStart !== -1 && objEnd > objStart) slices.push(stripped.slice(objStart, objEnd + 1));
  } else {
    if (objStart !== -1 && objEnd > objStart) slices.push(stripped.slice(objStart, objEnd + 1));
    if (arrStart !== -1 && arrEnd > arrStart) slices.push(stripped.slice(arrStart, arrEnd + 1));
  }
  for (const slice of slices) {
    let result: ParseCandidate[] | null = null;
    try {
      result = attempt(slice);
    } catch {
      // Frontier models intermittently emit raw C0 control characters inside
      // string literals ("Bad control character in string literal"). Same
      // retry precedent as lib/securities/verify-sector-tags.ts.
      try {
        result = attempt(stripC0(slice));
      } catch {
        result = null; // try the next slice
      }
    }
    // Only stop at a slice that actually produced candidates — an empty
    // result from a slice that parsed but wasn't the real payload (see
    // above) must fall through to the next slice, not be treated as done.
    if (result && result.length > 0) return result;
  }
  return [];
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Extract one ParseCandidate per contract metric_id from a single document
 * representation. No db anywhere in this module: `contracts` and
 * `representationText` are the entire input surface — the caller (an
 * adapter + lib/print-watch/contracts.ts) resolves everything else.
 *
 * One malformed/empty response (no tool_use candidates AND no parseable
 * text fallback) gets ONE retry against the model. If both attempts fail —
 * a thrown API error or a response with zero parseable candidates — this
 * throws rather than silently returning an empty array, so a full-contract
 * miss surfaces as an error the caller can record, not a silently-empty
 * result that looks like "everything not_disclosed".
 */
export async function extractCandidates(
  contracts: LineContract[],
  representationText: string,
  opts: { model?: string; anthropic?: AnthropicLike } = {},
): Promise<ParseCandidate[]> {
  const modelId = resolveExtractionModelId(opts.model);
  const client = opts.anthropic ?? defaultClient();
  return callExtraction(
    client,
    modelId,
    buildUserMessage(contracts, representationText),
    "extractCandidates",
  );
}

/**
 * The ONE model call, shared by every reading (text or PDF). Takes the user
 * message as either a plain string (a text representation) or a content-block
 * array (a `document` block plus the contract text) — everything else about
 * the call, including the system prompt, the forced tool and the one retry, is
 * identical, because the readings must differ only in HOW the document reaches
 * the model, never in what it is asked to do.
 *
 * One malformed/empty response (no tool_use candidates AND no parseable text
 * fallback) gets ONE retry. If both attempts fail this throws rather than
 * returning an empty array, so a full-contract miss surfaces as an error the
 * caller can record instead of looking like "everything not_disclosed".
 */
async function callExtraction(
  client: AnthropicLike,
  modelId: string,
  content: string | Anthropic.ContentBlockParam[],
  /** Which READING is calling. It reaches `parse_last_error` and, from
   *  there, the panel's parse_failed copy — so a PDF's native reading must
   *  not report itself under the text reading's name. */
  label: string,
): Promise<ParseCandidate[]> {
  let lastCandidates: ParseCandidate[] = [];
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        // No temperature: sampling parameters are rejected on the current
        // Sonnet tier. Thinking off = the production fast-parse.
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content }],
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 1) continue;
      throw lastError;
    }

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    let candidates: ParseCandidate[] = toolBlock ? normalizeCandidates(toolBlock.input) : [];

    if (candidates.length === 0) {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      if (textBlock) candidates = candidatesFromText(textBlock.text);
    }

    if (candidates.length > 0) return candidates;

    lastCandidates = candidates;
    lastError = new Error(
      `${label}: no candidates parsed from model response (stop_reason=${response.stop_reason ?? "null"})`,
    );
  }

  if (lastCandidates.length === 0 && lastError) throw lastError;
  return lastCandidates;
}

/** The PDF twin of `buildUserMessage`: the document is the attachment, so the
 *  text half carries only the contract lines and says where the document is.
 *  Like its sibling it has no slot for `expected` — the bogey numbers cannot
 *  reach this prompt because the signature never receives them. */
function buildPdfUserMessage(contracts: LineContract[]): string {
  return [
    "=== CONTRACT LINES (extract exactly these, one candidate each) ===",
    JSON.stringify(contracts, null, 2),
    "",
    "=== DOCUMENT ===",
    "(the document is the attached PDF)",
    "=== END OF DOCUMENT ===",
  ].join("\n");
}

/**
 * Reading TWO of a PDF: the bytes themselves as a Claude `document` block
 * (the `lib/research-documents/extract.ts` path), with the SAME system
 * prompt and the SAME forced tool as the text road. Its candidates are
 * tagged `pdfNative` and — until the holdout pre-registered in
 * `docs/DECISIONS.md` (2026-09-02) passes — carry `weak_pair`, so agreeing
 * with the poppler reading caps the line at single_source rather than
 * greening it.
 */
export async function extractCandidatesFromPdf(
  contracts: LineContract[],
  pdfBytes: Buffer,
  opts: { model?: string; anthropic?: AnthropicLike } = {},
): Promise<ParseCandidate[]> {
  const modelId = resolveExtractionModelId(opts.model);
  const client = opts.anthropic ?? defaultClient();
  return callExtraction(
    client,
    modelId,
    [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") },
      },
      { type: "text", text: buildPdfUserMessage(contracts) },
    ],
    "extractCandidatesFromPdf",
  );
}
