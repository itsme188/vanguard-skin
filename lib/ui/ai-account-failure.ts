/**
 * Client-safe reader for an AI ACCOUNT failure reported by a route
 * (QA finding: the Analysis AI controls answered an out-of-credit outage with
 * "try again in a few minutes").
 *
 * The server decides the kind with `accountFailureOf` and words it with
 * `aiUnavailableReason(kind)` (lib/earnings/ai-unavailable.ts). That module
 * imports the Anthropic SDK and the enrichment classifier, so a client
 * component cannot import it; this file holds the two facts the client needs
 * (the sentence prefix and the kind list) and nothing else. Parity with the
 * server module is pinned by tests/dashboard/refresh-failure-message-ai-account.test.ts.
 *
 * A route reports the failure as HTTP 503 with
 * `{ success: false, error: aiUnavailableReason(kind), reason: "ai_account" }`
 * (an SSE route: `{ error, aiAccount: true }`). The sentence's tail
 * ("waiting; no attempt counted") is written for the earnings prepare steps,
 * so a surface shows only its head, "AI unavailable (<kind>)", plus the
 * non-retry clause from `aiAccountRetryClause`.
 */
import type { AccountFailureKind } from "@/lib/earnings/ai-unavailable";

/** The `reason` a JSON route sends with its 503. */
export const AI_ACCOUNT_FAILURE_REASON = "ai_account";

/** Mirrors `AI_UNAVAILABLE_REASON_PREFIX` (parity-pinned). */
export const AI_UNAVAILABLE_PREFIX = "AI unavailable (";

export const AI_ACCOUNT_KINDS: ReadonlySet<AccountFailureKind> = new Set<AccountFailureKind>([
  "billing",
  "auth",
  "rate_limit",
  "outage",
  "network",
  "config",
]);

/** The kinds that pass by themselves (the same split as the hub notice). */
const TRANSIENT_KINDS: ReadonlySet<AccountFailureKind> = new Set<AccountFailureKind>([
  "rate_limit",
  "outage",
  "network",
]);

export interface AiAccountFailure {
  /** Null when the route flagged the failure but the sentence named no known kind. */
  kind: AccountFailureKind | null;
  /** "AI unavailable (billing)" — the head of the server sentence, no tail. */
  head: string;
}

/**
 * The account failure a route reported, or null. Recognised by the `reason`
 * flag (or the SSE `aiAccount` flag) or by the sentence prefix itself.
 */
export function readAiAccountFailure(
  data: { error?: unknown; reason?: unknown; aiAccount?: unknown } | null | undefined,
): AiAccountFailure | null {
  if (!data) return null;
  const error = typeof data.error === "string" ? data.error : "";
  const flagged = data.reason === AI_ACCOUNT_FAILURE_REASON || data.aiAccount === true;
  const prefixed = error.startsWith(AI_UNAVAILABLE_PREFIX);
  if (!flagged && !prefixed) return null;
  if (prefixed) {
    const word = error.slice(AI_UNAVAILABLE_PREFIX.length).split(")")[0];
    if (AI_ACCOUNT_KINDS.has(word as AccountFailureKind)) {
      const kind = word as AccountFailureKind;
      return { kind, head: `${AI_UNAVAILABLE_PREFIX}${kind})` };
    }
  }
  return { kind: null, head: "AI unavailable" };
}

/** Says when a retry can work; never "try again in a few minutes". */
export function aiAccountRetryClause(failure: AiAccountFailure): string {
  return failure.kind && TRANSIENT_KINDS.has(failure.kind)
    ? "Retry once the AI service recovers."
    : "Retry once the account is restored.";
}
