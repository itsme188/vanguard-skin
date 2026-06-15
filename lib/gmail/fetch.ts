import type { gmail_v1 } from "googleapis";
import type Database from "better-sqlite3";
import { stripHtml } from "../vital-knowledge";
import { sanitizeNewsletterHtml, normalizeNewsletterHtml } from "./sanitize";
import { extractSourceUrl } from "./extract-url";
import { checkShortCircuit } from "./short-circuit";

/**
 * Fetch new newsletter articles from Gmail for all active research sources.
 * Inserts into research_articles with gmail_message_id dedup.
 * Returns count of new articles inserted.
 */
export async function fetchNewArticles(
  db: Database.Database,
  gmail: gmail_v1.Gmail
): Promise<{ fetched: number; sources: string[] }> {
  const sources = db
    .prepare(
      `SELECT id, name, sender_email, sender_pattern, subject_pattern, max_age_days
       FROM research_sources WHERE is_active = 1 AND sender_email IS NOT NULL`
    )
    .all() as {
    id: number;
    name: string;
    sender_email: string | null;
    sender_pattern: string | null;
    subject_pattern: string | null;
    max_age_days: number;
  }[];

  if (sources.length === 0) return { fetched: 0, sources: [] };

  // is_relevant defaults to 1 (DB default), so omitting it for the happy
  // path keeps existing behavior. The short-circuit branch below uses a
  // dedicated insert that flips is_relevant=0 + tags excluded_category/reason
  // so the D5 audit UI (future slice) can surface filtered rows.
  const insertArticle = db.prepare(`
    INSERT OR IGNORE INTO research_articles
      (source_id, gmail_message_id, gmail_thread_id, received_at, subject, sender, raw_text, raw_html, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertExcluded = db.prepare(`
    INSERT OR IGNORE INTO research_articles
      (source_id, gmail_message_id, gmail_thread_id, received_at, subject, sender, raw_text, raw_html, source_url,
       is_relevant, excluded_category, excluded_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);

  let totalFetched = 0;
  const sourcesProcessed: string[] = [];

  for (const source of sources) {
    try {
      const query = buildGmailQuery(source);
      const messages = await listMessages(gmail, query);

      let sourceFetched = 0;
      for (const msg of messages) {
        const detail = await getMessageDetail(gmail, msg.id!);
        if (!detail) continue;

        const sourceUrl = extractSourceUrl(detail.html, detail.body, detail.sender);

        // Pre-Claude short-circuit. Inserts the row as `is_relevant=0` so
        // processUnprocessedArticles + digest queries can filter it out
        // cheaply. Body content is still persisted so the D5 audit UI can
        // surface the full email if the user wants to flip it back.
        const sc = checkShortCircuit(detail.subject);
        const result = sc.excluded
          ? insertExcluded.run(
              source.id,
              detail.messageId,
              detail.threadId,
              detail.receivedAt,
              detail.subject,
              detail.sender,
              detail.body,
              detail.html,
              sourceUrl,
              sc.category,
              sc.reason,
            )
          : insertArticle.run(
              source.id,
              detail.messageId,
              detail.threadId,
              detail.receivedAt,
              detail.subject,
              detail.sender,
              detail.body,
              detail.html,
              sourceUrl,
            );

        if (result.changes > 0) sourceFetched++;
      }

      if (sourceFetched > 0) {
        sourcesProcessed.push(`${source.name} (${sourceFetched})`);
        totalFetched += sourceFetched;
      }
    } catch (err) {
      console.error(
        `[research] Failed to fetch from "${source.name}":`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { fetched: totalFetched, sources: sourcesProcessed };
}

/**
 * Backfill raw_html for existing articles that have gmail_message_id but no raw_html.
 * Re-fetches the HTML from Gmail and updates the row.
 */
export async function backfillArticleHtml(
  db: Database.Database,
  gmail: gmail_v1.Gmail
): Promise<{ updated: number; failed: number }> {
  const articles = db
    .prepare(
      `SELECT id, gmail_message_id FROM research_articles
       WHERE gmail_message_id IS NOT NULL AND raw_html IS NULL
       ORDER BY received_at DESC`
    )
    .all() as { id: number; gmail_message_id: string }[];

  if (articles.length === 0) return { updated: 0, failed: 0 };

  const updateHtml = db.prepare(
    `UPDATE research_articles SET raw_html = ? WHERE id = ?`
  );

  let updated = 0;
  let failed = 0;

  for (const article of articles) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: article.gmail_message_id,
        format: "full",
      });

      const { html } = extractBody(msg.data.payload);
      if (html) {
        updateHtml.run(
          normalizeNewsletterHtml(sanitizeNewsletterHtml(html)).slice(0, 200_000),
          article.id,
        );
        updated++;
      }
    } catch {
      failed++;
    }
  }

  return { updated, failed };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildGmailQuery(source: {
  sender_email: string | null;
  sender_pattern: string | null;
  subject_pattern: string | null;
  max_age_days: number;
}): string {
  const parts: string[] = [];

  if (source.sender_email) {
    parts.push(`from:${source.sender_email}`);
  }

  // Gmail search uses "newer_than:Nd" for age filtering
  parts.push(`newer_than:${source.max_age_days}d`);

  return parts.join(" ");
}

async function listMessages(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults = 20
): Promise<gmail_v1.Schema$Message[]> {
  const response = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  return response.data.messages || [];
}

interface MessageDetail {
  messageId: string;
  threadId: string;
  receivedAt: string;
  subject: string;
  sender: string;
  body: string;
  html: string | null;
}

async function getMessageDetail(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<MessageDetail | null> {
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = msg.data.payload?.headers || [];
  const subject =
    headers.find((h) => h.name?.toLowerCase() === "subject")?.value ||
    "(no subject)";
  const sender =
    headers.find((h) => h.name?.toLowerCase() === "from")?.value || "unknown";
  const dateStr =
    headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

  // Parse the Gmail `Date:` header. RFC 2822 is normally reliable, but a
  // malformed header previously fell back silently to `new Date()` (now),
  // poisoning `received_at` with a future timestamp. That breaks digest
  // filtering (`datetime('now') > received_at`) and re-scans. Prefer to
  // drop the message than to store a fabricated timestamp.
  const parsed = new Date(dateStr).getTime();
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[gmail/fetch] Dropping message ${messageId}: unparseable Date header "${dateStr}"`,
    );
    return null;
  }
  const receivedAt = new Date(parsed).toISOString().replace("T", " ").slice(0, 19);

  // Extract body text and original HTML (if available)
  const { text, html } = extractBody(msg.data.payload);
  if (!text || text.trim().length < 50) return null; // skip empty/tiny messages

  return {
    messageId: msg.data.id || messageId,
    threadId: msg.data.threadId || "",
    receivedAt,
    subject,
    sender,
    body: text.slice(0, 50_000), // Cap at 50K chars
    html: html ? normalizeNewsletterHtml(sanitizeNewsletterHtml(html)).slice(0, 200_000) : null,
  };
}

function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined
): { text: string; html: string | null } {
  if (!payload) return { text: "", html: null };

  // Single-part message
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf-8");
    if (payload.mimeType === "text/html") {
      return { text: stripHtml(decoded), html: decoded };
    }
    return { text: decoded, html: null };
  }

  // Multipart — extract both plain text and HTML
  if (payload.parts) {
    const plain = findPart(payload.parts, "text/plain");
    const htmlRaw = findPart(payload.parts, "text/html");

    if (plain) {
      return { text: plain, html: htmlRaw };
    }
    if (htmlRaw) {
      return { text: stripHtml(htmlRaw), html: htmlRaw };
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested.text) return nested;
    }
  }

  return { text: "", html: null };
}

function findPart(
  parts: gmail_v1.Schema$MessagePart[],
  mimeType: string
): string | null {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
  }
  return null;
}

/**
 * Backfill source_url for existing articles that have raw_html or raw_text but no source_url.
 * Extracts "View in browser" / article URLs from the stored HTML and plaintext.
 */
export function backfillSourceUrls(db: Database.Database): number {
  const articles = db
    .prepare(
      `SELECT id, raw_html, raw_text, sender FROM research_articles
       WHERE (raw_html IS NOT NULL OR raw_text IS NOT NULL) AND source_url IS NULL`
    )
    .all() as {
    id: number;
    raw_html: string | null;
    raw_text: string | null;
    sender: string | null;
  }[];

  if (articles.length === 0) return 0;

  const update = db.prepare(
    `UPDATE research_articles SET source_url = ? WHERE id = ?`
  );

  let updated = 0;
  for (const article of articles) {
    const url = extractSourceUrl(article.raw_html, article.raw_text, article.sender);
    if (url) {
      update.run(url, article.id);
      updated++;
    }
  }

  return updated;
}
