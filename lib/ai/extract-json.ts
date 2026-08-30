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

/** Fence-strip only — the shared first step of both parse paths below. */
function stripFences(text: string): string {
  return text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

/**
 * `JSON.parse` with the project-standard C0-control-character retry.
 *
 * Models intermittently emit raw, unescaped control characters (usually a
 * literal newline) INSIDE a string literal, which `JSON.parse` rejects with
 * "Bad control character in string literal" / "Unterminated string". Legal JSON
 * only carries C0 controls between tokens as whitespace, so collapsing them to
 * spaces cannot corrupt valid input. Same defense as
 * lib/compute/classify-securities.ts (its original inline retry),
 * lib/securities/verify-sector-tags.ts and lib/compute/macro-themes.ts.
 *
 * Throws the ORIGINAL error when the retry also fails, so a truncation
 * signature is not masked by the retry error.
 */
function parseWithControlCharRetry(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText);
  } catch (parseErr) {
    try {
      return JSON.parse(jsonText.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      throw parseErr;
    }
  }
}

/**
 * Coerce a parsed JSON value into the list of items the caller asked for:
 *
 * - an array: itself
 * - a single object that looks like an item (has a string `symbol` key):
 *   wrapped in a one-element array
 * - a wrapper object with exactly one array-valued property
 *   (`{"results":[...]}`, `{"securities":[...]}`): that array
 *
 * Returns null for anything else, so the caller can try the next strategy or
 * throw a plain-English error.
 */
function itemsFromParsed(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.symbol === "string") return [obj];
    const arrayValues = Object.values(obj).filter((v): v is unknown[] => Array.isArray(v));
    if (arrayValues.length === 1) return arrayValues[0];
  }
  return null;
}

/**
 * Like `extractJsonArray`, but returns parsed items and tolerates the shapes an
 * LLM commonly returns for a one-item batch instead of the requested array.
 *
 * Order matters: the WHOLE stripped reply is parsed FIRST, so an object reply is
 * recognized as an object. The first-`[` … last-`]` slice would otherwise mangle
 * it — `{"symbol":"SILC","notes":["a","b"]}` slices down to `["a","b"]`, silently
 * losing the item, and a wrapper object only ever reached the array path by
 * accident. Only when whole-text parsing fails (a prose preamble or trailing
 * remark around a real array) do we fall back to the slice.
 *
 * Both parse attempts carry the C0-control-character retry.
 *
 * Anything else — prose, an object with no list inside it, invalid JSON —
 * throws a plain-English error instead of leaking a raw `TypeError`/
 * `SyntaxError` message to callers that surface it verbatim (e.g. as an API
 * error string shown to the user). The underlying parse error is preserved as
 * `cause` for logs.
 *
 * @param what plural noun for the error message, e.g. "sector classifications".
 */
export function parseJsonArrayLenient(text: string, what = "classifications"): unknown[] {
  const stripped = stripFences(text);
  let firstErr: unknown;

  try {
    const whole = itemsFromParsed(parseWithControlCharRetry(stripped));
    if (whole) return whole;
  } catch (err) {
    firstErr = err;
  }

  const sliced = extractJsonArray(stripped);
  if (sliced !== stripped) {
    try {
      const fromSlice = itemsFromParsed(parseWithControlCharRetry(sliced));
      if (fromSlice) return fromSlice;
    } catch (err) {
      if (firstErr === undefined) firstErr = err;
    }
  }

  throw new Error(
    `AI reply was not a JSON list of ${what}`,
    firstErr === undefined ? undefined : { cause: firstErr }
  );
}
