/**
 * Shared "the refresh did not succeed" wording for the Analysis AI cards.
 *
 * Both cards (NarrativeBlock and the Macro-this-week card) POST to a generate
 * route that answers a rate limit with the bare API token `"rate-limited"`,
 * which means nothing to a reader, and answers other failures with a server
 * message that may carry model prose. Each card used to translate that on its
 * own — NarrativeBlock properly, the Macro card not at all, which is how the
 * token became the whole card body (2026-09-10 QA) and how a raw provider
 * string reached the surface in red.
 *
 * This module is the ONE translator. A card supplies a `RefreshSubject` (the
 * two or three noun phrases that differ between them) plus the HTTP status and
 * response body; everything else — the sentence shapes, the minute/hour
 * rounding, the decision to drop raw server/model text — lives here, so the
 * cards cannot drift apart again.
 *
 * Statuses: 429 is the rate limit (with a `reason` distinguishing the routes'
 * two different limits), 0 means "the request never completed" (the network
 * catch), anything else is a generic failure.
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * The card-specific noun phrases. Kept as data rather than a single string so
 * every sentence reads naturally with the right verb agreement, and so a card's
 * rendered strings stay byte-identical across this extraction.
 */
export interface RefreshSubject {
  /** Subject + verb inside the daily-limit sentence: "this narrative refreshes". */
  readonly limitClause: string;
  /** The failed action: "regenerate the narrative", "refresh macro themes". */
  readonly actionClause: string;
  /** Names the generation in the failure-cooldown sentence: "narrative". */
  readonly generationLabel: string;
}

export const NARRATIVE_SUBJECT: RefreshSubject = {
  limitClause: "this narrative refreshes",
  actionClause: "regenerate the narrative",
  generationLabel: "narrative",
};

export const MACRO_THEMES_SUBJECT: RefreshSubject = {
  limitClause: "macro themes refresh",
  actionClause: "refresh macro themes",
  generationLabel: "macro-themes",
};

/** The two different 429s a generate route can answer with. */
export type RateLimitReason = "daily" | "last_attempt_failed";

interface FailureBody {
  error?: unknown;
  /** ms left on the window the route enforced. */
  retryAfter?: unknown;
  /** Which limit fired; absent bodies are treated as the daily one. */
  reason?: unknown;
}

/**
 * How long is left, in words. Rounds UP so the figure always reads as "at most
 * this long", never "just over the smaller one". Returns null when the route
 * gave no usable figure, so the caller can drop the clause instead of printing
 * "in about 0h" or "in about NaN minutes".
 */
function waitPhrase(retryAfterMs: unknown): string | null {
  const ms =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : 0;
  if (ms <= 0) return null;
  if (ms < MS_PER_MINUTE) return "under a minute";
  if (ms < MS_PER_HOUR) {
    const minutes = Math.ceil(ms / MS_PER_MINUTE);
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `about ${Math.ceil(ms / MS_PER_HOUR)}h`;
}

/**
 * Domain-language status for a refresh that did NOT succeed (QA 2026-09-07,
 * finding analysis-factor-narrative--refresh-regenerate-429-silent-no-feedback;
 * QA 2026-09-10, analysis-macro-themes--...-bare-rate-limited-token).
 *
 * Every non-OK response and the network-level catch come through here, so a
 * card can never answer a click with silence, with a bare protocol token
 * ("rate-limited"), or with the browser's raw TypeError ("Failed to fetch").
 * Raw server/model text is deliberately DROPPED rather than echoed: a
 * generation failure carries model prose (and sometimes a provider's own error
 * string), and these cards render inside the privacy-masked analysis surfaces.
 *
 * `status` is the HTTP status, or 0 for "the request never completed".
 * A 429 body carries `retryAfter` in milliseconds — the only wait figure the
 * API offers, since neither route sends a Retry-After header — and `reason`,
 * which separates the once-a-day limit from the short cooldown a route applies
 * after its last generation attempt failed. Answering the second with the
 * first's copy told the user "refreshes once a day" when the real wait was ten
 * minutes and the real cause was a broken reply.
 */
export function describeRefreshFailure(
  subject: RefreshSubject,
  status: number,
  data: FailureBody | null | undefined,
): string {
  if (status === 429) {
    const phrase = waitPhrase(data?.retryAfter);
    if (data?.reason === "last_attempt_failed") {
      const opening = `The last ${subject.generationLabel} generation failed;`;
      return phrase
        ? `${opening} the next attempt opens in ${phrase}.`
        : `${opening} the next attempt opens shortly.`;
    }
    const limit = `Can't regenerate yet — ${subject.limitClause} once a day.`;
    return phrase ? `${limit} Try again in ${phrase}.` : `${limit} Try again later.`;
  }
  if (status === 0) {
    return `Couldn't ${subject.actionClause} — could not reach the server. Try again.`;
  }
  return `Couldn't ${subject.actionClause} — the request failed. Try again in a few minutes.`;
}

/**
 * Is this failure an EXPECTED state rather than a breakage? A rate limit is the
 * product working as designed, so the cards render it neutrally instead of in
 * the loss colour reserved for things that actually went wrong.
 */
export function isExpectedRefreshState(status: number): boolean {
  return status === 429;
}
