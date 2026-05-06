import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { extractLevelsFromNewArticles } from "@/lib/alerts/extract-newsletter-levels";

/**
 * POST /api/cron/research-sync — Cron-authenticated background research sync.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: ignored.
 *
 * Called by the Mac launchd `com.vanguard-skin.research-sync.plist` every
 * 90 minutes during market hours. Runs the same fetch + AI-process pipeline
 * as the user's manual sync, but does NOT send any email and does NOT stream
 * progress (SSE is for the UI; cron consumers prefer plain JSON).
 *
 * Newsletter level-extraction runs at the end. Failures there don't fail
 * the whole call — the 90-min cadence will catch up next tick.
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return Response.json(
      { error: "Server not configured: CRON_SHARED_SECRET missing." },
      { status: 500 },
    );
  }

  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isGmailConfigured()) {
    return Response.json(
      { error: "Gmail OAuth not configured" },
      { status: 400 },
    );
  }

  try {
    const gmail = getGmailClient();
    const fetchResult = await fetchNewArticles(db, gmail);
    const processResult = await processUnprocessedArticles(db);

    let levelsInserted = 0;
    let levelsScanned = 0;
    try {
      const levelsResult = await extractLevelsFromNewArticles(db);
      levelsInserted = levelsResult.levelsInserted;
      levelsScanned = levelsResult.articlesScanned;
    } catch (err) {
      console.error("[cron/research-sync] level extraction failed:", err);
    }

    return Response.json({
      success: true,
      fetched: fetchResult.fetched,
      sources: fetchResult.sources,
      processed: processResult.processed,
      processFailed: processResult.failed,
      levelsScanned,
      levelsInserted,
    });
  } catch (err) {
    console.error("[cron/research-sync] error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
