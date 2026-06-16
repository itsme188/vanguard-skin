/**
 * Classify a forwarded email into one or more extraction jobs (U6).
 *
 * Pure + testable — no I/O. The ingest orchestrator (`ingest.ts`) feeds it a
 * parsed email and runs each returned job through the matching extractor.
 *
 * Precedence: real attachments win (a message can carry several → several
 * documents). With no usable attachment, a short "here's a link" email becomes
 * a `link` job; a substantial body becomes a `body` (long-read) job.
 */

export interface ForwardedAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ParsedForwardedEmail {
  subject: string | null;
  from: string | null;
  /** Plain-text body (HTML already stripped to text upstream). */
  bodyText: string;
  attachments: ForwardedAttachment[];
}

export type ExtractionJob =
  | { kind: "pdf"; attachment: ForwardedAttachment }
  | { kind: "image"; attachment: ForwardedAttachment }
  | { kind: "link"; url: string; note: string }
  | { kind: "body"; text: string };

// A body at/under this length with a link in it is treated as "just a link".
const LINK_ONLY_BODY_MAX = 800;
// A body at/over this length is substantial enough to ingest as a long-read.
const BODY_MIN = 200;

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
const PDF_MIME = /^application\/pdf$/i;

export function isPdfAttachment(a: ForwardedAttachment): boolean {
  return PDF_MIME.test(a.mimeType) || /\.pdf$/i.test(a.filename);
}
export function isImageAttachment(a: ForwardedAttachment): boolean {
  return IMAGE_MIME.test(a.mimeType) || /\.(png|jpe?g|gif|webp)$/i.test(a.filename);
}

/**
 * Pull plausible article URLs from plain text — http(s) only, excluding the
 * usual non-article noise (unsubscribe, list-management, mailto, tracking
 * pixels). First match is treated as the primary link.
 */
export function extractArticleUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>")\]]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?)]+$/, ""); // trailing punctuation
    if (seen.has(url)) continue;
    if (/unsubscribe|list-manage|mailto:|\/unsub|email-preferences|\.gif($|\?)|\.png($|\?)/i.test(url)) {
      continue;
    }
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function classifyForwardedEmail(email: ParsedForwardedEmail): ExtractionJob[] {
  const jobs: ExtractionJob[] = [];

  for (const a of email.attachments) {
    if (isPdfAttachment(a)) jobs.push({ kind: "pdf", attachment: a });
    else if (isImageAttachment(a)) jobs.push({ kind: "image", attachment: a });
    // other attachment types (calendar invites, vcards…) are ignored
  }
  if (jobs.length > 0) return jobs;

  const body = email.bodyText.trim();
  const urls = extractArticleUrls(body);

  // Short note that's essentially a forwarded link.
  if (urls.length > 0 && body.length <= LINK_ONLY_BODY_MAX) {
    return [{ kind: "link", url: urls[0], note: body }];
  }
  // Substantial body → ingest the email itself as a long-read.
  if (body.length >= BODY_MIN) {
    return [{ kind: "body", text: body }];
  }
  // Fallback: a link even inside a longer-but-still-thin body.
  if (urls.length > 0) {
    return [{ kind: "link", url: urls[0], note: body }];
  }
  return [];
}
