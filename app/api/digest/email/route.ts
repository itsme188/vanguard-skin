import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillSourceUrls } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { generateDailyDigest } from "@/lib/digest/daily-digest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { syncPortfolio } from "@/lib/tws/positions";

/**
 * POST /api/digest/email — Sync research feeds, generate daily digest, and email it.
 *
 * Body: { to?: string }
 *   - to: recipient email. Defaults to BRIEFING_EMAIL_TO env var.
 *
 * Flow: sync Gmail → AI-process articles → compile digest → send email.
 * Skips gracefully if no new articles in the last 24 hours.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const recipient = (body.to as string) || process.env.BRIEFING_EMAIL_TO;

  if (!recipient) {
    return Response.json(
      { error: "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'to' in body." },
      { status: 400 }
    );
  }

  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailAddress || !gmailAppPassword) {
    return Response.json(
      { error: "Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD env vars." },
      { status: 500 }
    );
  }

  // Best-effort TWS sync — freshen IBKR positions before generating digest
  let twsSynced = false;
  try {
    await syncPortfolio(db);
    twsSynced = true;
  } catch {
    console.log("[digest/email] TWS sync skipped (not connected or no IBKR account)");
  }

  try {
    // Step 1: Sync research feeds from Gmail (if configured)
    let synced = { fetched: 0, processed: 0 };
    if (isGmailConfigured()) {
      const gmail = getGmailClient();
      const fetchResult = await fetchNewArticles(db, gmail);
      synced.fetched = fetchResult.fetched;

      if (fetchResult.fetched > 0) {
        const processResult = await processUnprocessedArticles(db);
        synced.processed = processResult.processed;
      }
    }

    // Step 1.5: Backfill source URLs for articles missing them
    backfillSourceUrls(db);

    // Step 2: Generate digest from last 24h of processed articles
    const digest = generateDailyDigest(db);

    if (!digest) {
      return Response.json({
        success: true,
        skipped: true,
        reason: "No processed articles in last 24 hours",
        synced,
      });
    }

    // Step 3: Convert markdown to styled HTML
    const dateStr = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const title = `Morning Research Digest — ${dateStr}`;
    const html = briefingToHtml(digest, title);

    // Step 4: Send email
    await sendEmail(
      { gmailAddress, gmailAppPassword },
      recipient,
      `\u{1F4F0} ${title}`,
      html
    );

    return Response.json({
      success: true,
      sentTo: recipient,
      synced,
      title,
      twsSynced,
    });
  } catch (err) {
    console.error("[digest/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
