/**
 * rehearse-additive-migrations.ts — slice D, Task 12 Step 2.
 *
 * The controller runs this against a COPY of the live database (a
 * `VACUUM INTO` copy already migrated to the 089 cutover) to rehearse the
 * FINAL chain the packaged app applies on first launch after the slice C+D
 * deploy: whatever `.sql`/code migrations on disk are not yet in
 * `schema_migrations` (090 from slice C, 091 from slice D — never hardcoded
 * here per controller ruling R-D13, so the same script keeps working if the
 * pending set changes before the deploy).
 *
 * Invariant under test: an ADDITIVE migration chain must not touch a single
 * byte of pre-existing data. Concretely, for every table that existed BEFORE
 * `runMigrations` (except the migration-bookkeeping table itself, which is
 * expected to grow by exactly the pending set):
 *   - its row count is unchanged
 *   - its `sqlite_sequence.seq` (if it has one) is unchanged
 * and for every index that existed before, it still exists; `schema_migrations`
 * gained EXACTLY the expected pending filenames (no more, no fewer);
 * `PRAGMA foreign_key_check` returns no rows; `PRAGMA integrity_check` is 'ok'.
 *
 * Run FROM THE REPO ROOT (the tsx `@/` alias trap — dynamic/aliased imports
 * resolve off the tsconfig found from cwd):
 *
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/rehearse-additive-migrations.ts <db-path>
 *
 * Exit 0 = every check passed; exit 1 = a check failed; exit 2 = refused
 * before running anything (bad path, missing file, safety guard) or a
 * non-check error (e.g. the DB would not open).
 *
 * Safety (this script never runs on the live database, only a copy):
 * refuses any path that resolves under the live checkout's `data/` directory
 * or whose basename is literally `vanguard.db`.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations, migrationOrder } from "@/lib/db/migrate";
import { CODE_MIGRATIONS } from "@/lib/db/code-migrations";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same directory the runner reads (lib/db/migrate.ts resolves this
// relative to its OWN file location, not cwd — this mirrors that so the
// "same discovery the runner uses" holds regardless of invocation cwd).
const MIGRATIONS_DIR = path.join(__dirname, "..", "lib", "db", "migrations");

// The live checkout's database directory — this script only ever runs
// against a COPY, never this path or anything under it.
const LIVE_DATA_DIR = "/Users/Yitzi/code/vanguard-skin/data";

// The bookkeeping table itself is expected to gain rows (one per pending
// migration) — it is asserted separately ("gained exactly the expected
// filenames"), never lumped into the blanket "unchanged" checks below.
const MIGRATION_TABLE = "schema_migrations";

export interface RehearsalResult {
  ok: boolean;
  pending: string[];
  failures: string[];
  report: string;
}

interface SeqRow {
  name: string;
  seq: number;
}

function assertSafeTarget(dbPath: string): void {
  if (path.basename(dbPath) === "vanguard.db") {
    throw new Error(
      `refusing: basename is "vanguard.db" — this script only ever runs on a copy (${dbPath})`,
    );
  }
  let real: string;
  try {
    real = fs.realpathSync(dbPath);
  } catch {
    real = path.resolve(dbPath);
  }
  const rel = path.relative(LIVE_DATA_DIR, real);
  const underLiveDataDir = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (underLiveDataDir) {
    throw new Error(
      `refusing: path resolves under the live database directory (${LIVE_DATA_DIR}) — this script only ever runs on a copy (${dbPath})`,
    );
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: no such file ${dbPath}`);
  }
}

function userTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function tableCounts(db: Database.Database, tables: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
  }
  return counts;
}

function seqRows(db: Database.Database): SeqRow[] {
  const hasTable = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)
    .get();
  if (!hasTable) return [];
  return db.prepare(`SELECT name, seq FROM sqlite_sequence`).all() as SeqRow[];
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function appliedMigrations(db: Database.Database): Set<string> {
  const hasTable = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
    .get();
  if (!hasTable) return new Set();
  return new Set(
    (db.prepare(`SELECT filename FROM schema_migrations`).all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );
}

/** The migration filenames on disk that are NOT yet in `schema_migrations`,
 *  discovered the same way `runMigrations` discovers its own work list:
 *  the `.sql` files in the migrations directory plus the CODE_MIGRATIONS
 *  registry keys, ordered by `migrationOrder`, minus whatever is applied.
 *  Never hardcoded (controller ruling R-D13) — this keeps working whichever
 *  additive migrations are pending on the day. */
function computePending(applied: Set<string>): string[] {
  const sqlFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const order = migrationOrder(sqlFiles, Object.keys(CODE_MIGRATIONS));
  return order.filter((f) => !applied.has(f));
}

