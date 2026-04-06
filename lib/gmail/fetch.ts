import type { gmail_v1 } from "googleapis";
import type Database from "better-sqlite3";
import { stripHtml } from "../vital-knowledge";

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

  const insertArticle = db.prepare(`
    INSERT OR IGNORE INTO research_articles
      (source_id, gmail_message_id, gmail_thread_id, received_at, subject, sender, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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

        const result = insertArticle.run(
          source.id,
          detail.messageId,
          detail.threadId,
          detail.receivedAt,
          detail.subject,
          detail.sender,
          detail.body
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

  // Parse date to ISO format
  let receivedAt: string;
  try {
    receivedAt = new Date(dateStr).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    receivedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  // Extract body — prefer text/plain, fall back to text/html (stripped)
  const body = extractBody(msg.data.payload);
  if (!body || body.trim().length < 50) return null; // skip empty/tiny messages

  return {
    messageId: msg.data.id || messageId,
    threadId: msg.data.threadId || "",
    receivedAt,
    subject,
    sender,
    body: body.slice(0, 50_000), // Cap at 50K chars
  };
}

function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined
): string {
  if (!payload) return "";

  // Single-part message
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf-8");
    if (payload.mimeType === "text/html") return stripHtml(decoded);
    return decoded;
  }

  // Multipart — walk parts looking for text/plain first, then text/html
  if (payload.parts) {
    // Prefer text/plain
    const plain = findPart(payload.parts, "text/plain");
    if (plain) return plain;

    // Fall back to text/html (stripped)
    const html = findPart(payload.parts, "text/html");
    if (html) return stripHtml(html);

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return "";
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
