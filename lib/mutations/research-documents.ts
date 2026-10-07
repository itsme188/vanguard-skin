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
  /**
   * SHA-256 (hex) of the uploaded file's bytes. When given, the insert also
   * records hash -> document id (same transaction) so a later upload of the
   * same bytes is refused by `claimResearchDocumentUpload`.
   */
  content_sha256?: string | null;
}

// ─── Upload dedupe (owner ruling 2026-08-31, option 1) ───────────────
//
// An exact re-upload is refused BEFORE any AI call: the same PDF extracted
// twice produced two documents whose symbols and tags disagreed, and paid for
// the second extraction. `research_documents` has no hash column and the file
// bytes are not kept, so the hash lives in the `settings` key-value table:
//   key   = research_doc_sha256:<sha256 hex of the file bytes>
//   value = the document id, or "pending" while the first upload's AI call
//           is still running (so a double-drop cannot start a second call).
// A document uploaded before hashing existed has no such row; for those the
// fallback is an exact filename + byte-size match.

/** `settings` key prefix of a recorded upload hash (see the block above). */
export const UPLOAD_HASH_KEY_PREFIX = "research_doc_sha256:";
const UPLOAD_CLAIM_PENDING = "pending";
/** A "pending" claim older than this was orphaned (server restart mid-upload). */
const UPLOAD_CLAIM_STALE_MINUTES = 15;

function uploadHashKey(sha256: string): string {
  return `${UPLOAD_HASH_KEY_PREFIX}${sha256.toLowerCase()}`;
}

export interface ExistingResearchDocumentRef {
  id: number;
  title: string;
  /** UTC, as stored (`datetime('now')`). */
  uploaded_at: string;
  processing_state: ResearchDocumentProcessingState;
}

export type ResearchUploadClaim =
  | { ok: true }
  | {
      ok: false;
      reason: "duplicate";
      /** `content` = same bytes; `name_and_size` = the legacy fallback. */
      match: "content" | "name_and_size";
      existing: ExistingResearchDocumentRef;
    }
  | { ok: false; reason: "still_processing" };

/**
 * Decide whether an upload may proceed, and if so claim its content hash.
 * Call BEFORE the AI extraction. On `ok: true` the caller owns the claim and
 * must either create the document with `content_sha256` (which turns the claim
 * into hash -> id) or call `releaseResearchDocumentUploadClaim` on failure.
 */
export function claimResearchDocumentUpload(
  db: Database.Database,
  input: { sha256: string; filename: string; file_size_bytes: number },
): ResearchUploadClaim {
  const key = uploadHashKey(input.sha256);
  const run = db.transaction((): ResearchUploadClaim => {
    const claim = db
      .prepare(
        `SELECT value,
                datetime(updated_at) > datetime('now', ?) AS fresh
           FROM settings WHERE key = ?`,
      )
      .get(`-${UPLOAD_CLAIM_STALE_MINUTES} minutes`, key) as
      | { value: string; fresh: number | null }
      | undefined;

    if (claim) {
      if (claim.value === UPLOAD_CLAIM_PENDING) {
        if (claim.fresh === 1) return { ok: false, reason: "still_processing" };
        // Orphaned claim: fall through and take it over.
      } else {
        const existing = findDocumentRef(db, Number(claim.value));
        if (existing) {
          return { ok: false, reason: "duplicate", match: "content", existing };
        }
        // The document was deleted: the hash is free again.
      }
    }

    // Fallback for documents stored before hashing: same name and same size,
    // and no recorded hash (a recorded hash that differs from this one proves
    // the bytes differ, so a revised file with the same name still passes).
    const legacy = db
      .prepare(
        `SELECT d.id, d.title, d.uploaded_at,
                COALESCE(d.processing_state, 'ready') AS processing_state
           FROM research_documents d
          WHERE d.filename = ? AND d.file_size_bytes = ?
            AND NOT EXISTS (
              SELECT 1 FROM settings s
               WHERE substr(s.key, 1, ?) = ?
                 AND s.value = CAST(d.id AS TEXT)
            )
          ORDER BY d.id
          LIMIT 1`,
      )
      .get(
        input.filename,
        input.file_size_bytes,
        UPLOAD_HASH_KEY_PREFIX.length,
        UPLOAD_HASH_KEY_PREFIX,
      ) as ExistingResearchDocumentRef | undefined;
    if (legacy) {
      return { ok: false, reason: "duplicate", match: "name_and_size", existing: legacy };
    }

    writeUploadHash(db, key, UPLOAD_CLAIM_PENDING);
    return { ok: true };
  });
  return run.immediate();
}

/** Drop a claim whose upload failed before a document was created. */
export function releaseResearchDocumentUploadClaim(
  db: Database.Database,
  sha256: string,
): void {
  db.prepare(`DELETE FROM settings WHERE key = ? AND value = ?`).run(
    uploadHashKey(sha256),
    UPLOAD_CLAIM_PENDING,
  );
}

function findDocumentRef(
  db: Database.Database,
  id: number,
): ExistingResearchDocumentRef | null {
  if (!Number.isInteger(id)) return null;
  const row = db
    .prepare(
      `SELECT id, title, uploaded_at,
              COALESCE(processing_state, 'ready') AS processing_state
         FROM research_documents WHERE id = ?`,
    )
    .get(id) as ExistingResearchDocumentRef | undefined;
  return row ?? null;
}

function writeUploadHash(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function createResearchDocument(
  db: Database.Database,
  input: CreateResearchDocumentInput,
): number {
  const sha256 = input.content_sha256;
  if (!sha256) return insertResearchDocument(db, input);
  // Row + hash record land together: a document without its hash would let
  // the same bytes be uploaded again.
  return db.transaction(() => {
    const id = insertResearchDocument(db, input);
    writeUploadHash(db, uploadHashKey(sha256), String(id));
    return id;
  })();
}

function insertResearchDocument(
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
  // The recorded content hash goes with the document, so the same file can
  // be uploaded again after a delete (the documented way to retry).
  return db.transaction(() => {
    const result = db
      .prepare(`DELETE FROM research_documents WHERE id = ?`)
      .run(id);
    if (result.changes > 0) {
      db.prepare(
        `DELETE FROM settings WHERE substr(key, 1, ?) = ? AND value = ?`,
      ).run(UPLOAD_HASH_KEY_PREFIX.length, UPLOAD_HASH_KEY_PREFIX, String(id));
    }
    return result.changes > 0;
  })();
}
