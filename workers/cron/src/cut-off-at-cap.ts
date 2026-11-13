/**
 * A reply that stopped at the output cap (finishReason "length") is
 * incomplete even when its text parses: never store it (2026-11-13). The
 * error is named like the Mac gateway's AITruncatedError
 * (lib/ai/generate.ts), so the mirrored classifier (enrichment-failure.ts)
 * reads it as article-level malformed_output, never as an AI outage.
 *
 * Its own import-free module, not ai.ts: several tests replace ./ai wholesale.
 */
export function throwIfCutOffAtCap(feature: string, finishReason: string | undefined): void {
  if (finishReason !== "length") return;
  const err = new Error(`AI output truncated at the token limit for feature "${feature}"`);
  err.name = "AITruncatedError";
  throw err;
}
