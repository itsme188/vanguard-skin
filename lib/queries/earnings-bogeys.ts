import type Database from "better-sqlite3";

export type EarningsBogeySource = "pdf_upload" | "manual" | "newsletter" | "finnhub";

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
  /** Absolute percent (±6% → 6) — sheet-stated expected earnings move. */
  expected_move_pct: number | null;
  /** Vendor EPS consensus (Finnhub), basis unspecified. NEVER the adjusted-EPS bogey (D1). */
  eps_consensus_vendor: number | null;
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
              revenue_consensus_usd, revenue_whisper_usd, expected_move_pct,
              eps_consensus_vendor,
              segment_breakdown_json, guidance_notes, notes, uploaded_at,
              ai_extraction_model
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
                revenue_consensus_usd, revenue_whisper_usd, expected_move_pct,
                eps_consensus_vendor,
                segment_breakdown_json, guidance_notes, notes, uploaded_at,
                ai_extraction_model
           FROM earnings_bogeys
          WHERE event_id = ?
          ORDER BY uploaded_at DESC
          LIMIT 1`,
      )
      .get(eventId) as EarningsBogey | undefined) ?? null
  );
}

/**
 * Batch read of expected-move candidates for the resolver (feedback #5):
 * only rows that actually carry an expected_move_pct, shaped for
 * lib/earnings/expected-move.ts::resolveExpectedMove. Missing events simply
 * have no entry.
 */
export function getExpectedMoveBogeysForEvents(
  db: Database.Database,
  eventIds: number[],
): Map<number, Array<{ expectedMovePct: number | null; sourceLabel: string | null; uploadedAt: string | null }>> {
  const out = new Map<
    number,
    Array<{ expectedMovePct: number | null; sourceLabel: string | null; uploadedAt: string | null }>
  >();
  if (eventIds.length === 0) return out;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_id, expected_move_pct, source_label, uploaded_at
         FROM earnings_bogeys
        WHERE event_id IN (${placeholders}) AND expected_move_pct IS NOT NULL`,
    )
    .all(...eventIds) as Array<{
    event_id: number;
    expected_move_pct: number;
    source_label: string | null;
    uploaded_at: string | null;
  }>;
  for (const r of rows) {
    const list = out.get(r.event_id) ?? [];
    list.push({
      expectedMovePct: r.expected_move_pct,
      sourceLabel: r.source_label,
      uploadedAt: r.uploaded_at,
    });
    out.set(r.event_id, list);
  }
  return out;
}
