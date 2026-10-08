/**
 * scripts/repair-duplicate-research-documents.ts: remove the extra copies of
 * a research PDF stored before the upload dedupe existed (A20, owner ruling
 * 2026-08-31). Synthetic file names, titles and sizes only.
 * [qa:research-documents-upload--no-dedupe-duplicate-pdf-contradictory-extractions]
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  planDuplicateDocumentRepair,
  runDuplicateDocumentRepair,
  formatPlan,
  parseArgs,
} from "@/scripts/repair-duplicate-research-documents";
import { createResearchDocument } from "@/lib/mutations/research-documents";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(
  filename: string,
  size: number | null,
  title: string,
  opts: { tags?: string[]; sha256?: string } = {},
): number {
  return createResearchDocument(db, {
    title,
    author: null,
    source: null,
    filename,
    file_size_bytes: size,
    publication_date: null,
    document_type: "other",
    raw_text: `${title} body`,
    summary: null,
    key_points: null,
    mentioned_symbols: null,
    tags: opts.tags ?? null,
    sentiment: null,
    target_prices: null,
    ai_model: null,
    char_count: null,
    content_sha256: opts.sha256 ?? null,
  });
}

const ids = () =>
  (db.prepare(`SELECT id FROM research_documents ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id);
const tagsOf = (id: number) =>
  JSON.parse((db.prepare(`SELECT tags FROM research_documents WHERE id = ?`).get(id) as { tags: string }).tags ?? "[]");

/** A record that points at a document (a declared foreign key). */
function pointAt(documentId: number): void {
  const eventId = db
    .prepare(
      `INSERT INTO calendar_events (event_date, event_type, title, source, source_key)
       VALUES ('2099-01-15', 'earnings', 'AAA earnings', 'manual', ?)`,
    )
    .run(`manual:test:${documentId}`).lastInsertRowid;
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, research_document_id) VALUES (?, 'pdf_upload', ?)`,
  ).run(eventId, documentId);
}

describe("planDuplicateDocumentRepair", () => {
  it("groups same name + same size, keeps the earliest, and leaves everything else alone", () => {
    const a = seed("outlook.pdf", 1000, "Synthetic Outlook");
    const b = seed("outlook.pdf", 1000, "SYNTHETIC OUTLOOK");
    seed("outlook.pdf", 1001, "Outlook, revised"); // different size: a different file
    seed("other.pdf", 1000, "Other Note");
    seed("forwarded", null, "No size A"); // no size: no evidence
    seed("forwarded", null, "No size B");

    const plan = planDuplicateDocumentRepair(db);
    expect(plan.documentsExamined).toBe(6);
    expect(plan.sets).toHaveLength(1);
    expect(plan.sets[0]).toMatchObject({
      filename: "outlook.pdf",
      keepId: a,
      keepReason: "earliest",
      removeIds: [b],
      skipped: null,
    });
  });

  it("never groups a row the dedupe check accepted (it has a recorded hash)", () => {
    seed("outlook.pdf", 1000, "First", { sha256: "a".repeat(64) });
    seed("outlook.pdf", 1000, "Second", { sha256: "b".repeat(64) });
    expect(planDuplicateDocumentRepair(db).sets).toEqual([]);
  });

  it("keeps the copy other records point at, even when it is not the earliest", () => {
    const a = seed("outlook.pdf", 1000, "First");
    const b = seed("outlook.pdf", 1000, "Second");
    pointAt(b);
    const [set] = planDuplicateDocumentRepair(db).sets;
    expect(set).toMatchObject({ keepId: b, keepReason: "referenced", removeIds: [a] });
  });

  it("skips a set where more than one copy is pointed at", () => {
    const a = seed("outlook.pdf", 1000, "First");
    const b = seed("outlook.pdf", 1000, "Second");
    pointAt(a);
    pointAt(b);
    const [set] = planDuplicateDocumentRepair(db).sets;
    expect(set).toMatchObject({ keepId: null, removeIds: [], skipped: "several_referenced" });
  });

  it("--keep picks the survivor; a --keep that would delete a pointed-at copy is skipped", () => {
    const a = seed("outlook.pdf", 1000, "First");
    const b = seed("outlook.pdf", 1000, "Second");
    expect(planDuplicateDocumentRepair(db, { keep: [b] }).sets[0]).toMatchObject({
      keepId: b,
      keepReason: "named",
      removeIds: [a],
    });
    pointAt(a);
    expect(planDuplicateDocumentRepair(db, { keep: [b] }).sets[0]).toMatchObject({
      keepId: null,
      skipped: "keep_conflicts_with_reference",
    });
  });

  it("reports a --keep id that is in no duplicate set", () => {
    const lone = seed("lone.pdf", 5, "Lone");
    expect(planDuplicateDocumentRepair(db, { keep: [lone] }).unusedKeepIds).toEqual([lone]);
  });
});

describe("runDuplicateDocumentRepair", () => {
  it("dry run (the default) writes nothing", () => {
    seed("outlook.pdf", 1000, "First");
    seed("outlook.pdf", 1000, "Second");
    const before = ids();
    const result = runDuplicateDocumentRepair(db);
    expect(result).toMatchObject({ applied: false, removed: 0 });
    expect(ids()).toEqual(before);
  });

  it("apply removes the extra copies, carries their tags to the kept row, and is idempotent", () => {
    const a = seed("outlook.pdf", 1000, "First", { tags: ["macro", "rates"] });
    const b = seed("outlook.pdf", 1000, "Second", { tags: ["rates", "credit"] });
    const c = seed("outlook.pdf", 1000, "Third");
    const other = seed("other.pdf", 1000, "Other Note");

    const first = runDuplicateDocumentRepair(db, { apply: true });
    expect(first).toMatchObject({ applied: true, removed: 2 });
    expect(ids()).toEqual([a, other]);
    expect(tagsOf(a)).toEqual(["macro", "rates", "credit"]);
    expect(db.prepare(`SELECT COUNT(*) c FROM research_documents WHERE id IN (?, ?)`).get(b, c)).toEqual({ c: 0 });
    // The search index follows the delete (trigger-maintained).
    expect(
      db.prepare(`SELECT COUNT(*) c FROM research_documents_fts WHERE research_documents_fts MATCH 'Second'`).get(),
    ).toEqual({ c: 0 });

    const second = runDuplicateDocumentRepair(db, { apply: true });
    expect(second).toMatchObject({ applied: true, removed: 0 });
    expect(second.plan.sets).toEqual([]);
    expect(ids()).toEqual([a, other]);
  });

  it("apply leaves a skipped set fully intact", () => {
    const a = seed("outlook.pdf", 1000, "First");
    const b = seed("outlook.pdf", 1000, "Second");
    pointAt(a);
    pointAt(b);
    expect(runDuplicateDocumentRepair(db, { apply: true }).removed).toBe(0);
    expect(ids()).toEqual([a, b]);
  });

  it("apply refuses, and writes nothing, when a --keep id matches no set", () => {
    const a = seed("outlook.pdf", 1000, "First");
    const b = seed("outlook.pdf", 1000, "Second");
    expect(() => runDuplicateDocumentRepair(db, { apply: true, keep: [999] })).toThrow(/nothing was written/);
    expect(ids()).toEqual([a, b]);
  });
});

describe("output and arguments", () => {
  it("names ids, the file and the action, and never the file size", () => {
    const a = seed("outlook.pdf", 123456, "First");
    const b = seed("outlook.pdf", 123456, "Second");
    const text = formatPlan(planDuplicateDocumentRepair(db)).join("\n");
    expect(text).toContain(`id ${a}`);
    expect(text).toContain(`id ${b}`);
    expect(text).toContain("keep (earliest upload)");
    expect(text).toContain("would remove");
    expect(text).not.toContain("123456");
  });

  it("parses --apply and repeated --keep, and rejects anything else", () => {
    expect(parseArgs([])).toEqual({ apply: false, keep: [] });
    expect(parseArgs(["--apply", "--keep=7", "--keep=12"])).toEqual({ apply: true, keep: [7, 12] });
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--keep=abc"])).toThrow(/unknown argument/);
  });
});