export async function rehearseAdditiveMigrations(dbPath: string): Promise<RehearsalResult> {
  assertSafeTarget(dbPath);

  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");

    // --- BEFORE ---
    const beforeTables = userTables(db);
    const beforeCounts = tableCounts(db, beforeTables);
    const beforeSeq = seqRows(db);
    const beforeIndexes = indexNames(db);
    const beforeMigrations = appliedMigrations(db);
    const pending = computePending(beforeMigrations);

    const lines: string[] = [];
    lines.push(`pending: ${pending.length > 0 ? pending.join(", ") : "(none)"}`);
    if (pending.length === 0) {
      lines.push("nothing pending — database already has every migration on disk applied");
    }

    // --- RUN ---
    runMigrations(db);

    // --- AFTER ---
    const afterTables = userTables(db);
    const afterCounts = tableCounts(db, afterTables);
    const afterSeq = seqRows(db);
    const afterIndexes = indexNames(db);
    const afterMigrations = appliedMigrations(db);

    const failures: string[] = [];
    const checks: { name: string; pass: boolean; detail?: string }[] = [];
    const countMismatches: string[] = [];

    // 1. Every pre-existing table's row count unchanged (except the
    //    migration-bookkeeping table, which is expected to grow).
    let rowCountsOk = true;
    for (const t of beforeTables) {
      if (t === MIGRATION_TABLE) continue;
      const before = beforeCounts[t];
      const after = afterCounts[t];
      if (after === undefined) {
        rowCountsOk = false;
        const msg = `table "${t}" no longer exists after migration`;
        failures.push(msg);
        countMismatches.push(msg);
      } else if (after !== before) {
        rowCountsOk = false;
        const msg = `table "${t}": before=${before} after=${after}`;
        failures.push(`row count changed — ${msg}`);
        countMismatches.push(msg);
      }
    }
    checks.push({ name: "pre-existing table row counts unchanged", pass: rowCountsOk });

    // 2. Every pre-existing sqlite_sequence row's seq unchanged (except the
    //    migration-bookkeeping table's own row).
    let seqOk = true;
    const afterSeqByName = new Map(afterSeq.map((r) => [r.name, r.seq]));
    for (const row of beforeSeq) {
      if (row.name === MIGRATION_TABLE) continue;
      const after = afterSeqByName.get(row.name);
      if (after === undefined) {
        seqOk = false;
        failures.push(`sqlite_sequence row for "${row.name}" disappeared`);
      } else if (after !== row.seq) {
        seqOk = false;
        failures.push(`sqlite_sequence "${row.name}": before=${row.seq} after=${after}`);
      }
    }
    checks.push({ name: "pre-existing sqlite_sequence rows unchanged", pass: seqOk });

    // 3. Every pre-existing index still exists.
    const afterIndexSet = new Set(afterIndexes);
    const missingIndexes = beforeIndexes.filter((i) => !afterIndexSet.has(i));
    const indexesOk = missingIndexes.length === 0;
    if (!indexesOk) {
      failures.push(`index(es) missing after migration: ${missingIndexes.join(", ")}`);
    }
    checks.push({ name: "pre-existing indexes still exist", pass: indexesOk });

    // 4. schema_migrations gained EXACTLY the expected pending filenames.
    const newlyApplied = [...afterMigrations].filter((f) => !beforeMigrations.has(f)).sort();
    const expectedSorted = [...pending].sort();
    const gainedExactlyExpected =
      newlyApplied.length === expectedSorted.length &&
      newlyApplied.every((f, i) => f === expectedSorted[i]);
    if (!gainedExactlyExpected) {
      const extra = newlyApplied.filter((f) => !expectedSorted.includes(f));
      const missing = expectedSorted.filter((f) => !newlyApplied.includes(f));
      failures.push(
        `schema_migrations did not gain exactly the expected set — extra: [${extra.join(", ")}], missing: [${missing.join(", ")}]`,
      );
    }
    checks.push({ name: "schema_migrations gained exactly the expected filenames", pass: gainedExactlyExpected });

    // 5. PRAGMA foreign_key_check returns no rows.
    const fkRows = db.prepare(`PRAGMA foreign_key_check`).all();
    const fkOk = fkRows.length === 0;
    if (!fkOk) failures.push(`foreign_key_check reported ${fkRows.length} row(s)`);
    checks.push({ name: "foreign_key_check clean", pass: fkOk });

    // 6. PRAGMA integrity_check returns 'ok'.
    const integrity = db.pragma("integrity_check", { simple: true }) as string;
    const integrityOk = integrity === "ok";
    if (!integrityOk) failures.push(`integrity_check returned "${integrity}", not "ok"`);
    checks.push({ name: "integrity_check ok", pass: integrityOk });

    const ok = failures.length === 0;

    // --- report ---
    for (const c of checks) {
      lines.push(`[${c.pass ? "PASS" : "FAIL"}] ${c.name}`);
    }
    if (countMismatches.length > 0) {
      lines.push("table-count diffs:");
      for (const m of countMismatches) lines.push(`  ${m}`);
    }
    const newTables = afterTables.filter((t) => !beforeTables.includes(t));
    const newIndexes = afterIndexes.filter((i) => !beforeIndexes.includes(i));
    lines.push(`new tables: ${newTables.length > 0 ? newTables.join(", ") : "(none)"}`);
    lines.push(`new indexes: ${newIndexes.length > 0 ? newIndexes.join(", ") : "(none)"}`);
    lines.push(`RESULT: ${ok ? "PASS" : "FAIL"}`);

    return { ok, pending, failures, report: lines.join("\n") };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: rehearse-additive-migrations.ts <db-path>");
    process.exit(2);
  }
  try {
    const result = await rehearseAdditiveMigrations(dbPath);
    console.log(result.report);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

if (process.argv[1]?.endsWith("rehearse-additive-migrations.ts")) {
  main();
}
