import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { extractLevelsFromNewArticles } from "@/lib/alerts/extract-newsletter-levels";
import { extractBogeysFromNewArticles } from "@/lib/earnings/extract-newsletter-bogeys";
import {
  reconcileCloudFetchedNewsletters,
  postMacRecentNewsletterSyncMarker,
} from "@/lib/research/reconcile-cloud-fetched";
import { ingestForwardedDocuments, makeIngestDeps } from "@/lib/research-inbox/ingest";
import { RESEARCH_INBOX_ADDRESS } from "@/lib/research-inbox/config";

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
 * Newsletter level-extraction, then earnings bogey-extraction, run at the
 * end. Failures in either don't fail the whole call — the 90-min cadence
 * will catch up next tick.
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
    // Drain Worker cloud-fetched newsletter KV entries FIRST so the local
    // fetch below dedups (UNIQUE gmail_message_id). Failures here don't
    // abort the whole sync — next tick retries.
    let cloudReconciled = 0;
    let cloudSkipped = 0;
    try {
      const reconcileResult = await reconcileCloudFetchedNewsletters(db, expected);
      cloudReconciled = reconcileResult.reconciled;
      cloudSkipped = reconcileResult.skipped_already_in_db;
    } catch (err) {
      console.error("[cron/research-sync] cloud reconcile failed:", err);
    }

    const gmail = getGmailClient();
    const fetchResult = await fetchNewArticles(db, gmail);
    // Fire-and-forget — never block on Worker RTT.
    void postMacRecentNewsletterSyncMarker(expected);

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

    // Same best-effort discipline as the levels step above — a bogey
    // extraction failure never fails the whole cron call.
    let bogeysStored = 0;
    let bogeysScanned = 0;
    try {
      const bogeysResult = await extractBogeysFromNewArticles(db);
      bogeysStored = bogeysResult.bogeysStored;
      bogeysScanned = bogeysResult.articlesScanned;
    } catch (err) {
      console.error("[cron/research-sync] bogey extraction failed:", err);
    }

    // Forward-to-research inbox (U6): ingest anything forwarded to the research
    // address into research_documents. Best-effort — failures don't fail the sync.
    let inboxIngested = 0;
    let inboxFailed = 0;
    try {
      const inboxResult = await ingestForwardedDocuments(
        db,
        makeIngestDeps(gmail, RESEARCH_INBOX_ADDRESS),
      );
      inboxIngested = inboxResult.ingested;
      inboxFailed = inboxResult.failed;
    } catch (err) {
      console.error("[cron/research-sync] inbox ingest failed:", err);
    }

    return Response.json({
      success: true,
      cloudReconciled,
      cloudSkipped,
      fetched: fetchResult.fetched,
      sources: fetchResult.sources,
      processed: processResult.processed,
      processFailed: processResult.failed,
      levelsScanned,
      levelsInserted,
      bogeysScanned,
      bogeysStored,
      inboxIngested,
      inboxFailed,
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
