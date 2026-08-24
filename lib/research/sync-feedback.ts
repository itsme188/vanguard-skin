/**
 * Feedback state for the Research → Feeds "Sync Feeds" control.
 *
 * QA finding research-feeds-sync-feeds--silent-400-no-feedback-regression-4
 * (5th occurrence): clicking Sync Feeds with Gmail OAuth unconfigured reads as
 * completely inert — the route answers 400 and nothing changes on screen. The
 * message WAS being set, but three separate mechanisms made it invisible in
 * practice, and each previous point-fix only closed one of them:
 *
 *   1. The handler's `finally` scheduled an UNCONDITIONAL 5s auto-dismiss, so
 *      a hard failure evaporated on the same timer as a "Done — 3 new
 *      articles" toast.
 *   2. The background auto-sync (lib/hooks/useResearchSync.ts) shares the same
 *      status slot and could overwrite a standing error with "Refreshing in
 *      background…". Because the Gmail pre-flight short-circuits BEFORE
 *      stamping its localStorage debounce, that hook re-fires on every mount
 *      precisely when Gmail is unconfigured — the exact failing condition.
 *   3. The 400 body is a bare `{error}` rather than the project's
 *      `{success:false, error}` envelope, so a handler gating on
 *      `data.success` found nothing to report.
 *
 * Those three rules now live here as pure functions instead of being
 * re-derived inline in the component, so the regression has a test to trip
 * over. Zero UI/DB imports — directly unit-testable in Node.
 */

export type SyncTone = "progress" | "error";

export interface SyncFeedback {
  text: string;
  tone: SyncTone;
}

/** Transient progress/completion text. Safe to auto-dismiss. */
export function progressFeedback(text: string): SyncFeedback {
  return { text, tone: "progress" };
}

/** A failure the user must be able to read and act on. Sticky. */
export function errorFeedback(text: string): SyncFeedback {
  return { text, tone: "error" };
}

function readString(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The human message for a failed sync. Accepts BOTH the bare `{error}` shape
 * the sync route emits and the project-standard `{success:false, error}`
 * envelope, and always returns something non-empty — a blank status line is
 * indistinguishable from the silent failure this guards against.
 */
export function syncFailureText(status: number, body: unknown): string {
  return (
    readString(body, "error") ?? readString(body, "message") ?? `Sync failed (${status})`
  );
}

/** Minimal shape of the pieces of `Response` this needs — keeps the helper
 *  callable from a test with a hand-rolled stub as well as a real Response. */
export interface SyncFailureResponse {
  status: number;
  json: () => Promise<unknown>;
}

/**
 * Turn a non-ok `/api/research/sync` response into the error line to show.
 * The STATUS decides that it failed; the body only supplies the wording, so a
 * route answering 400 with a success-shaped body still reports a failure.
 */
export async function readSyncFailure(res: SyncFailureResponse): Promise<SyncFeedback> {
  const body = await res.json().catch(() => null);
  return errorFeedback(syncFailureText(res.status, body));
}

/** Rule 1: progress text fades on its own; an error stays until the user
 *  starts another sync. */
export function shouldAutoDismiss(feedback: SyncFeedback | null): boolean {
  return feedback?.tone === "progress";
}

/**
 * Rule 2: what the feedback slot should hold when `incoming` arrives while
 * `current` is displayed. Background progress may never bury a standing
 * error; everything else replaces. `null` is an explicit clear (a fresh
 * manual sync resetting the slot) and always wins.
 */
export function nextFeedback(
  current: SyncFeedback | null,
  incoming: SyncFeedback | null,
): SyncFeedback | null {
  if (incoming === null) return null;
  if (current?.tone === "error" && incoming.tone === "progress") return current;
  return incoming;
}
