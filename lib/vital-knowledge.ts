import { ImapFlow, type MessageStructureObject } from "imapflow";

const VK_SENDER = "updates@vitalknowledge.net";
const MAX_EMAILS = 5;
const MAX_CHARS_PER_EMAIL = 3000;
const MAX_TOTAL_CHARS = 8000;

// ---------- Helpers ----------

/** Strip HTML tags, style/script blocks, and decode common entities. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Walk MIME tree to find a part with the given content type (e.g. "text/plain"). */
export function findPart(
  node: MessageStructureObject,
  contentType: string
): string | null {
  if (node.type === contentType && node.part) return node.part;
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const found = findPart(child, contentType);
      if (found) return found;
    }
  }
  return null;
}

// ---------- Main ----------

/**
 * Fetch recent Vital Knowledge digest emails from Gmail via IMAP.
 * Returns formatted market context string, or "" on any failure.
 */
export async function fetchVitalKnowledge(
  gmailAddress: string,
  gmailAppPassword: string,
  lookbackDays: number = 7
): Promise<string> {
  if (!gmailAddress || !gmailAppPassword) return "";

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: gmailAddress, pass: gmailAppPassword },
    logger: false,
    socketTimeout: 30_000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);

      const uids = await client.search({ from: VK_SENDER, since }, { uid: true });
      if (!uids || uids.length === 0) return "";

      // Most recent N emails
      const recentUids = uids.slice(-MAX_EMAILS);

      const emails: { date: Date; subject: string; text: string }[] = [];

      for (const uid of recentUids) {
        const msg = await client.fetchOne(String(uid), {
          uid: true,
          envelope: true,
          bodyStructure: true,
        } as Parameters<typeof client.fetchOne>[1], { uid: true });

        if (!msg || !msg.bodyStructure) continue;

        // Prefer text/html (stripped) — newsletter text/plain is full of image URLs and junk
        const htmlPartId = findPart(msg.bodyStructure, "text/html");
        const plainPartId = findPart(msg.bodyStructure, "text/plain");
        const partId = htmlPartId ?? plainPartId;
        if (!partId) continue;

        const { content } = await client.download(String(uid), partId, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        let body = Buffer.concat(chunks).toString("utf-8");

        // Strip HTML tags when using the HTML part
        if (htmlPartId && partId === htmlPartId) {
          body = stripHtml(body);
        }

        if (body.length > MAX_CHARS_PER_EMAIL) {
          body = body.slice(0, MAX_CHARS_PER_EMAIL) + "...[truncated]";
        }

        emails.push({
          date: msg.envelope?.date ? new Date(String(msg.envelope.date)) : new Date(),
          subject: msg.envelope?.subject || "(no subject)",
          text: body,
        });
      }

      if (emails.length === 0) return "";

      // Chronological order (oldest first)
      emails.sort((a, b) => a.date.getTime() - b.date.getTime());

      const sections = emails.map((e) => {
        const dateStr = e.date.toISOString().split("T")[0];
        return `[${dateStr}] ${e.subject}\n${e.text}`;
      });

      let combined = sections.join("\n\n---\n\n");
      if (combined.length > MAX_TOTAL_CHARS) {
        combined = combined.slice(0, MAX_TOTAL_CHARS) + "\n...[truncated]";
      }

      return combined;
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(
      `[VK] Failed to fetch Vital Knowledge emails: ${err instanceof Error ? err.message : err}`
    );
    return "";
  } finally {
    await client.logout().catch(() => {});
  }
}
