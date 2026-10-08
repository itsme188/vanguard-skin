import type Database from "better-sqlite3";
import type { EarningsBogeySource } from "@/lib/queries/earnings-bogeys";
import { recompileContracts, type RecompileReport } from "@/lib/print-watch/recompile";
import { getPrintByEventId } from "@/lib/print-watch/store";

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
  /** Desk-defined extra metric lines (spec §4.7). Validated by the ROUTE
   *  through parseExtraMetrics before it reaches here; stored verbatim. */
  extra_metrics_json?: string | null;
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
export const CONTENT_COLUMNS = [
  "eps_consensus",
  "eps_whisper",
  "revenue_consensus_usd",
  "revenue_whisper_usd",
  "expected_move_pct",
  "eps_consensus_vendor",
  "segment_breakdown_json",
  "guidance_notes",
  "notes",
  "extra_metrics_json",
] as const;

const INSERT_SQL = `INSERT INTO earnings_bogeys (
       event_id, source, source_label, source_url, raw_pdf_r2_key,
       research_document_id, research_article_id, eps_consensus, eps_whisper,
       revenue_consensus_usd, revenue_whisper_usd, expected_move_pct,
       eps_consensus_vendor,
       segment_breakdown_json, guidance_notes, notes, extra_metrics_json, uploaded_at,
       ai_extraction_model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`;

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
       extra_metrics_json = excluded.extra_metrics_json,
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

/** The content columns that hold text (prose or JSON). The rest are numbers. */
const TEXT_CONTENT_COLUMNS: ReadonlySet<string> = new Set([
  "segment_breakdown_json",
  "guidance_notes",
  "notes",
  "extra_metrics_json",
]);

/** A JSON container with nothing in it carries no figure and no prose. */
const EMPTY_TEXT_VALUES = ["", "[]", "{}"];

/**
 * THE one answer to "does this bogey row hold anything?" (owner ruling
 * 2026-08-12, finding all-empty-newsletter-bogey-counts-as-coverage). A row
 * with every content column empty is not coverage: it must not be stored, and
 * a stored one must not count on any surface. A number counts when it is a
 * finite number (0 is a real consensus); text counts when it is not blank and
 * not an empty JSON container.
 *
 * Structural, so a stored row, a write input and a wire row all satisfy it.
 */
export function bogeyHasContent(
  row: Partial<Record<(typeof CONTENT_COLUMNS)[number], unknown>>,
): boolean {
  return CONTENT_COLUMNS.some((c) => {
    const v = row[c];
    if (v == null) return false;
    if (typeof v === "string") return !EMPTY_TEXT_VALUES.includes(v.trim());
    return typeof v !== "number" || Number.isFinite(v);
  });
}

/**
 * The same rule as a SQL predicate, for readers that count or select bogey
 * rows (`alias` is the table alias, "" for none). Kept beside
 * `bogeyHasContent` so the two cannot drift; tests/mutations/
 * earnings-bogeys-empty-rows.test.ts runs both over the same rows.
 */
export function bogeyHasContentSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  const emptyList = EMPTY_TEXT_VALUES.map((v) => `'${v}'`).join(", ");
  return `(${CONTENT_COLUMNS.map((c) =>
    TEXT_CONTENT_COLUMNS.has(c)
      ? `TRIM(COALESCE(${p}${c}, '')) NOT IN (${emptyList})`
      : `${p}${c} IS NOT NULL`,
  ).join(" OR ")})`;
}

/**
 * A blank/whitespace-only string is "no content" — same as null. Without
 * this, a parser or caller that hands back `notes: ""` counts as content
 * (2026-08-28: `!= null` treats "" as present), so the has-content check advances
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

/** Named so the route and the tests can talk about it. */
export interface UpsertBogeyResult {
  /** The stored row's id. 0 when nothing was stored and no row exists (an
   *  all-empty write with nothing to update): real ids start at 1. */
  id: number;
  created: boolean;
  skipped?: boolean;
  /** An all-empty full overwrite removed the row it would have blanked. */
  deleted?: boolean;
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
 *
 * An all-empty row is never stored (owner ruling 2026-08-12): every surface
 * that asks "does this event have bogeys?" would count it as coverage.
 *   - no row yet           -> nothing is inserted (`skipped`, id 0);
 *   - preserve mode, a row -> the row is left alone (`skipped`, as above);
 *   - overwrite mode, a row -> the row is left alone too (`skipped`). An
 *     empty write most often means "nothing was extracted this time" (a PDF
 *     re-upload under the same label), and that must never erase figures
 *     already on file. A row is removed only through deleteBogey.
 */
export function upsertBogey(
  db: Database.Database,
  input: UpsertBogeyInput,
): UpsertBogeyResult {
  // Normalize the textual content columns (blank/whitespace-only -> null)
  // BEFORE the has-content check and the SQL bind, for both modes — a blank
  // string is "no content" and must never reach COALESCE or the row.
  const normalized: UpsertBogeyInput = {
    ...input,
    segment_breakdown_json: normalizeTextContent(input.segment_breakdown_json),
    guidance_notes: normalizeTextContent(input.guidance_notes),
    notes: normalizeTextContent(input.notes),
    extra_metrics_json: normalizeTextContent(input.extra_metrics_json),
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

  if (!bogeyHasContent(normalized)) {
    if (!before) return { id: 0, created: false, skipped: true };
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
    normalized.extra_metrics_json ?? null,
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

/**
 * A print that is `expired` or `disarmed` has finished measuring: its sheet is
 * the RECORD of what was measured and is never re-derived. No print at all is
 * the ordinary case (most events never arm).
 */
function recompileLivePrint(db: Database.Database, eventId: number): RecompileReport | null {
  const print = getPrintByEventId(db, eventId);
  if (!print || print.state === "expired" || print.state === "disarmed") return null;
  return recompileContracts(db, print.id);
}

/**
 * Save a bogey and re-derive the event's live sheet in ONE transaction
 * (Codex round 1, finding 6). Committing the bogey and then recompiling
 * separately leaves a window — and, if the recompile throws, a permanent
 * state — in which the stored sheet disagrees with the stored bogeys: lines
 * for metrics nobody defines any more, or no line for one the desk just added
 * and is about to be judged against at 16:05.
 *
 * `recompileContracts` opens its own `.immediate()`; nested, better-sqlite3
 * runs it as a SAVEPOINT (lib/methods/transaction.js::wrapTransaction switches
 * to SAVEPOINT/RELEASE/ROLLBACK TO whenever db.inTransaction), so a throw
 * inside it unwinds this whole transaction — bogey write included.
 */
export function saveBogeyWithRecompile(
  db: Database.Database,
  input: UpsertBogeyInput,
): { result: UpsertBogeyResult; recompile: RecompileReport | null } {
  const run = db.transaction(() => {
    const result = upsertBogey(db, input);
    return { result, recompile: recompileLivePrint(db, input.event_id) };
  });
  return run.immediate();
}

/** The same guarantee for a removal — and the row's `event_id` is read BEFORE
 *  the DELETE, inside the transaction, so nothing can race between them. */
export function deleteBogeyWithRecompile(
  db: Database.Database,
  id: number,
): { deleted: boolean; recompile: RecompileReport | null } {
  const run = db.transaction(() => {
    const row = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE id = ?`).get(id) as
      | { event_id: number }
      | undefined;
    const deleted = deleteBogey(db, id);
    if (!deleted || !row) return { deleted, recompile: null };
    return { deleted: true, recompile: recompileLivePrint(db, row.event_id) };
  });
  return run.immediate();
}
