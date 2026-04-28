import type Database from "better-sqlite3";

export type EarningsBogeySource = "pdf_upload" | "manual" | "newsletter";

export interface EarningsBogey {
  id: number;
  event_id: number;
  source: EarningsBogeySource;
  source_label: string | null;
  source_url: string | null;
  raw_pdf_r2_key: string | null;
  research_document_id: number | null;
  research_article_id: number | null;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
  segment_breakdown_json: string | null;
  guidance_notes: string | null;
  notes: string | null;
  uploaded_at: string;
  ai_extraction_model: string | null;
}

/**
 * All bogeys for an event, newest first. Composer iterates this list to
 * build the "Bogeys (preferred — most recent first):" prompt section.
 */
export function getBogeysForEvent(
  db: Database.Database,
  eventId: number,
): EarningsBogey[] {
  return db
    .prepare(
      `SELECT id, event_id, source, source_label, source_url, raw_pdf_r2_key,
              research_document_id, research_article_id, eps_consensus, eps_whisper,
              revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
              guidance_notes, notes, uploaded_at, ai_extraction_model
         FROM earnings_bogeys
        WHERE event_id = ?
        ORDER BY uploaded_at DESC`,
    )
    .all(eventId) as EarningsBogey[];
}

/**
 * Earliest (most-recently-uploaded) "primary" bogey for an event. Used by
 * `renderHeadlineTable` when bogey consensus should override the Finnhub
 * fallback in the scoreboard.
 */
export function getPrimaryBogeyForEvent(
  db: Database.Database,
  eventId: number,
): EarningsBogey | null {
  return (
    (db
      .prepare(
        `SELECT id, event_id, source, source_label, source_url, raw_pdf_r2_key,
                research_document_id, research_article_id, eps_consensus, eps_whisper,
                revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
                guidance_notes, notes, uploaded_at, ai_extraction_model
           FROM earnings_bogeys
          WHERE event_id = ?
          ORDER BY uploaded_at DESC
          LIMIT 1`,
      )
      .get(eventId) as EarningsBogey | undefined) ?? null
  );
}
