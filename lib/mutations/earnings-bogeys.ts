import type Database from "better-sqlite3";
import type { EarningsBogeySource } from "@/lib/queries/earnings-bogeys";

export interface UpsertBogeyInput {
  event_id: number;
  source: EarningsBogeySource;
  source_label?: string | null;
  source_url?: string | null;
  raw_pdf_r2_key?: string | null;
  research_document_id?: number | null;
  research_article_id?: number | null;
  eps_consensus?: number | null;
  eps_whisper?: number | null;
  revenue_consensus_usd?: number | null;
  revenue_whisper_usd?: number | null;
  segment_breakdown_json?: string | null;
  guidance_notes?: string | null;
  notes?: string | null;
  ai_extraction_model?: string | null;
}

/**
 * Idempotent insert keyed on (event_id, source, source_label). Re-upload of
 * the same source PDF for the same event refreshes the numbers in place
 * rather than creating a duplicate row. uploaded_at bumps on conflict so
 * "most recent first" ordering still reflects the latest upload.
 */
export function upsertBogey(
  db: Database.Database,
  input: UpsertBogeyInput,
): { id: number; created: boolean } {
  const before = db
    .prepare(
      `SELECT id FROM earnings_bogeys
        WHERE event_id = ? AND source = ? AND COALESCE(source_label, '') = COALESCE(?, '')`,
    )
    .get(
      input.event_id,
      input.source,
      input.source_label ?? null,
    ) as { id: number } | undefined;

  const stmt = db.prepare(
    `INSERT INTO earnings_bogeys (
       event_id, source, source_label, source_url, raw_pdf_r2_key,
       research_document_id, research_article_id, eps_consensus, eps_whisper,
       revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
       guidance_notes, notes, uploaded_at, ai_extraction_model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(event_id, source, source_label) DO UPDATE SET
       source_url = excluded.source_url,
       raw_pdf_r2_key = excluded.raw_pdf_r2_key,
       research_document_id = excluded.research_document_id,
       research_article_id = excluded.research_article_id,
       eps_consensus = excluded.eps_consensus,
       eps_whisper = excluded.eps_whisper,
       revenue_consensus_usd = excluded.revenue_consensus_usd,
       revenue_whisper_usd = excluded.revenue_whisper_usd,
       segment_breakdown_json = excluded.segment_breakdown_json,
       guidance_notes = excluded.guidance_notes,
       notes = excluded.notes,
       uploaded_at = datetime('now'),
       ai_extraction_model = excluded.ai_extraction_model`,
  );

  const result = stmt.run(
    input.event_id,
    input.source,
    input.source_label ?? null,
    input.source_url ?? null,
    input.raw_pdf_r2_key ?? null,
    input.research_document_id ?? null,
    input.research_article_id ?? null,
    input.eps_consensus ?? null,
    input.eps_whisper ?? null,
    input.revenue_consensus_usd ?? null,
    input.revenue_whisper_usd ?? null,
    input.segment_breakdown_json ?? null,
    input.guidance_notes ?? null,
    input.notes ?? null,
    input.ai_extraction_model ?? null,
  );

  if (before) {
    return { id: before.id, created: false };
  }
  return { id: result.lastInsertRowid as number, created: true };
}

export function deleteBogey(db: Database.Database, id: number): boolean {
  const r = db
    .prepare("DELETE FROM earnings_bogeys WHERE id = ?")
    .run(id);
  return r.changes > 0;
}
