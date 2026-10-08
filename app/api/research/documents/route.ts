import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import {
  listResearchDocuments,
  getResearchDocumentCount,
  type ResearchDocumentType,
} from "@/lib/queries/research-documents";
import {
  createResearchDocument,
  updateResearchDocumentRawText,
  markResearchDocumentProcessingFailed,
  claimResearchDocumentUpload,
  releaseResearchDocumentUploadClaim,
  type ResearchUploadClaim,
} from "@/lib/mutations/research-documents";
import {
  extractResearchMetadata,
  extractResearchRawText,
  ResearchPdfTooLargeError,
  ResearchPdfExtractionError,
  RESEARCH_DOC_PDF_MAX_BYTES,
} from "@/lib/research-documents/extract";

const RAW_TEXT_PLACEHOLDER =
  "[Full text is still being extracted — check back in a few minutes.]";

// Must cover every ResearchDocumentType member — a missing entry makes
// DOC_TYPES.includes() false and silently DROPS the filter (all docs returned).
const DOC_TYPES: ResearchDocumentType[] = [
  "analyst_report",
  "research_note",
  "market_analysis",
  "industry_primer",
  "investor_letter",
  "earnings_presentation",
  "article",
  "book_summary_or_essay",
  "macro_note",
  "other",
];

/**
 * symbol -> security id for every mentioned symbol that is a known security,
 * so the Documents cards can link a chip to the security hub (the Feeds cards
 * get the same map from /api/research/articles). A symbol with no security
 * row is absent and renders as plain text.
 */
function symbolSecurityMap(
  database: Database.Database,
  documents: Array<{ mentioned_symbols: string | null }>,
): Record<string, number> {
  const symbols = new Set<string>();
  for (const doc of documents) {
    if (!doc.mentioned_symbols) continue;
    try {
      const parsed: unknown = JSON.parse(doc.mentioned_symbols);
      if (!Array.isArray(parsed)) continue;
      for (const s of parsed) {
        if (typeof s === "string" && s.trim()) symbols.add(s.trim().toUpperCase());
      }
    } catch {
      // A malformed symbols cell links nothing; the card still renders.
    }
  }
  const map: Record<string, number> = {};
  const all = [...symbols];
  // Chunked: SQLite caps bound parameters per statement.
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const rows = database
      .prepare(
        `SELECT UPPER(symbol) AS symbol, MIN(id) AS id
           FROM securities
          WHERE UPPER(symbol) IN (${chunk.map(() => "?").join(",")})
          GROUP BY UPPER(symbol)`,
      )
      .all(...chunk) as Array<{ symbol: string; id: number }>;
    for (const r of rows) map[r.symbol] = r.id;
  }
  return map;
}

