import type Database from "better-sqlite3";
import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { fetchNewArticles, backfillSourceUrls } from "@/lib/gmail/fetch";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import {
  generateDigestSinceAdaptive,
  setLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { resolveDigestSince, defaultDigestSince } from "@/lib/digest/digest-window";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { syncPortfolio } from "@/lib/tws/positions";
import { getRecipientsFor } from "@/lib/queries/email-recipients";
import { recordDigestSkip } from "@/lib/digest/digest-skip";

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
  /**
   * When true, skip writing `last_digest_sent_at` after a successful send.
   * Used by manual catch-up flows (DigestCatchup) so that an in-flight cron
   * isn't poisoned by the catch-up's "now" timestamp. The race that this
   * guards against produced today's 8:45→8:57 duplicate-with-thin-content
   * email: cron fired and was still completing when the user manually sent
   * via the banner; the manual send's marker update made the cron's
   * sinceSnapshot read a future-of-its-articles value, and the Worker
   * fallback then re-fired with stale snapshot data.
   */
  skipMarkerUpdate?: boolean;
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
  const overrides = getRecipientsFor(db, "digest");
  const recipient =
    opts.recipient ??
    (overrides ? overrides.join(", ") : null) ??
    process.env.BRIEFING_EMAIL_TO;

  if (!recipient) {
    throw new DigestSendError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400
    );
  }

  // Capture digest range boundaries BEFORE the slow fetch/process step.
  // Otherwise a concurrent manual trigger that completes during our
  // fetch+process window will update `last_digest_sent_at` to "now" and
  // our subsequent getLastDigestSentAt() would return a future-of-our-
  // articles cutoff — silently producing zero matches and a "No processed
  // articles" skip. Same race produced 3 weekdays of mystery skips
  // (Apr 22 / 23 / 24 2026).
  const sinceSnapshot = resolveDigestSince(db, { mode: opts.mode, sinceDate: opts.sinceDate });

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

  const digest = sinceSnapshot !== null
    ? await generateDigestSinceAdaptive(db, sinceSnapshot, { includeAnomalies: false, edition: "morning" })
    : await generateDigestSinceAdaptive(db, defaultDigestSince(), { includeAnomalies: false, edition: "morning" });

  if (!digest) {
    const reason = "No processed articles in the selected range";
    // Record the skip so the catch-up banner can say "nothing new to send"
    // rather than "wasn't sent". Only the scheduled window (`since_last`, the
    // one the 8:45 job and the banner's own Send now use) counts: an empty
    // hand-picked range says nothing about the scheduled digest. Best effort:
    // a failed write must not turn a clean skip into an error.
    if (opts.mode === "since_last") {
      try {
        recordDigestSkip(db, reason);
      } catch (err) {
        console.warn("[send-digest] could not record the empty-window skip:", err);
      }
    }
    return {
      success: true,
      skipped: true,
      reason,
      synced,
    };
  }

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const title = `Morning Research Digest — ${dateStr}`;
  const html = briefingToHtml(digest, title, opts.footerNote);

  try {
    await sendEmail({
      to: recipient,
      subject: `\u{1F4F0} ${title}`,
      html,
      fromLocalPart: "digest",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DigestSendError(`Send failed: ${msg}`, 500);
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
