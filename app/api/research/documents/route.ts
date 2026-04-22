import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  listResearchDocuments,
  getResearchDocumentCount,
  type ResearchDocumentType,
} from "@/lib/queries/research-documents";
import { createResearchDocument } from "@/lib/mutations/research-documents";
import {
  extractResearchPdf,
  ResearchPdfTooLargeError,
  ResearchPdfExtractionError,
  RESEARCH_DOC_PDF_MAX_BYTES,
} from "@/lib/research-documents/extract";

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

  let extracted;
  try {
    extracted = await extractResearchPdf(bytes);
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
    title: extracted.title,
    author: extracted.author,
    source: extracted.source,
    filename: uploaded.name,
    file_size_bytes: uploaded.size,
    publication_date: extracted.publication_date,
    document_type: extracted.document_type,
    raw_text: extracted.raw_text,
    summary: extracted.summary,
    key_points: extracted.key_points,
    mentioned_symbols: extracted.mentioned_symbols,
    sentiment: extracted.sentiment,
    target_prices: extracted.target_prices,
    ai_model: extracted.ai_model,
    char_count: extracted.raw_text.length,
  });

  return Response.json({
    id,
    title: extracted.title,
    source: extracted.source,
    summary: extracted.summary,
    document_type: extracted.document_type,
    publication_date: extracted.publication_date,
    mentioned_symbols: extracted.mentioned_symbols,
    key_points: extracted.key_points,
    char_count: extracted.raw_text.length,
  });
}
