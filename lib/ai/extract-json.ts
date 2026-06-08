/**
 * Robustly extract a JSON array from an LLM response.
 *
 * Strips markdown code fences, then isolates the first `[` … last `]` slice so a
 * conversational preamble ("I need to classify these. Here is the result:") or a
 * trailing remark doesn't break `JSON.parse`. When no array delimiters are
 * present (the model returned only prose), the stripped text is returned
 * unchanged so the caller's `JSON.parse` still throws and the batch is recorded
 * as an error rather than silently swallowed.
 */
export function extractJsonArray(text: string): string {
  const stripped = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start !== -1 && end > start) return stripped.slice(start, end + 1);
  return stripped;
}
