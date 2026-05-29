import type Database from "better-sqlite3";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillSourceUrls } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import {
  generateDigestSinceAdaptive,
  getLastDigestSentAt,
  setLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { syncPortfolio } from "@/lib/tws/positions";
import { getRecipientsFor } from "@/lib/queries/email-recipients";

export class EveningSendError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "EveningSendError";
  }
}

export interface SendEveningOpts {
  recipient?: string;
  footerNote?: string;
  /**
   * When true, skip writing `last_digest_sent_at` after a successful send.
   * Mirrors the same option on sendDigestEmail — used by catch-up / manual
   * triggers that shouldn't claim the shared marker slot.
   */
  skipMarkerUpdate?: boolean;
}

export type SendEveningResult =
  | {
      success: true;
      skipped: true;
      reason: string;
      synced: { fetched: number; processed: number };
    }
  | {
      success: true;
      skipped?: false;
      sentTo: string;
      synced: { fetched: number; processed: number };
      title: string;
      twsSynced: boolean;
    };

export async function sendEveningEmail(
  db: Database.Database,
  opts: SendEveningOpts = {}
): Promise<SendEveningResult> {
  const overrides = getRecipientsFor(db, "evening");
  const recipient =
    opts.recipient ??
    (overrides ? overrides.join(", ") : null) ??
    process.env.BRIEFING_EMAIL_TO;

  if (!recipient) {
    throw new EveningSendError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400
    );
  }

  // Capture digest range boundaries BEFORE the slow fetch/process step.
  // Otherwise a concurrent manual trigger that completes during our
  // fetch+process window will update `last_digest_sent_at` to "now" and
  // our subsequent range query would return a future-of-our-articles cutoff
  // — silently producing zero matches and a skip.
  // Mirror of the same race-guard in send-digest.ts (lines 82-93).
  const sinceSnapshot = (() => {
    const lastSent = getLastDigestSentAt(db);
    const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return lastSent || fallback;
  })();

  let twsSynced = false;
  try {
    await syncPortfolio(db);
    twsSynced = true;
  } catch {
    console.log(
      "[send-evening] TWS sync skipped (not connected or no IBKR account)"
    );
  }

  const synced = { fetched: 0, processed: 0 };
  if (isGmailConfigured()) {
    const gmail = getGmailClient();
    const fetchResult = await fetchNewArticles(db, gmail);
    synced.fetched = fetchResult.fetched;

    if (fetchResult.fetched > 0) {
      const processResult = await processUnprocessedArticles(db);
      synced.processed = processResult.processed;
    }
  }

  backfillSourceUrls(db);

  const digest = await generateDigestSinceAdaptive(db, sinceSnapshot, {
    includeAnomalies: true,
  });

  if (!digest) {
    return {
      success: true,
      skipped: true,
      reason: "No articles, alerts, or anomalies in the window",
      synced,
    };
  }

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const title = `Evening Recap — ${dateStr}`;
  const html = briefingToHtml(digest, title, opts.footerNote);

  try {
    await sendEmail({
      to: recipient,
      subject: `\u{1F4CA} ${title}`,
      html,
      fromLocalPart: "evening",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new EveningSendError(`Send failed: ${msg}`, 500);
  }

  if (!opts.skipMarkerUpdate) {
    setLastDigestSentAt(db, new Date().toISOString());
  }

  return {
    success: true,
    sentTo: recipient,
    synced,
    title,
    twsSynced,
  };
}