/** ET calendar date of a stored UTC `datetime('now')` stamp. */
function uploadedDateET(utc: string): string | null {
  const parsed = new Date(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** The sentence shown when an upload is refused as a repeat. */
function duplicateUploadMessage(
  claim: Exclude<ResearchUploadClaim, { ok: true }>,
): string {
  if (claim.reason === "still_processing") {
    return "This file is already being processed. Give it a few minutes, then look for it in Documents.";
  }
  const { existing } = claim;
  const date = uploadedDateET(existing.uploaded_at);
  const named = `"${existing.title}"${date ? ` (uploaded ${date})` : ""}`;
  if (claim.match === "name_and_size") {
    return `A file with this name and size is already in Documents as ${named}. Nothing was uploaded. If this is a different file, rename it and upload again. To extract the same file again, delete that document first.`;
  }
  if (existing.processing_state === "failed") {
    return `This file is already in Documents as ${named}, but its full-text extraction failed. Delete that document, then upload the file again to retry.`;
  }
  return `This file is already in Documents as ${named}. Nothing was uploaded. To extract it again, delete that document first.`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const typeParam = searchParams.get("document_type");
  const symbolParam = searchParams.get("symbol");
  const limitParam = searchParams.get("limit");

  const documentType = DOC_TYPES.includes(typeParam as ResearchDocumentType)
    ? (typeParam as ResearchDocumentType)
    : undefined;

  const limit = limitParam ? Math.max(1, Math.min(parseInt(limitParam, 10) || 50, 200)) : 50;

  const documents = listResearchDocuments(db, {
    document_type: documentType,
    symbol: symbolParam ?? undefined,
    limit,
  });
  const total = getResearchDocumentCount(db);

  return Response.json({
    documents,
    total,
    symbolMap: symbolSecurityMap(db, documents),
  });
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ error: "No file uploaded" }, { status: 400 });
  }
  const uploaded = file as File;

  if (!uploaded.type.includes("pdf") && !uploaded.name.toLowerCase().endsWith(".pdf")) {
    return Response.json(
      { error: "Only PDF files are supported." },
      { status: 400 },
    );
  }

  if (uploaded.size > RESEARCH_DOC_PDF_MAX_BYTES) {
    return Response.json(
      {
        error: `File is ${(uploaded.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${(RESEARCH_DOC_PDF_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB.`,
      },
      { status: 413 },
    );
  }

  const arrayBuffer = await uploaded.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // Owner ruling 2026-08-31 (option 1): an exact re-upload is refused, and it
  // is refused HERE, before either AI call is started. Two extractions of one
  // file disagreed with each other and the second one was paid for.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const claim = claimResearchDocumentUpload(db, {
    sha256,
    filename: uploaded.name,
    file_size_bytes: uploaded.size,
  });
  if (!claim.ok) {
    return Response.json(
      {
        error: duplicateUploadMessage(claim),
        code: claim.reason === "duplicate" ? "duplicate_document" : "upload_in_progress",
        ...(claim.reason === "duplicate" ? { existing_id: claim.existing.id } : {}),
      },
      { status: 409 },
    );
  }

  // Fire both calls in parallel; the raw_text promise keeps running while we
  // await metadata, insert the row, and respond to the client.
  const metadataPromise = extractResearchMetadata(bytes);
  const rawTextPromise = extractResearchRawText(bytes);

  // We don't want an unhandled rejection if raw_text fails before we attach
  // a .catch() below. Attach a no-op catch now; the real handler runs later.
  rawTextPromise.catch(() => {
    /* intentional: handled in the deferred continuation below */
  });

  let metadata;
  try {
    metadata = await metadataPromise;
  } catch (err) {
    // No document was created, so the file must stay uploadable.
    releaseResearchDocumentUploadClaim(db, sha256);
    if (err instanceof ResearchPdfTooLargeError) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    if (err instanceof ResearchPdfExtractionError) {
      // 422 = the service answered but the file gave it nothing to work with;
      // 502 = the service itself failed. A snippet is sent only when there is
      // one (an empty one used to render a labelled empty block).
      return Response.json(
        {
          error: err.message,
          ...(err.rawSnippet.trim() ? { snippet: err.rawSnippet } : {}),
        },
        { status: err.kind === "unusable_output" ? 422 : 502 },
      );
    }
    // Anything else is unclassified: its message can carry provider internals
    // (a raw JSON body, a request id), so it is logged and never sent.
    console.error("[research-docs] metadata extraction failed:", err);
    return Response.json(
      {
        error:
          "The document could not be processed: the AI service did not return a usable answer. Nothing was saved. Try again in a minute.",
      },
      { status: 500 },
    );
  }

  let id: number;
  try {
    id = createResearchDocument(db, {
      title: metadata.title,
      author: metadata.author,
      source: metadata.source,
      filename: uploaded.name,
      file_size_bytes: uploaded.size,
      publication_date: metadata.publication_date,
      document_type: metadata.document_type,
      raw_text: RAW_TEXT_PLACEHOLDER,
      summary: metadata.summary,
      key_points: metadata.key_points,
      mentioned_symbols: metadata.mentioned_symbols,
      tags: metadata.tags,
      sentiment: metadata.sentiment,
      target_prices: metadata.target_prices,
      ai_model: metadata.ai_model,
      char_count: null,
      processing_state: "pending_body",
      // Turns the claim above into hash -> this document.
      content_sha256: sha256,
    });
  } catch (err) {
    releaseResearchDocumentUploadClaim(db, sha256);
    console.error("[research-docs] could not save the document:", err);
    return Response.json(
      { error: "The document was read but could not be saved. Nothing was stored. Try again." },
      { status: 500 },
    );
  }

  // Fire-and-forget: when raw_text resolves (potentially minutes later), swap
  // the placeholder for the real body and flip processing_state to 'ready'.
  // On error, mark the row 'failed' so the UI can surface it.
  rawTextPromise
    .then((rawText) => {
      updateResearchDocumentRawText(db, id, rawText);
    })
    .catch((err) => {
      console.error(`[research-docs] raw_text extraction failed for id=${id}:`, err);
      try {
        markResearchDocumentProcessingFailed(db, id);
      } catch (markErr) {
        console.error(
          `[research-docs] could not mark id=${id} as failed:`,
          markErr,
        );
      }
    });

  return Response.json({
    id,
    title: metadata.title,
    source: metadata.source,
    summary: metadata.summary,
    document_type: metadata.document_type,
    publication_date: metadata.publication_date,
    mentioned_symbols: metadata.mentioned_symbols,
    tags: metadata.tags,
    key_points: metadata.key_points,
    processing_state: "pending_body" as const,
  });
}
