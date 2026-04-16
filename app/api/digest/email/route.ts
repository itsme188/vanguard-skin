import { db } from "@/lib/db";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillSourceUrls } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { generateDailyDigest, generateDigestSince, getLastDigestSentAt, setLastDigestSentAt } from "@/lib/digest/daily-digest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { syncPortfolio } from "@/lib/tws/positions";

/**
 * POST /api/digest/email — Sync research feeds, generate daily digest, and email it.
 *
 * Body: { to?: string, mode?: "today" | "since_last" | "since_date", sinceDate?: string }
 *   - to: recipient email(s), comma-separated. Defaults to BRIEFING_EMAIL_TO env var.
 *   - mode: date range mode. Default (omitted) = last 24 hours (backward-compatible with cron).
 *   - sinceDate: YYYY-MM-DD for "since_date" mode.
 *
 * Flow: sync Gmail → AI-process articles → compile digest → send email.
 * Skips gracefully if no articles in the selected range.
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

    // Step 2: Generate digest based on mode
    const mode = body.mode as string | undefined;
    let digest: string | null;

    if (mode === "today") {
      const today = new Date().toISOString().slice(0, 10);
      digest = generateDigestSince(db, today);
    } else if (mode === "since_last") {
      const lastSent = getLastDigestSentAt(db);
      const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      digest = generateDigestSince(db, lastSent || fallback);
    } else if (mode === "since_date" && body.sinceDate) {
      digest = generateDigestSince(db, body.sinceDate as string);
    } else {
      // Default: last 24 hours (backward-compatible with launchd cron)
      digest = generateDailyDigest(db);
    }

    if (!digest) {
      return Response.json({
        success: true,
        skipped: true,
        reason: "No processed articles in the selected range",
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

    // Record send timestamp for "since last email" mode
    setLastDigestSentAt(db, new Date().toISOString());

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
