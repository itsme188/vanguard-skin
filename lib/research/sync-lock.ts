/**
 * In-process lock for the research-sync pipeline.
 *
 * WHY: three separate callers can trigger the identical research-sync
 * pipeline (fetchNewArticles -> processUnprocessedArticles -> extract
 * newsletter levels -> extract earnings bogeys) at any time:
 *   1. The manual "Sync Feeds" button -> POST /api/research/sync
 *   2. The background auto-refresh (lib/hooks/useResearchSync.ts), which
 *      POSTs the SAME route on a timer/mount effect
 *   3. The launchd cron every 90 minutes -> POST /api/cron/research-sync
 *
 * The AI stages in that pipeline are SELECT-THEN-SPEND: they
 * `SELECT ... WHERE processed_at IS NULL LIMIT 20`, pay for a Claude call
 * per row, and only stamp `processed_at` (or the levels/bogeys equivalent)
 * AFTER the model call returns — see lib/gmail/process.ts (~lines 64-77
 * select, ~179/~220 stamp), lib/alerts/extract-newsletter-levels.ts, and
 * lib/earnings/extract-newsletter-bogeys.ts, which all share this shape.
 * Two runs that overlap select the SAME unprocessed batch before either has
 * stamped it, so they pay for (and re-process) it twice, and `bumpAttempts`
 * can double-count a single failure across the two runs.
 *
 * Commit 44adba4 made the Sync Feeds button clickable while a background
 * pass is already running, which widens this overlap window rather than
 * closing it.
 *
 * All three callers live in the same Next.js server process — this is a
 * single-user, local-first app, not a distributed system — so a plain
 * module-scoped variable is a sufficient lock. No DB row, no cross-process
 * coordination needed.
 */

export type SyncRunner = "manual" | "background" | "cron";

let currentRunner: SyncRunner | null = null;
let currentToken: symbol | null = null;

/** Who (if anyone) currently holds the research-sync lock. */
export function currentResearchSyncRunner(): SyncRunner | null {
  return currentRunner;
}

/** Take the lock, or report who already has it. */
export function acquireResearchSyncLock(
  runner: SyncRunner,
): { ok: true; token: symbol } | { ok: false; heldBy: SyncRunner } {
  if (currentRunner !== null) {
    return { ok: false, heldBy: currentRunner };
  }
  const token = Symbol(runner);
  currentRunner = runner;
  currentToken = token;
  return { ok: true, token };
}

/**
 * Release the lock, but only if `token` still owns it. A late release from
 * a finished run (e.g. a slow SSE stream's finally firing after a newer
 * run already acquired the lock) must never free a newer run's lock.
 */
export function releaseResearchSyncLock(token: symbol): void {
  if (currentToken === token) {
    currentRunner = null;
    currentToken = null;
  }
}

/** Domain-language wording for the 409 body / cron skip payload. */
export function alreadyRunningMessage(heldBy: SyncRunner): string {
  switch (heldBy) {
    case "background":
      return "A background refresh is still running — its new articles will appear here when it finishes. Nothing was skipped.";
    case "cron":
      return "The scheduled 90-minute research sync is still running — its new articles will appear here when it finishes. Nothing was skipped.";
    case "manual":
      return "A sync you already started is still running — its new articles will appear here when it finishes. Nothing was skipped.";
  }
}

/** Test-only: reset the module-scoped lock state between test cases. */
export function __resetResearchSyncLockForTests(): void {
  currentRunner = null;
  currentToken = null;
}
