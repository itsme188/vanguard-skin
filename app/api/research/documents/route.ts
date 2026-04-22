import { NextRequest } from "next/server";
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

const DOC_TYPES: ResearchDocumentType[] = [
  "analyst_report",
  "research_note",
  "market_analysis",
  "industry_primer",
  "other",
];

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

  return Response.json({ documents, total });
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
    if (err instanceof ResearchPdfTooLargeError) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    if (err instanceof ResearchPdfExtractionError) {
      return Response.json(
        { error: err.message, snippet: err.rawSnippet },
        { status: 502 },
      );
    }
    const msg = err instanceof Error ? err.message : "Extraction failed";
    return Response.json({ error: msg }, { status: 500 });
  }

  const id = createResearchDocument(db, {
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
  });

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
