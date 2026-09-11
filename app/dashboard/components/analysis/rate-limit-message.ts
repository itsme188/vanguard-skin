/**
 * Shared 429 wording for the Analysis AI cards.
 *
 * The generate routes answer a rate-limited POST with the bare API token
 * `"rate-limited"`, which means nothing to a reader — NarrativeBlock has always
 * translated it, and the Macro-this-week card printed the token itself as its
 * whole body until 2026-09-10. One formatter, two subjects, so the two cards
 * cannot drift apart.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Render a POST route's 429 `retryAfter` (ms) as domain language.
 *
 * Hours round UP, so "about 3h" always means "at most 3h left", never "just
 * over 2". A missing / non-numeric / non-positive `retryAfter` — and any short
 * cooldown under an hour, such as the macro route's 10-minute failure window —
 * falls into the "less than 1h" branch.
 *
 * @param subject the sentence subject WITH its verb ("Narrative refreshes",
 *   "Macro themes refresh"), so the caller owns number agreement.
 */
export function formatRateLimitMessage(subject: string, retryAfterMs: unknown): string {
  const ms = typeof retryAfterMs === "number" && retryAfterMs > 0 ? retryAfterMs : 0;
  if (ms < MS_PER_HOUR) {
    return `${subject} once per day — available again in less than 1h.`;
  }
  const hours = Math.ceil(ms / MS_PER_HOUR);
  return `${subject} once per day — available again in about ${hours}h.`;
}
