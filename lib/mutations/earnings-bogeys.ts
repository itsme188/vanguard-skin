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
  /** Absolute percent (±6% → 6) — the sheet's stated expected earnings move. */
  expected_move_pct?: number | null;
  /** Vendor EPS consensus (Finnhub). Stored apart from eps_consensus by design (D1). */
  eps_consensus_vendor?: number | null;
  segment_breakdown_json?: string | null;
  guidance_notes?: string | null;
  notes?: string | null;
  ai_extraction_model?: string | null;
  /**
   * Null-preserving conflict semantics for RE-SCAN callers (newsletter
   * extraction). Default false = full overwrite, which manual + PDF-upload
   * callers rely on to CLEAR a field the user removed.
   *
   * With true, an incoming NULL never overwrites a stored content value
   * (COALESCE(excluded.col, earnings_bogeys.col)). Live 2026-08-26: a later
   * issue of the same newsletter mentioned NVDA/CRWD without numbers and the
   * unconditional `excluded.*` copy erased the earlier issue's extracted
   * consensus, because newsletter rows key on (event, 'newsletter', source).
   */
  preserveExisting?: boolean;
}

/**
 * Content columns — the extracted numbers + prose. In preserve mode these
 * are COALESCEd so a null incoming value keeps what is already stored.
 * Everything else (source_url, raw_pdf_r2_key, research_document_id,
 * research_article_id, uploaded_at, ai_extraction_model) is PROVENANCE and
 * always takes the incoming value: it describes the write, not the numbers.
 */
const CONTENT_COLUMNS = [
  "eps_consensus",
  "eps_whisper",
  "revenue_consensus_usd",
  "revenue_whisper_usd",
  "expected_move_pct",
  "eps_consensus_vendor",
  "segment_breakdown_json",
  "guidance_notes",
  "notes",
] as const;

const INSERT_SQL = `INSERT INTO earnings_bogeys (
       event_id, source, source_label, source_url, raw_pdf_r2_key,
       research_document_id, research_article_id, eps_consensus, eps_whisper,
       revenue_consensus_usd, revenue_whisper_usd, expected_move_pct,
       eps_consensus_vendor,
       segment_breakdown_json, guidance_notes, notes, uploaded_at,
       ai_extraction_model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`;

const PROVENANCE_UPDATE_SQL = `       source_url = excluded.source_url,
       raw_pdf_r2_key = excluded.raw_pdf_r2_key,
       research_document_id = excluded.research_document_id,
       research_article_id = excluded.research_article_id`;

/** Full overwrite — historical behaviour, byte-identical to pre-2026-08-28. */
const OVERWRITE_SQL = `${INSERT_SQL}
     ON CONFLICT(event_id, source, source_label) DO UPDATE SET
${PROVENANCE_UPDATE_SQL},
       eps_consensus = excluded.eps_consensus,
       eps_whisper = excluded.eps_whisper,
       revenue_consensus_usd = excluded.revenue_consensus_usd,
       revenue_whisper_usd = excluded.revenue_whisper_usd,
       expected_move_pct = excluded.expected_move_pct,
       eps_consensus_vendor = excluded.eps_consensus_vendor,
       segment_breakdown_json = excluded.segment_breakdown_json,
       guidance_notes = excluded.guidance_notes,
       notes = excluded.notes,
       uploaded_at = datetime('now'),
       ai_extraction_model = excluded.ai_extraction_model`;

/** Null-preserving — a re-scan that found nothing keeps the stored numbers. */
const PRESERVE_SQL = `${INSERT_SQL}
     ON CONFLICT(event_id, source, source_label) DO UPDATE SET
${PROVENANCE_UPDATE_SQL},
${CONTENT_COLUMNS.map(
  (c) => `       ${c} = COALESCE(excluded.${c}, earnings_bogeys.${c})`,
).join(",\n")},
       uploaded_at = datetime('now'),
       ai_extraction_model = excluded.ai_extraction_model`;

function hasAnyContent(input: UpsertBogeyInput): boolean {
  return CONTENT_COLUMNS.some((c) => input[c] != null);
}

/**
 * A blank/whitespace-only string is "no content" — same as null. Without
 * this, a parser or caller that hands back `notes: ""` counts as content
 * (2026-08-28: `!= null` treats "" as present), so `hasAnyContent` advances
 * provenance on a genuinely-empty re-scan, and — because OVERWRITE_SQL binds
 * the raw value and PRESERVE_SQL's COALESCE only skips actual NULLs — the
 * blank string gets written over a real stored value instead of preserving
 * it. Trim to null BEFORE both the has-content check and the SQL bind.
 */
function normalizeTextContent(value: string | null | undefined): string | null {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Idempotent insert keyed on (event_id, source, source_label). Re-upload of
 * the same source PDF for the same event refreshes the numbers in place
 * rather than creating a duplicate row. uploaded_at bumps on conflict so
 * "most recent first" ordering still reflects the latest upload.
 *
 * `preserveExisting: true` (newsletter re-scan only) makes an incoming NULL
 * content value a no-op instead of an erase, and — when the incoming input
 * carries NO content at all and a row already exists — skips the write
 * entirely. Bumping uploaded_at / research_article_id there would make the
 * preserved OLD numbers look freshly sourced to the newest-first readers in
 * lib/queries/earnings-bogeys.ts.
 */
export function upsertBogey(
  db: Database.Database,
  input: UpsertBogeyInput,
): { id: number; created: boolean; skipped?: boolean } {
  // Normalize the textual content columns (blank/whitespace-only -> null)
  // BEFORE the has-content check and the SQL bind, for both modes — a blank
  // string is "no content" and must never reach COALESCE or the row.
  const normalized: UpsertBogeyInput = {
    ...input,
    segment_breakdown_json: normalizeTextContent(input.segment_breakdown_json),
    guidance_notes: normalizeTextContent(input.guidance_notes),
    notes: normalizeTextContent(input.notes),
  };

  const before = db
    .prepare(
      `SELECT id FROM earnings_bogeys
        WHERE event_id = ? AND source = ? AND COALESCE(source_label, '') = COALESCE(?, '')`,
    )
    .get(
      normalized.event_id,
      normalized.source,
      normalized.source_label ?? null,
    ) as { id: number } | undefined;

  if (normalized.preserveExisting && before && !hasAnyContent(normalized)) {
    return { id: before.id, created: false, skipped: true };
  }

  const stmt = db.prepare(normalized.preserveExisting ? PRESERVE_SQL : OVERWRITE_SQL);

  const result = stmt.run(
    normalized.event_id,
    normalized.source,
    normalized.source_label ?? null,
    normalized.source_url ?? null,
    normalized.raw_pdf_r2_key ?? null,
    normalized.research_document_id ?? null,
    normalized.research_article_id ?? null,
    normalized.eps_consensus ?? null,
    normalized.eps_whisper ?? null,
    normalized.revenue_consensus_usd ?? null,
    normalized.revenue_whisper_usd ?? null,
    normalized.expected_move_pct ?? null,
    normalized.eps_consensus_vendor ?? null,
    normalized.segment_breakdown_json ?? null,
    normalized.guidance_notes ?? null,
    normalized.notes ?? null,
    normalized.ai_extraction_model ?? null,
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
