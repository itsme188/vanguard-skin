/**
 * Long-email ingestion caps — single source (R2 audit, 2026-07-03).
 *
 * Gmail's REST fetch (format:"full") returns complete bodies — the web UI's
 * ~102KB "View entire message" clipping is cosmetic. All truncation in this
 * pipeline is self-inflicted, so these caps are the only thing standing
 * between a long weekly (Eliant Capital, Semi Doped) and its summary: 48
 * live articles sat clipped at the old 50k store cap, and the extraction
 * prompt saw only the first 15k chars, so summaries reflected roughly the
 * opening 15% of the email for months.
 *
 * Cost note: 150k chars ≈ 37k tokens ≈ $0.11/article of Sonnet input — a
 * few long weeklies per week. Storage is local SQLite; the store caps are
 * pathological-email insurance, not a budget.
 */

export const RAW_TEXT_STORE_CAP = 500_000;
export const RAW_HTML_STORE_CAP = 500_000;
export const EXTRACTION_PROMPT_CHAR_CAP = 150_000;

/** Cap text for an AI prompt, marking the cut so the model knows it's partial. */
export function truncateForPrompt(
  text: string,
  cap: number = EXTRACTION_PROMPT_CHAR_CAP,
): string {
  return text.length > cap ? text.slice(0, cap) + "\n...[truncated]" : text;
}
