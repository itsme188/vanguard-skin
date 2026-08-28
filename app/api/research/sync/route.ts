import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillArticleHtml, backfillSourceUrls } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { extractLevelsFromNewArticles } from "@/lib/alerts/extract-newsletter-levels";
import { extractBogeysFromNewArticles } from "@/lib/earnings/extract-newsletter-bogeys";
import {
  reconcileCloudFetchedNewsletters,
  postMacRecentNewsletterSyncMarker,
} from "@/lib/research/reconcile-cloud-fetched";
import {
  acquireResearchSyncLock,
  releaseResearchSyncLock,
  alreadyRunningMessage,
  type SyncRunner,
} from "@/lib/research/sync-lock";

/**
 * Which caller is asking. TWO different clients POST this same route: the
 * manual "Sync Feeds" button and the automatic background refresh in
 * lib/hooks/useResearchSync.ts. Only the hook labels itself, by sending
 * `X-Sync-Runner: background`; anything else (absent, blank, unknown, or a
 * value we don't recognise) is treated as the user's own manual click.
 *
 * WHY IT MATTERS: the runner is what `alreadyRunningMessage` names in the 409
 * body. Acquiring as "manual" for every request told a user who collided with
 * the AUTOMATIC pass "A sync you already started is still running" — a sync
 * they never started. Fail-safe direction is "manual": mislabelling a real
 * manual click as background would be the more confusing error.
 */
const RUNNER_HEADER = "X-Sync-Runner";

function runnerFromRequest(req: Request): SyncRunner {
  const raw = req.headers.get(RUNNER_HEADER)?.trim().toLowerCase();
  return raw === "background" ? "background" : "manual";
}

/**
 * POST /api/research/sync — Fetch and process newsletter articles from Gmail.
 * Returns SSE stream with progress events.
 */
export async function POST(req: Request) {
  if (!isGmailConfigured()) {
    // Project envelope is {success:false, error} — the bare {error} this used
    // to return meant any caller gating on `data.success` found nothing to
    // report (qa: sync-feeds silent-400 regression). The client reads both.
    return Response.json(
      { success: false, error: "Gmail OAuth not configured" },
      { status: 400 }
    );
  }

  // Refuse to start a second overlapping pass — the AI stages are
  // select-then-spend, so two runs racing the same unprocessed batch pay
  // for it twice. See lib/research/sync-lock.ts for the full rationale.
  const lock = acquireResearchSyncLock(runnerFromRequest(req));
  if (!lock.ok) {
    return Response.json(
      { success: false, error: alreadyRunningMessage(lock.heldBy), code: "already_running" },
      { status: 409 }
    );
  }

  // Everything from here to the returned Response runs with the lock HELD, and
  // the only release path is the stream's `finally`. A synchronous throw while
  // building the encoder/stream would skip that finally entirely and strand the
  // lock for the life of the process — every later sync would 409 forever with
  // no way back short of a restart. So construction is wrapped: any throw
  // releases first, then rethrows.
  let readable: ReadableStream<Uint8Array>;
  try {
    const encoder = new TextEncoder();

    readable = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        };

        try {
          // Phase 0: Drain any cloud-fetched newsletter payloads first so the
          // local fetchNewArticles dedups (gmail_message_id UNIQUE) against
          // them and we don't burn Claude tokens on the same message twice.
          const cronSecret = process.env.CRON_SHARED_SECRET ?? "";
          if (cronSecret) {
            try {
              send({ phase: "reconcile-cloud", status: "started" });
              const reconcileResult = await reconcileCloudFetchedNewsletters(db, cronSecret);
              send({
                phase: "reconcile-cloud",
                status: "done",
                reconciled: reconcileResult.reconciled,
                skipped: reconcileResult.skipped_already_in_db,
              });
            } catch (err) {
              send({
                phase: "reconcile-cloud",
                status: "error",
                message: err instanceof Error ? err.message : "Cloud reconcile failed",
              });
            }
          }

          // Phase 1: Fetch new articles from Gmail
          send({ phase: "fetch", status: "started" });
          const gmail = getGmailClient();
          const fetchResult = await fetchNewArticles(db, gmail);
          send({
            phase: "fetch",
            status: "done",
            fetched: fetchResult.fetched,
            sources: fetchResult.sources,
          });

          // Post the recency marker fire-and-forget so the Worker skips its
          // next tick. Don't await on errors — never block the sync stream.
          if (cronSecret) {
            void postMacRecentNewsletterSyncMarker(cronSecret);
          }

          // Phase 2: AI-process unprocessed articles
          if (fetchResult.fetched > 0 || true) {
            // Always process — there may be articles from previous fetches
            send({ phase: "process", status: "started" });
            const processResult = await processUnprocessedArticles(db);
            send({
              phase: "process",
              status: "done",
              processed: processResult.processed,
              failed: processResult.failed,
            });
          }

          // Phase 3: Backfill HTML for older articles missing it
          const backfillResult = await backfillArticleHtml(db, gmail);
          if (backfillResult.updated > 0) {
            send({
              phase: "backfill",
              status: "done",
              updated: backfillResult.updated,
            });
          }

          // Phase 3.5: Re-try URL extraction for articles missing source_url
          const urlsBackfilled = backfillSourceUrls(db);
          if (urlsBackfilled > 0) {
            send({
              phase: "urls",
              status: "done",
              updated: urlsBackfilled,
            });
          }

          // Phase 4: Extract price levels from the newly-processed articles
          // for the user's held + watchlist symbols. Tolerant of Claude errors
          // — a failure here shouldn't abort the whole sync.
          try {
            send({ phase: "levels", status: "started" });
            const levelsResult = await extractLevelsFromNewArticles(db);
            send({
              phase: "levels",
              status: "done",
              articlesScanned: levelsResult.articlesScanned,
              levelsInserted: levelsResult.levelsInserted,
              levelsSkipped: levelsResult.levelsSkipped,
            });
          } catch (err) {
            send({
              phase: "levels",
              status: "error",
              message: err instanceof Error ? err.message : "Level extraction failed",
            });
          }

          // Phase 5: Extract earnings bogeys (EPS/rev consensus + whisper) for
          // upcoming held/watchlist reporters from the same newly-processed
          // articles. Same try/catch discipline as the levels step above — a
          // bogey-extraction failure never fails the sync.
          try {
            send({ phase: "bogeys", status: "started" });
            const bogeysResult = await extractBogeysFromNewArticles(db);
            send({
              phase: "bogeys",
              status: "done",
              articlesScanned: bogeysResult.articlesScanned,
              bogeysStored: bogeysResult.bogeysStored,
              eventsMatched: bogeysResult.eventsMatched,
            });
          } catch (err) {
            send({
              phase: "bogeys",
              status: "error",
              message: err instanceof Error ? err.message : "Bogey extraction failed",
            });
          }

          send({
            phase: "complete",
            totalFetched: fetchResult.fetched,
            sources: fetchResult.sources,
          });
        } catch (err) {
          send({
            phase: "error",
            message: err instanceof Error ? err.message : "Sync failed",
          });
        } finally {
          // Release BEFORE close — a throwing controller.close() must never
          // strand the lock for the next caller.
          releaseResearchSyncLock(lock.token);
          controller.close();
        }
      },
    });
  } catch (err) {
    // Construction threw with the lock already held — release it before the
    // error propagates, or this process can never run a research sync again.
    releaseResearchSyncLock(lock.token);
    throw err;
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
