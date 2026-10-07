/**
 * A20 (owner ruling 2026-08-31, option 1): an exact re-upload of a research
 * PDF is refused before any AI call. `research_documents` has no hash column,
 * so the content hash is recorded in the `settings` table; a document stored
 * before hashing falls back to an exact filename + size match.
 * Synthetic names and sizes only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  claimResearchDocumentUpload,
  releaseResearchDocumentUploadClaim,
  createResearchDocument,
  deleteResearchDocument,
  type CreateResearchDocumentInput,
} from "@/lib/mutations/research-documents";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let db: Database.Database;

function doc(overrides: Partial<CreateResearchDocumentInput> = {}): CreateResearchDocumentInput {
  return {
    title: "Synthetic Outlook",
    author: null,
    source: null,
    filename: "outlook.pdf",
    file_size_bytes: 1000,
    publication_date: null,
    document_type: "other",
    raw_text: "body",
    summary: null,
    key_points: null,
    mentioned_symbols: null,
    tags: null,
    sentiment: null,
    target_prices: null,
    ai_model: null,
    char_count: null,
    ...overrides,
  };
}

function hashRows(): Array<{ key: string; value: string }> {
  return db
    .prepare(`SELECT key, value FROM settings WHERE key LIKE 'research!_doc!_sha256:%' ESCAPE '!'`)
    .all() as Array<{ key: string; value: string }>;
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("claimResearchDocumentUpload", () => {
  it("lets a new file through and holds a pending claim on its hash", () => {
    const claim = claimResearchDocumentUpload(db, {
      sha256: HASH_A,
      filename: "outlook.pdf",
      file_size_bytes: 1000,
    });
    expect(claim).toEqual({ ok: true });
    expect(hashRows()).toEqual([{ key: `research_doc_sha256:${HASH_A}`, value: "pending" }]);
  });

  it("refuses the same bytes while the first upload is still running", () => {
    const input = { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 };
    expect(claimResearchDocumentUpload(db, input).ok).toBe(true);
    expect(claimResearchDocumentUpload(db, input)).toEqual({ ok: false, reason: "still_processing" });
  });

  it("refuses the same bytes once the document exists, naming it, even under another filename", () => {
    claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 });
    const id = createResearchDocument(db, doc({ content_sha256: HASH_A }));

    const again = claimResearchDocumentUpload(db, {
      sha256: HASH_A,
      filename: "renamed-copy.pdf",
      file_size_bytes: 1000,
    });
    expect(again).toMatchObject({
      ok: false,
      reason: "duplicate",
      match: "content",
      existing: { id, title: "Synthetic Outlook", processing_state: "ready" },
    });
    expect(db.prepare(`SELECT COUNT(*) c FROM research_documents`).get()).toEqual({ c: 1 });
  });

  it("accepts a revised file with the same name and size when the stored one has a different hash", () => {
    claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 });
    createResearchDocument(db, doc({ content_sha256: HASH_A }));

    expect(
      claimResearchDocumentUpload(db, { sha256: HASH_B, filename: "outlook.pdf", file_size_bytes: 1000 }),
    ).toEqual({ ok: true });
  });

  it("falls back to filename + size for a document stored before hashing", () => {
    const legacyId = createResearchDocument(db, doc()); // no content_sha256
    expect(hashRows()).toEqual([]);

    expect(
      claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 }),
    ).toMatchObject({ ok: false, reason: "duplicate", match: "name_and_size", existing: { id: legacyId } });
    // A refused upload leaves no claim behind.
    expect(hashRows()).toEqual([]);

    // Same name, different size: a different file.
    expect(
      claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1001 }),
    ).toEqual({ ok: true });
  });

  it("releases a claim when the upload fails, so the file can be tried again", () => {
    const input = { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 };
    claimResearchDocumentUpload(db, input);
    releaseResearchDocumentUploadClaim(db, HASH_A);
    expect(hashRows()).toEqual([]);
    expect(claimResearchDocumentUpload(db, input)).toEqual({ ok: true });
  });

  it("release never removes the record of a stored document", () => {
    claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 });
    const id = createResearchDocument(db, doc({ content_sha256: HASH_A }));
    releaseResearchDocumentUploadClaim(db, HASH_A);
    expect(hashRows()).toEqual([{ key: `research_doc_sha256:${HASH_A}`, value: String(id) }]);
  });

  it("takes over a pending claim that was orphaned (older than the stale window)", () => {
    const input = { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 };
    claimResearchDocumentUpload(db, input);
    db.prepare(`UPDATE settings SET updated_at = datetime('now', '-16 minutes') WHERE key = ?`).run(
      `research_doc_sha256:${HASH_A}`,
    );
    expect(claimResearchDocumentUpload(db, input)).toEqual({ ok: true });
    // The takeover refreshes the claim, so a third attempt waits again.
    expect(claimResearchDocumentUpload(db, input)).toEqual({ ok: false, reason: "still_processing" });
  });

  it("reports a failed extraction on the existing document so the caller can say how to retry", () => {
    claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 });
    createResearchDocument(db, doc({ content_sha256: HASH_A, processing_state: "failed" }));
    expect(
      claimResearchDocumentUpload(db, { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 }),
    ).toMatchObject({ ok: false, reason: "duplicate", existing: { processing_state: "failed" } });
  });
});

describe("deleteResearchDocument and the recorded hash", () => {
  it("frees the hash, so the same file uploads again after a delete", () => {
    const input = { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 };
    claimResearchDocumentUpload(db, input);
    const id = createResearchDocument(db, doc({ content_sha256: HASH_A }));
    expect(deleteResearchDocument(db, id)).toBe(true);
    expect(hashRows()).toEqual([]);
    expect(claimResearchDocumentUpload(db, input)).toEqual({ ok: true });
  });

  it("leaves other documents' hashes and unrelated settings alone", () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('unrelated_pref', '7')`).run();
    const keep = createResearchDocument(db, doc({ content_sha256: HASH_A }));
    const drop = createResearchDocument(db, doc({ filename: "other.pdf", content_sha256: HASH_B }));
    deleteResearchDocument(db, drop);
    expect(hashRows()).toEqual([{ key: `research_doc_sha256:${HASH_A}`, value: String(keep) }]);
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'unrelated_pref'`).get()).toEqual({
      value: "7",
    });
  });

  it("treats a hash that points at a document deleted by other means as free", () => {
    const input = { sha256: HASH_A, filename: "outlook.pdf", file_size_bytes: 1000 };
    const id = createResearchDocument(db, doc({ content_sha256: HASH_A }));
    db.prepare(`DELETE FROM research_documents WHERE id = ?`).run(id); // bypasses the mutation
    expect(claimResearchDocumentUpload(db, input)).toEqual({ ok: true });
  });
});

describe("updateResearchDocumentTags comma entry", () => {
  it("stores a comma-separated entry as separate tags", async () => {
    const { updateResearchDocumentTags } = await import("@/lib/mutations/research-documents");
    const id = createResearchDocument(db, doc());
    updateResearchDocumentTags(db, id, ["qa-alpha, qa-beta"]);
    const row = db.prepare(`SELECT tags FROM research_documents WHERE id = ?`).get(id) as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(["qa-alpha", "qa-beta"]);
  });
});
