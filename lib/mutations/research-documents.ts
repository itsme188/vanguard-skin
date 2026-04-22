import type Database from "better-sqlite3";
import type {
  ResearchDocumentType,
  ResearchDocumentSentiment,
  ResearchDocumentProcessingState,
} from "@/lib/queries/research-documents";
import { normalizeTags } from "@/lib/research-documents/extract";

export interface CreateResearchDocumentInput {
  title: string;
  author: string | null;
  source: string | null;
  filename: string;
  file_size_bytes: number | null;
  publication_date: string | null;
  document_type: ResearchDocumentType | null;
  raw_text: string;
  summary: string | null;
  key_points: string[] | null;
  mentioned_symbols: string[] | null;
  tags: string[] | null;
  sentiment: ResearchDocumentSentiment | null;
  target_prices: Array<{ symbol: string; price: number; horizon?: string }> | null;
  ai_model: string | null;
  char_count: number | null;
  processing_state?: ResearchDocumentProcessingState;
}

export function createResearchDocument(
  db: Database.Database,
  input: CreateResearchDocumentInput,
): number {
  const normalizedSymbols = input.mentioned_symbols
    ? input.mentioned_symbols.map((s) => s.toUpperCase())
    : null;
  const normalizedTags = input.tags ? normalizeTags(input.tags) : null;

  const result = db
    .prepare(
      `INSERT INTO research_documents (
        title, author, source, filename, file_size_bytes, publication_date,
        document_type, raw_text, summary, key_points, mentioned_symbols, tags,
        sentiment, target_prices, ai_model, char_count, processing_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.author,
      input.source,
      input.filename,
      input.file_size_bytes,
      input.publication_date,
      input.document_type,
      input.raw_text,
      input.summary,
      input.key_points ? JSON.stringify(input.key_points) : null,
      normalizedSymbols ? JSON.stringify(normalizedSymbols) : null,
      normalizedTags && normalizedTags.length > 0
        ? JSON.stringify(normalizedTags)
        : null,
      input.sentiment,
      input.target_prices ? JSON.stringify(input.target_prices) : null,
      input.ai_model,
      input.char_count,
      input.processing_state ?? "ready",
    );
  return result.lastInsertRowid as number;
}

export function updateResearchDocumentTags(
  db: Database.Database,
  id: number,
  tags: string[],
): boolean {
  const cleaned = normalizeTags(tags);
  const result = db
    .prepare(`UPDATE research_documents SET tags = ? WHERE id = ?`)
    .run(cleaned.length > 0 ? JSON.stringify(cleaned) : null, id);
  return result.changes > 0;
}

/**
 * Swap the placeholder raw_text for the real body once the deferred
 * extraction call resolves, and flip processing_state to 'ready'. The
 * FTS5 update trigger picks up the new body automatically.
 */
export function updateResearchDocumentRawText(
  db: Database.Database,
  id: number,
  rawText: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE research_documents
         SET raw_text = ?,
             char_count = ?,
             processing_state = 'ready'
       WHERE id = ?`,
    )
    .run(rawText, rawText.length, id);
  return result.changes > 0;
}

/**
 * Mark a doc as processing_state='failed' when the deferred raw_text
 * extraction errors out. The row keeps whatever metadata already
 * landed so the user sees the document in the list and can either
 * retry or delete it.
 */
export function markResearchDocumentProcessingFailed(
  db: Database.Database,
  id: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE research_documents SET processing_state = 'failed' WHERE id = ?`,
    )
    .run(id);
  return result.changes > 0;
}

export function deleteResearchDocument(
  db: Database.Database,
  id: number,
): boolean {
  const result = db
    .prepare(`DELETE FROM research_documents WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}
