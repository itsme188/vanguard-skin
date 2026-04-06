import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { generateDailyDigest } from "@/lib/digest/daily-digest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";

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
    });
  } catch (err) {
    console.error("[digest/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
