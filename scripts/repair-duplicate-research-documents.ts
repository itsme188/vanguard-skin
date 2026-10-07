/**
 * repair-duplicate-research-documents.ts — remove the extra copies of a
 * research PDF that was uploaded more than once.
 *
 * Why it exists (owner ruling 2026-08-31, option 1): the upload route now
 * refuses an exact re-upload, but the copies stored before that are still in
 * the library. Each copy was extracted by a separate AI call, so the copies
 * carry different symbols and tags for one file, and chat retrieval counts the
 * source twice.
 *
 * What counts as a duplicate set: two or more `research_documents` rows with
 * the same `filename` AND the same `file_size_bytes`, none of which has a
 * recorded content hash. (The file bytes are not kept, so name + size is the
 * only evidence there is for rows stored before hashing. A row WITH a recorded
 * hash was accepted by the dedupe check as different content and is never
 * grouped.) READ THE DRY RUN before applying: if two listed rows are really
 * different files that happen to share a name and a size, do not apply.
 *
 * What it changes, per set:
 *   - keeps ONE row: the one named with --keep=<id>, else the one other
 *     records point at (a bogey source, a forwarded-email record), else the
 *     earliest upload (lowest id);
 *   - adds the removed rows' tags to the kept row (tags are the only
 *     user-edited field; the kept row's own tags come first, and the usual
 *     tag limits apply);
 *   - deletes the other rows.
 * The kept row's title, summary, symbols and text are not merged or rewritten.
 * A set is SKIPPED, and nothing in it is touched, when a row that would be
 * deleted is still pointed at by another record.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-duplicate-research-documents.ts
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-duplicate-research-documents.ts --keep=<id>
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-duplicate-research-documents.ts --apply
 *
 * Dry run is the default and opens the database read-only. `--apply` writes
 * every change in one transaction. Running it again changes nothing.
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 *
 * The output names document ids, file names, titles, upload dates and counts.
 * It prints no portfolio figure. It runs on the owner's machine; do not paste
 * its output into a committed file.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  deleteResearchDocument,
  updateResearchDocumentTags,
  UPLOAD_HASH_KEY_PREFIX,
} from "@/lib/mutations/research-documents";
import { normalizeTags } from "@/lib/research-documents/extract";

// ─── Shapes ─────────────────────────────────────────────────────────

export interface RepairDuplicateDocumentsOptions {
  apply?: boolean;
  /** Ids the owner wants kept; each decides the set it belongs to. */
  keep?: number[];
}

export interface DuplicateDocumentRow {
  id: number;
  title: string;
  uploadedAt: string;
  /** Other records that point at this document (it cannot be deleted). */
  referencedBy: string[];
}

export type KeepReason = "named" | "referenced" | "earliest";
export type SkipReason =
  /** More than one row is pointed at by other records. */
  | "several_referenced"
  /** --keep named a row, but another row in the set is pointed at. */
  | "keep_conflicts_with_reference"
  /** --keep named more than one row of this set. */
  | "several_keep_ids";

export interface DuplicateDocumentSet {
  filename: string;
  rows: DuplicateDocumentRow[];
  /** Null when the set is skipped. */
  keepId: number | null;
  keepReason: KeepReason | null;
  removeIds: number[];
  /** The kept row's tags after the removed rows' tags are added. */
  mergedTags: string[];
  /** Tags the kept row gains. */
  tagsAdded: string[];
  skipped: SkipReason | null;
}

export interface DuplicateDocumentRepairPlan {
  documentsExamined: number;
  sets: DuplicateDocumentSet[];
  /** --keep ids that are not in any duplicate set. */
  unusedKeepIds: number[];
}

// ─── Plan ───────────────────────────────────────────────────────────

