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

/**
 * POST /api/research/sync — Fetch and process newsletter articles from Gmail.
 * Returns SSE stream with progress events.
 */
export async function POST() {
  if (!isGmailConfigured()) {
    return Response.json(
      { error: "Gmail OAuth not configured" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
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
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
