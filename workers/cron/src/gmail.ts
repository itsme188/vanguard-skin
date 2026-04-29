/**
 * Minimal Gmail REST client for the Worker — INBOUND ONLY.
 *
 * Why hand-rolled: googleapis isn't edge-compatible (uses Node core APIs).
 * We use OAuth refresh-token → access-token exchange against oauth2.googleapis.com,
 * then talk directly to gmail.googleapis.com. Access tokens live ~1h; we cache
 * them in CRON_KV with 55-min TTL.
 *
 * Outbound used to live here too (sendMessage); replaced by ./resend.ts in
 * 2026-04 because Gmail OAuth send is brittle (refresh token expires every
 * 6 months for unverified apps) and Resend gives us a verified custom-domain
 * sender with deliverability monitoring.
 *
 * Scope needed (set once during OAuth consent):
 *   - https://www.googleapis.com/auth/gmail.readonly  (newsletter fetch)
 */

const TOKEN_KV_KEY = "gmail-access-token";
const TOKEN_TTL_SECONDS = 55 * 60; // 55min — access tokens expire at 1h

export interface GmailEnv {
  CRON_KV: KVNamespace;
  WORKER_GMAIL_CLIENT_ID?: string;
  WORKER_GMAIL_CLIENT_SECRET?: string;
  WORKER_GMAIL_REFRESH_TOKEN?: string;
}

/** Fetch a fresh (or KV-cached) Gmail access token. Throws on missing creds. */
export async function getAccessToken(env: GmailEnv): Promise<string> {
  const cached = await env.CRON_KV.get(TOKEN_KV_KEY);
  if (cached) return cached;

  const { WORKER_GMAIL_CLIENT_ID, WORKER_GMAIL_CLIENT_SECRET, WORKER_GMAIL_REFRESH_TOKEN } = env;
  if (!WORKER_GMAIL_CLIENT_ID || !WORKER_GMAIL_CLIENT_SECRET || !WORKER_GMAIL_REFRESH_TOKEN) {
    throw new Error("Gmail OAuth env missing (WORKER_GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN).");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: WORKER_GMAIL_CLIENT_ID,
      client_secret: WORKER_GMAIL_CLIENT_SECRET,
      refresh_token: WORKER_GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  const token = json.access_token;
  if (!token) throw new Error("Gmail token refresh returned no access_token");

  await env.CRON_KV.put(TOKEN_KV_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS });
  return token;
}

// ── Messages ────────────────────────────────────────────────────────

export interface GmailMessageHeader {
  name?: string;
  value?: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
  headers?: GmailMessageHeader[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  payload?: GmailMessagePart;
}

export async function listMessages(
  accessToken: string,
  query: string,
  maxResults = 10
): Promise<{ id: string }[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(maxResults));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail list failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { messages?: { id: string }[] };
  return json.messages ?? [];
}

export async function getMessage(
  accessToken: string,
  messageId: string
): Promise<GmailMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail get failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as GmailMessage;
}

export interface ExtractedMessage {
  messageId: string;
  receivedAt: string;
  subject: string;
  sender: string;
  body: string;
  html: string | null;
}

export function extractMessage(msg: GmailMessage): ExtractedMessage | null {
  const headers = msg.payload?.headers ?? [];
  const subject = findHeader(headers, "subject") ?? "(no subject)";
  const sender = findHeader(headers, "from") ?? "unknown";
  const dateStr = findHeader(headers, "date") ?? "";

  let receivedAt: string;
  try {
    receivedAt = new Date(dateStr).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    receivedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  const { text, html } = extractBody(msg.payload);
  if (!text || text.trim().length < 50) return null;

  return {
    messageId: msg.id,
    receivedAt,
    subject,
    sender,
    body: text.slice(0, 50_000),
    html,
  };
}

function findHeader(headers: GmailMessageHeader[], name: string): string | undefined {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function extractBody(payload: GmailMessagePart | undefined): {
  text: string;
  html: string | null;
} {
  if (!payload) return { text: "", html: null };

  if (payload.body?.data) {
    const decoded = base64UrlDecode(payload.body.data);
    if (payload.mimeType === "text/html") {
      return { text: stripHtml(decoded), html: decoded };
    }
    return { text: decoded, html: null };
  }

  if (payload.parts) {
    const plain = findPartData(payload.parts, "text/plain");
    const htmlRaw = findPartData(payload.parts, "text/html");
    if (plain) return { text: plain, html: htmlRaw };
    if (htmlRaw) return { text: stripHtml(htmlRaw), html: htmlRaw };

    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested.text) return nested;
    }
  }

  return { text: "", html: null };
}

function findPartData(parts: GmailMessagePart[], mimeType: string): string | null {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) {
      return base64UrlDecode(part.body.data);
    }
  }
  return null;
}

// ── Base64 / HTML helpers (Workers-compatible — no Buffer) ──────────

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function stripHtml(html: string): string {
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