/** Every (table, column) that points at research_documents.id. */
function referenceColumns(db: Database.Database): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!'`)
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const fks = db.prepare(`SELECT "table" AS target, "from" AS col FROM pragma_foreign_key_list(?)`).all(name) as Array<{
      target: string;
      col: string;
    }>;
    for (const fk of fks) {
      if (fk.target === "research_documents") out.push({ table: name, column: fk.col });
    }
  }
  // Not a declared foreign key, but the same kind of pointer.
  const inbox = db
    .prepare(`SELECT 1 FROM pragma_table_info('research_inbox_messages') WHERE name = 'document_id'`)
    .get();
  if (inbox) out.push({ table: "research_inbox_messages", column: "document_id" });
  return out;
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Read-only. Decides, set by set, what an apply would write. */
export function planDuplicateDocumentRepair(
  db: Database.Database,
  opts: RepairDuplicateDocumentsOptions = {},
): DuplicateDocumentRepairPlan {
  const keepIds = new Set(opts.keep ?? []);
  const usedKeepIds = new Set<number>();
  const refs = referenceColumns(db);

  const documentsExamined = (db.prepare(`SELECT COUNT(*) AS c FROM research_documents`).get() as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.filename, d.file_size_bytes, d.uploaded_at, d.tags
         FROM research_documents d
        WHERE d.file_size_bytes IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM settings s
             WHERE substr(s.key, 1, ?) = ? AND s.value = CAST(d.id AS TEXT)
          )
        ORDER BY d.filename, d.file_size_bytes, d.id`,
    )
    .all(UPLOAD_HASH_KEY_PREFIX.length, UPLOAD_HASH_KEY_PREFIX) as Array<{
      id: number;
      title: string;
      filename: string;
      file_size_bytes: number;
      uploaded_at: string;
      tags: string | null;
    }>;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = JSON.stringify([row.filename, row.file_size_bytes]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const sets: DuplicateDocumentSet[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const setRows: DuplicateDocumentRow[] = group.map((row) => ({
      id: row.id,
      title: row.title,
      uploadedAt: row.uploaded_at,
      referencedBy: refs
        .filter(
          (ref) =>
            db.prepare(`SELECT 1 FROM "${ref.table}" WHERE "${ref.column}" = ? LIMIT 1`).get(row.id) !== undefined,
        )
        .map((ref) => `${ref.table}.${ref.column}`),
    }));
    const referenced = setRows.filter((r) => r.referencedBy.length > 0);
    const named = setRows.filter((r) => keepIds.has(r.id));
    for (const r of named) usedKeepIds.add(r.id);

    let keepId: number | null = null;
    let keepReason: KeepReason | null = null;
    let skipped: SkipReason | null = null;
    if (named.length > 1) {
      skipped = "several_keep_ids";
    } else if (referenced.length > 1) {
      skipped = "several_referenced";
    } else if (named.length === 1) {
      if (referenced.length === 1 && referenced[0].id !== named[0].id) {
        skipped = "keep_conflicts_with_reference";
      } else {
        keepId = named[0].id;
        keepReason = "named";
      }
    } else if (referenced.length === 1) {
      keepId = referenced[0].id;
      keepReason = "referenced";
    } else {
      keepId = setRows[0].id; // rows are ordered by id: the earliest upload
      keepReason = "earliest";
    }

    let mergedTags: string[] = [];
    let tagsAdded: string[] = [];
    if (keepId != null) {
      const kept = parseTags(group.find((r) => r.id === keepId)!.tags);
      const others = group.filter((r) => r.id !== keepId).flatMap((r) => parseTags(r.tags));
      mergedTags = normalizeTags([...kept, ...others]);
      const before = new Set(normalizeTags(kept));
      tagsAdded = mergedTags.filter((t) => !before.has(t));
    }

    sets.push({
      filename: group[0].filename,
      rows: setRows,
      keepId,
      keepReason,
      removeIds: keepId == null ? [] : setRows.filter((r) => r.id !== keepId).map((r) => r.id),
      mergedTags,
      tagsAdded,
      skipped,
    });
  }

  return {
    documentsExamined,
    sets,
    unusedKeepIds: [...keepIds].filter((id) => !usedKeepIds.has(id)),
  };
}

/**
 * Plan, then (only with `apply`) write. The plan is resolved INSIDE the write
 * transaction, so what is written is what that same read decided; a row that
 * does not delete exactly once rolls the whole run back.
 */
export function runDuplicateDocumentRepair(
  db: Database.Database,
  opts: RepairDuplicateDocumentsOptions = {},
): { plan: DuplicateDocumentRepairPlan; applied: boolean; removed: number } {
  if (!opts.apply) return { plan: planDuplicateDocumentRepair(db, opts), applied: false, removed: 0 };

  const result = db.transaction(() => {
    const plan = planDuplicateDocumentRepair(db, opts);
    if (plan.unusedKeepIds.length > 0) {
      throw new Error(
        `--keep id(s) ${plan.unusedKeepIds.join(", ")} are not in any duplicate set; nothing was written`,
      );
    }
    let removed = 0;
    for (const set of plan.sets) {
      if (set.keepId == null) continue;
      if (set.tagsAdded.length > 0) updateResearchDocumentTags(db, set.keepId, set.mergedTags);
      for (const id of set.removeIds) {
        if (!deleteResearchDocument(db, id)) {
          throw new Error(`document id ${id}: expected to delete 1 row, deleted 0; nothing was written`);
        }
        removed += 1;
      }
    }
    return { plan, removed };
  })();
  return { ...result, applied: true };
}

// ─── Output ─────────────────────────────────────────────────────────

const KEEP_WHY: Record<KeepReason, string> = {
  named: "named with --keep",
  referenced: "other records point at it",
  earliest: "earliest upload",
};

const SKIP_WHY: Record<SkipReason, string> = {
  several_referenced: "more than one copy is pointed at by other records; repoint those by hand first",
  keep_conflicts_with_reference: "--keep names one copy but other records point at a different one",
  several_keep_ids: "--keep names more than one copy of this set",
};

/** Ids, file names, titles, upload dates and counts. Never a portfolio figure. */
export function formatPlan(plan: DuplicateDocumentRepairPlan, applied = false): string[] {
  const lines: string[] = [];
  const actionable = plan.sets.filter((s) => s.keepId != null);
  const removeCount = actionable.reduce((n, s) => n + s.removeIds.length, 0);
  lines.push(`documents examined:              ${plan.documentsExamined}`);
  lines.push(`duplicate sets found:            ${plan.sets.length}`);
  lines.push(`${applied ? "copies removed:      " : "copies that would be removed:"}    ${removeCount}`);
  lines.push(`sets skipped:                    ${plan.sets.length - actionable.length}`);

  for (const set of plan.sets) {
    lines.push("");
    lines.push(`"${set.filename}" (${set.rows.length} copies with the same name and size):`);
    for (const row of set.rows) {
      const role =
        set.keepId == null
          ? "untouched"
          : row.id === set.keepId
            ? `${applied ? "kept" : "keep"} (${KEEP_WHY[set.keepReason!]})`
            : applied
              ? "removed"
              : "would remove";
      const refs = row.referencedBy.length > 0 ? `; pointed at by ${row.referencedBy.join(", ")}` : "";
      lines.push(`  id ${row.id}, uploaded ${row.uploadedAt}, "${row.title}": ${role}${refs}`);
    }
    if (set.skipped) {
      lines.push(`  SKIPPED: ${SKIP_WHY[set.skipped]}.`);
    } else if (set.tagsAdded.length > 0) {
      lines.push(
        `  tags ${applied ? "added" : "that would be added"} to id ${set.keepId}: ${set.tagsAdded.join(", ")}`,
      );
    }
  }
  if (plan.unusedKeepIds.length > 0) {
    lines.push("");
    lines.push(`--keep id(s) not in any duplicate set: ${plan.unusedKeepIds.join(", ")}`);
  }
  return lines;
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

export function parseArgs(argv: string[]): RepairDuplicateDocumentsOptions {
  const keep: number[] = [];
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const match = /^--keep=(\d+)$/.exec(arg);
    if (match) {
      keep.push(Number(match[1]));
      continue;
    }
    throw new Error(`unknown argument ${arg} (known: --apply, --keep=<document id>)`);
  }
  return { apply, keep };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = new BetterSqlite3(DB_PATH, { readonly: !opts.apply, fileMustExist: true }) as Database.Database;
  db.pragma("foreign_keys = ON");

  try {
    console.log(`Duplicate research document repair ${opts.apply ? "[APPLY]" : "[DRY RUN]"}, db: ${DB_PATH}\n`);
    const { plan, applied, removed } = runDuplicateDocumentRepair(db, opts);
    for (const line of formatPlan(plan, applied)) console.log(line);

    if (!applied) {
      console.log("\nDry run (default): nothing was written. Re-run with --apply to write.");
      console.log("To keep a different copy of a set, add --keep=<id> (once per set).");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply",
      );
      return;
    }
    console.log(`\nRemoved ${removed} document(s). Reload Research > Documents to see the list.`);
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-option-sectors.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-duplicate-research-documents.ts") ||
    process.argv[1].endsWith("repair-duplicate-research-documents.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
