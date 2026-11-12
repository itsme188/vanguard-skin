/**
 * Request options that differ by model GENERATION (2026-11-12).
 *
 * Some settings are valid on one generation and a 400 on the next: a call
 * site that may run on either (the tiers still fall back to Sonnet 4.6 /
 * Opus 4.8 / Haiku 4.5, the catalog already reaches the 5.5 ids) asks here
 * instead of hard-coding one shape. Pure; reads only the model id. Rules
 * from the Claude API reference's thinking & effort table, checked
 * 2026-11-12:
 *   - Sonnet 5.5: `thinking: {type:"disabled"}` is a 400; "thinking off" is
 *     `{type:"between_tools"}` (no other field, effort high or below).
 *   - Opus 5.5, Fable, Mythos: thinking cannot be turned off at all; the
 *     lowest-latency request lowers `effort` instead.
 *   - Haiku 5.5, Opus 5: `disabled` is accepted at effort high or below.
 *   - Older ids (Sonnet 4.6, Sonnet 5, Opus 4.8, Haiku 4.5): `disabled`.
 *   - `effort` errors on Haiku 4.5 and Sonnet 4.5.
 */
import { parseModelId } from "@/lib/ai/model-tiers";

export type EffortLevel = "low" | "medium" | "high" | "max";

/** `between_tools` postdates the installed SDK's typings (0.78.0); see the extractor. */
export type FastThinking = { type: "disabled" } | { type: "between_tools" };

export interface FastRequestOptions {
  thinking?: FastThinking;
  effort?: "low";
}

function atLeast(version: number[], floor: number[]): boolean {
  const len = Math.max(version.length, floor.length);
  for (let i = 0; i < len; i++) {
    const a = version[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The request fragment for a fast structured call with no reasoning wanted
 * (the print-time extractor). Merge `thinking` into the request and `effort`
 * into `output_config`.
 */
export function fastStructuredRequestOptions(modelId: string): FastRequestOptions {
  const parsed = parseModelId(modelId);
  if (!parsed) return { thinking: { type: "disabled" } };
  const { family, version } = parsed;
  if (family === "fable" || family === "mythos") return { effort: "low" };
  if (family === "opus" && atLeast(version, [5, 5])) return { effort: "low" };
  if (family === "sonnet" && atLeast(version, [5, 5])) return { thinking: { type: "between_tools" } };
  return { thinking: { type: "disabled" } };
}

/** Whether the model accepts `output_config.effort`. */
export function supportsEffort(modelId: string): boolean {
  const parsed = parseModelId(modelId);
  if (!parsed) return false;
  const { family, version } = parsed;
  if (family === "fable" || family === "mythos") return true;
  if (family === "opus") return atLeast(version, [4, 5]);
  if (family === "sonnet") return atLeast(version, [4, 6]);
  if (family === "haiku") return atLeast(version, [5, 5]);
  return false;
}

/** `{ effort }` when the model accepts it, else `{}` — spread it into the options. */
export function effortOption(modelId: string, level: EffortLevel): { effort?: EffortLevel } {
  return supportsEffort(modelId) ? { effort: level } : {};
}
