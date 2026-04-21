import type Database from "better-sqlite3";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillSourceUrls } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import {
  generateDailyDigest,
  generateDigestSince,
  getLastDigestSentAt,
  setLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { syncPortfolio } from "@/lib/tws/positions";

export class DigestSendError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "DigestSendError";
  }
}

export type DigestMode = "today" | "since_last" | "since_date";

export interface SendDigestOpts {
  recipient?: string;
  mode?: DigestMode;
  sinceDate?: string;
  footerNote?: string;
}

export type SendDigestResult =
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

export async function sendDigestEmail(
  db: Database.Database,
  opts: SendDigestOpts = {}
): Promise<SendDigestResult> {
  const recipient = opts.recipient || process.env.BRIEFING_EMAIL_TO;

  if (!recipient) {
    throw new DigestSendError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400
    );
  }

  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailAddress || !gmailAppPassword) {
    throw new DigestSendError(
      "Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD env vars.",
      500
    );
  }

  let twsSynced = false;
  try {
    await syncPortfolio(db);
    twsSynced = true;
  } catch {
    console.log("[send-digest] TWS sync skipped (not connected or no IBKR account)");
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

  let digest: string | null;
  if (opts.mode === "today") {
    const today = new Date().toISOString().slice(0, 10);
    digest = generateDigestSince(db, today);
  } else if (opts.mode === "since_last") {
    const lastSent = getLastDigestSentAt(db);
    const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    digest = generateDigestSince(db, lastSent || fallback);
  } else if (opts.mode === "since_date" && opts.sinceDate) {
    digest = generateDigestSince(db, opts.sinceDate);
  } else {
    digest = generateDailyDigest(db);
  }

  if (!digest) {
    return {
      success: true,
      skipped: true,
      reason: "No processed articles in the selected range",
      synced,
    };
  }

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const title = `Morning Research Digest — ${dateStr}`;
  const html = briefingToHtml(digest, title, opts.footerNote);

  await sendEmail(
    { gmailAddress, gmailAppPassword },
    recipient,
    `\u{1F4F0} ${title}`,
    html
  );

  setLastDigestSentAt(db, new Date().toISOString());

  return {
    success: true,
    sentTo: recipient,
    synced,
    title,
    twsSynced,
  };
}
