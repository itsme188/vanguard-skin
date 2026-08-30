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

/**
 * Like `extractJsonArray`, but tolerates the shapes an LLM commonly returns
 * for a one-item batch instead of the requested JSON array:
 *
 * - a bare array: returned as-is
 * - a single object that looks like an item itself (has a string `symbol`
 *   key): wrapped in a one-element array
 * - a wrapper object whose single array-valued property holds the list
 *   (e.g. `{"results":[...]}`, `{"securities":[...]}`): that array
 *
 * Anything else — prose, an object with no list inside it, invalid JSON —
 * throws a plain-English error instead of leaking a raw `TypeError`/
 * `SyntaxError` message to callers that surface it verbatim (e.g. as an API
 * error string shown to the user).
 */
export function parseJsonArrayLenient(text: string): unknown[] {
  const jsonText = extractJsonArray(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error("AI reply was not a list of classifications", { cause: err });
  }

  if (Array.isArray(parsed)) return parsed;

  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.symbol === "string") return [obj];
    const arrayValues = Object.values(obj).filter((v): v is unknown[] => Array.isArray(v));
    if (arrayValues.length === 1) return arrayValues[0];
  }

  throw new Error("AI reply was not a list of classifications");
}
