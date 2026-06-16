import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { ingestForwardedDocuments, makeIngestDeps } from "@/lib/research-inbox/ingest";
import { RESEARCH_INBOX_ADDRESS } from "@/lib/research-inbox/config";

export const dynamic = "force-dynamic";
// Inbox ingestion calls Claude per forwarded item (PDF/vision/web_fetch) — give
// the manual "Check inbox" trigger room to finish a small batch.
export const maxDuration = 300;

/**
 * POST /api/research/ingest-inbox — pull forwarded emails (to the research
 * inbox address) from Gmail and turn each into a research document. In-app
 * trigger for the "Check inbox" button; the cron research-sync runs the same
 * ingest automatically on its 90-min cadence.
 */
export async function POST() {
  if (!isGmailConfigured()) {
    return Response.json({ success: false, error: "Gmail OAuth not configured" }, { status: 400 });
  }
  try {
    const gmail = getGmailClient();
    const result = await ingestForwardedDocuments(
      db,
      makeIngestDeps(gmail, RESEARCH_INBOX_ADDRESS),
    );
    return Response.json({ success: true, address: RESEARCH_INBOX_ADDRESS, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Inbox ingest failed";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
