/**
 * Forward-to-research ingestion orchestrator (U6).
 *
 * For each forwarded Gmail message not yet processed: classify → run each job
 * through the matching extractor → createResearchDocument → record the outcome
 * (dedup + audit). Per-message try/catch so one bad message never blocks the
 * rest. DI-shaped (like level-scan / newsletter-fetch): `makeIngestDeps` wires
 * the real Gmail + Claude extractors; tests inject stubs.
 */
import type Database from "better-sqlite3";
import type { gmail_v1 } from "googleapis";
import {
  classifyForwardedEmail,
  type ParsedForwardedEmail,
  type ExtractionJob,
} from "./classify";
import { getProcessedInboxMessageIds } from "@/lib/queries/research-inbox";
import { recordInboxMessage } from "@/lib/mutations/research-inbox";
import {
  createResearchDocument,
  type CreateResearchDocumentInput,
} from "@/lib/mutations/research-documents";
import {
  extractResearchPdf,
  type ExtractedResearchDocument,
} from "@/lib/research-documents/extract";
import {
  extractFromImage,
  extractFromText,
  extractFromUrl,
} from "@/lib/research-documents/extract-forwarded";
import { listInboxMessageIds, getForwardedEmail } from "./gmail-inbox";
import {
  sanitizeNewsletterHtml,
  normalizeNewsletterHtml,
} from "@/lib/gmail/sanitize";

type ImageMedia = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface IngestDeps {
  listMessageIds: (days: number) => Promise<string[]>;
  getEmail: (id: string) => Promise<ParsedForwardedEmail>;
  extractPdf: (bytes: Uint8Array) => Promise<ExtractedResearchDocument>;
  extractImage: (bytes: Uint8Array, media: ImageMedia) => Promise<ExtractedResearchDocument>;
  extractUrl: (url: string) => Promise<ExtractedResearchDocument>;
  extractText: (text: string) => Promise<ExtractedResearchDocument>;
}

export interface IngestResult {
  ingested: number; // documents created
  failed: number; // messages that errored
  skipped: number; // already-processed or nothing-to-ingest
  documentIds: number[];
}

export async function ingestForwardedDocuments(
  db: Database.Database,
  deps: IngestDeps,
  opts?: { days?: number },
): Promise<IngestResult> {
  const days = opts?.days ?? 14;
  const ids = await deps.listMessageIds(days);
  const processed = getProcessedInboxMessageIds(db);

  let ingested = 0;
  let failed = 0;
  let skipped = 0;
  const documentIds: number[] = [];

  for (const id of ids) {
    if (processed.has(id)) {
      skipped++;
      continue;
    }
    let email: ParsedForwardedEmail | null = null;
    try {
      email = await deps.getEmail(id);
      const jobs = classifyForwardedEmail(email);
      if (jobs.length === 0) {
        recordInboxMessage(db, {
          gmail_message_id: id,
          status: "done",
          document_count: 0,
          subject: email.subject,
          from_addr: email.from,
        });
        skipped++;
        continue;
      }

      const created: number[] = [];
      for (const job of jobs) {
        const doc = await runJob(job, deps);
        const docId = createResearchDocument(db, toInput(doc, job, email));
        created.push(docId);
      }

      documentIds.push(...created);
      ingested += created.length;
      recordInboxMessage(db, {
        gmail_message_id: id,
        status: "done",
        document_id: created[0],
        document_count: created.length,
        subject: email.subject,
        from_addr: email.from,
      });
    } catch (err) {
      failed++;
      recordInboxMessage(db, {
        gmail_message_id: id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        subject: email?.subject ?? null,
        from_addr: email?.from ?? null,
      });
    }
  }

  return { ingested, failed, skipped, documentIds };
}

function runJob(job: ExtractionJob, deps: IngestDeps): Promise<ExtractedResearchDocument> {
  switch (job.kind) {
    case "pdf":
      return deps.extractPdf(job.attachment.bytes);
    case "image":
      return deps.extractImage(job.attachment.bytes, toImageMedia(job.attachment.mimeType));
    case "link":
      return deps.extractUrl(job.url);
    case "body":
      return deps.extractText(job.text);
  }
}

function toImageMedia(mime: string): ImageMedia {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "image/jpeg";
  if (m.includes("gif")) return "image/gif";
  if (m.includes("webp")) return "image/webp";
  return "image/png";
}

function toInput(
  doc: ExtractedResearchDocument,
  job: ExtractionJob,
  email: ParsedForwardedEmail,
): CreateResearchDocumentInput {
  const tags = Array.from(new Set([...(doc.tags ?? []), "forwarded"]));

  let filename = "forwarded";
  let fileSize: number | null = null;
  if (job.kind === "pdf" || job.kind === "image") {
    filename = job.attachment.filename;
    fileSize = job.attachment.bytes.byteLength;
  } else if (job.kind === "link") {
    filename = job.url.slice(0, 300);
  } else {
    filename = (email.subject ?? doc.title ?? "forwarded").slice(0, 200);
  }

  return {
    title: doc.title,
    author: doc.author,
    source: doc.source ?? (email.from ? `Forwarded · ${email.from}` : "Forwarded"),
    filename,
    file_size_bytes: fileSize,
    publication_date: doc.publication_date,
    document_type: doc.document_type,
    raw_text: doc.raw_text,
    summary: doc.summary,
    key_points: doc.key_points,
    mentioned_symbols: doc.mentioned_symbols,
    tags,
    sentiment: doc.sentiment,
    target_prices: doc.target_prices,
    ai_model: doc.ai_model,
    char_count: doc.raw_text.length,
    processing_state: "ready",
  };
}

/**
 * Production deps: real Gmail reads + Claude extractors. The link extractor
 * falls back to a plain fetch + sanitize when Claude's web_fetch is unavailable
 * or errors, so a forwarded link still produces a document.
 */
export function makeIngestDeps(
  gmail: gmail_v1.Gmail,
  address: string,
): IngestDeps {
  return {
    listMessageIds: (days) => listInboxMessageIds(gmail, address, days),
    getEmail: (id) => getForwardedEmail(gmail, id),
    extractPdf: (bytes) => extractResearchPdf(bytes),
    extractImage: (bytes, media) => extractFromImage(bytes, media),
    extractText: (text) => extractFromText(text),
    extractUrl: async (url) => {
      try {
        return await extractFromUrl(url);
      } catch {
        // Fallback: fetch the page ourselves, sanitize, let Claude read the HTML.
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (PortfolioDesk research inbox)" },
        });
        const html = await res.text();
        const cleaned = normalizeNewsletterHtml(sanitizeNewsletterHtml(html));
        const doc = await extractFromText(cleaned || html);
        return { ...doc, source: doc.source ?? hostOf(url) };
      }
    },
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}
