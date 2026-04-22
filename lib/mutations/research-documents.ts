import type Database from "better-sqlite3";
import type {
  ResearchDocumentType,
  ResearchDocumentSentiment,
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
        sentiment, target_prices, ai_model, char_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function deleteResearchDocument(
  db: Database.Database,
  id: number,
): boolean {
  const result = db
    .prepare(`DELETE FROM research_documents WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}
