/**
 * Read forwarded emails from Gmail for the research inbox (U6).
 *
 * Queries `to:<address>` so it picks up anything the user forwards to the
 * dedicated address (Cloudflare Email Routing drops `*@myportfoliodesk.com`
 * into the same Gmail the newsletter pipeline already reads). Reuses the
 * existing Gmail OAuth client (`gmail_v1.Gmail`).
 */
import type { gmail_v1 } from "googleapis";
import type { ParsedForwardedEmail, ForwardedAttachment } from "./classify";

// Don't pull attachments larger than Anthropic's 32 MB document cap.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export async function listInboxMessageIds(
  gmail: gmail_v1.Gmail,
  address: string,
  days: number,
  maxResults = 25,
): Promise<string[]> {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `to:${address} newer_than:${days}d`,
    maxResults,
  });
  return (res.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
}

export async function getForwardedEmail(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<ParsedForwardedEmail> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const payload = res.data.payload;
  const headers = payload?.headers ?? [];
  const subject = headerValue(headers, "Subject");
  const from = headerValue(headers, "From");

  const collected: { text: string[]; html: string[]; attachments: AttachmentRef[] } = {
    text: [],
    html: [],
    attachments: [],
  };
  walkPart(payload, collected);

  const bodyText =
    collected.text.join("\n\n").trim() ||
    htmlToText(collected.html.join("\n")).trim();

  const attachments = await fetchAttachments(gmail, messageId, collected.attachments);
  return { subject, from, bodyText, attachments };
}

// ─── internals ───────────────────────────────────────────────────

interface AttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string | null {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function decodeBody(data: string): string {
  // Gmail uses base64url (- and _).
  return Buffer.from(data, "base64url").toString("utf-8");
}

function walkPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: { text: string[]; html: string[]; attachments: AttachmentRef[] },
): void {
  if (!part) return;
  const mime = part.mimeType ?? "";
  const filename = part.filename ?? "";
  const attachmentId = part.body?.attachmentId ?? undefined;

  if (filename && attachmentId) {
    out.attachments.push({
      filename,
      mimeType: mime,
      attachmentId,
      size: part.body?.size ?? 0,
    });
  } else if (mime === "text/plain" && part.body?.data) {
    out.text.push(decodeBody(part.body.data));
  } else if (mime === "text/html" && part.body?.data) {
    out.html.push(decodeBody(part.body.data));
  }

  for (const child of part.parts ?? []) walkPart(child, out);
}

async function fetchAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string,
  refs: AttachmentRef[],
): Promise<ForwardedAttachment[]> {
  const out: ForwardedAttachment[] = [];
  for (const ref of refs) {
    if (ref.size > MAX_ATTACHMENT_BYTES) continue;
    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: ref.attachmentId,
    });
    const data = res.data.data;
    if (!data) continue;
    const bytes = new Uint8Array(Buffer.from(data, "base64url"));
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
    out.push({ filename: ref.filename, mimeType: ref.mimeType, bytes });
  }
  return out;
}

/** Crude HTML→text — enough for classification (length + URL detection). */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}
