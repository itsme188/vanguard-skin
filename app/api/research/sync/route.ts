import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillArticleHtml } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";

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
