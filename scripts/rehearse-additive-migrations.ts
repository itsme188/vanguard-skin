/**
 * rehearse-additive-migrations.ts — slice D, Task 12 Step 2.
 *
 * The controller runs this against a COPY of the live database (a
 * `VACUUM INTO` copy already migrated to the 089 cutover) to rehearse the
 * FINAL chain the packaged app applies on first launch after the slice C+D
 * deploy: whatever `.sql`/code migrations on disk are not yet in
 * `schema_migrations` (090 from slice C, 091 from slice D, 092 from slice E —
 * never hardcoded here per controller ruling R-D13, so the same script keeps
 * working if the pending set changes before the deploy).
 *
 * Invariant under test: an ADDITIVE migration chain must not touch a single
 * byte of pre-existing data. Concretely, for every table that existed BEFORE
 * `runMigrations` (except the migration-bookkeeping table itself, which is
 * expected to grow by exactly the pending set):
 *   - its row count is unchanged
 *   - its `sqlite_sequence.seq` (if it has one) is unchanged
 *   - its stored DDL (`sqlite_master.sql`) is unchanged, OR changed only by
 *     ADDING column definitions — an `ALTER TABLE … ADD COLUMN` is additive
 *     and is reported as a `column-append`, while a rebuild, a dropped CHECK,
 *     a removed or reordered column, a column inserted anywhere but SQLite's
 *     own splice point (between two existing columns, or after a trailing
 *     table constraint), or a changed table constraint fails (review M8,
 *     rulings R-D30 and R-E-C9). NOTE that splice point is IMMEDIATELY after
 *     the last COLUMN DEFINITION, which on a table with trailing table
 *     constraints is NOT at the end of the body — see `isColumnAppend`.
 * and for every index that existed before, it still exists with byte-identical
 * DDL (an index has no additive form — a changed definition is a rewrite);
 * `schema_migrations`
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
 * Safety (this script never runs on the live database, only a copy): refuses
 * a path whose basename is literally `vanguard.db`, the database path the app
 * itself would open (`resolveDbPath`), and anything that resolves under that
 * path's directory. The live location is READ FROM THE RESOLVER, never
 * hardcoded — this repo is public and a developer's home directory is not a
 * constant (R-D23).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations, migrationOrder } from "@/lib/db/migrate";
import { CODE_MIGRATIONS } from "@/lib/db/code-migrations";
import { resolveDbPath } from "@/lib/db/db-path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same directory the runner reads (lib/db/migrate.ts resolves this
// relative to its OWN file location, not cwd — this mirrors that so the
// "same discovery the runner uses" holds regardless of invocation cwd).
const MIGRATIONS_DIR = path.join(__dirname, "..", "lib", "db", "migrations");

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

/** `realpath` where the file exists (so a symlinked temp dir compares against
 *  the same physical path the resolver's directory resolves to), plain
 *  resolution otherwise. */
function physical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function assertSafeTarget(dbPath: string): void {
  if (path.basename(dbPath) === "vanguard.db") {
    throw new Error(
      `refusing: basename is "vanguard.db" — this script only ever runs on a copy (${dbPath})`,
    );
  }
  // The app's own resolution (DATABASE_PATH → VANGUARD_DB_DIR → <cwd>/data),
  // never a hardcoded home directory.
  const livePath = resolveDbPath();
  const liveDir = path.dirname(livePath);
  const real = physical(dbPath);
  if (real === physical(livePath)) {
    throw new Error(
      `refusing: that is the database this app would open (${livePath}) — this script only ever runs on a copy (${dbPath})`,
    );
  }
  const rel = path.relative(physical(liveDir), real);
  const underLiveDataDir = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (underLiveDataDir) {
    throw new Error(
      `refusing: path resolves under the live database directory (${liveDir}) — this script only ever runs on a copy (${dbPath})`,
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

/** Every pre-existing table's and index's stored DDL, keyed `type:name`.
 *  `sqlite_master.sql` is the exact text SQLite stored when the object was
 *  created, so ANY structural change — a rebuild, a dropped constraint, an
 *  added column — changes it. Implicit indexes carry a NULL `sql` and are
 *  covered by the "index still exists" check instead. */
function ddlByName(db: Database.Database): Map<string, string | null> {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string | null }[];
  return new Map(rows.map((r) => [`${r.type} "${r.name}"`, r.sql]));
}

const collapse = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/**
 * Remove SQL comments (`-- …` to end of line, and block comments) from a DDL
 * string WITHOUT touching comment-looking text inside a quoted literal or
 * identifier.
 *
 * This is not hygiene, it is correctness: 19 of this schema's tables carry
 * `--` notes INSIDE their CREATE TABLE body (calendar_events, corporate_actions,
 * print_watch_callouts, …), and `sqlite_master.sql` stores that text verbatim.
 * Once whitespace is collapsed onto one line such a comment swallows whatever
 * followed it, and a comment containing an odd number of apostrophes ("-- the
 * desk's own note") would derail the item splitter's quote tracking outright.
 * Comments carry no schema meaning, so they come out before anything is
 * compared — leaving the comparison about columns and constraints only.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let quote: string | null = null; // the CLOSING delimiter we are waiting for
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote !== null) {
      out += ch;
      if (ch === quote) {
        if (quote !== "]" && sql[i + 1] === quote) {
          out += sql[i + 1];
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      out += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n"; // keep the line break so tokens either side stay separate
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 1; // the loop's own i++ steps past the closing "/"
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Split a collapsed CREATE TABLE body into its TOP-LEVEL comma-separated items
 * — column definitions and table constraints. Commas nested inside parentheses
 * (`CHECK (x IN ('a','b'))`, `NUMERIC(10, 2)`, `FOREIGN KEY (a) REFERENCES
 * t(b, c)`) or inside a quoted string / quoted identifier must NOT split.
 * SQLite quotes with `'`, `"`, backticks and `[...]`, and escapes the first
 * three by doubling.
 */
export function splitTopLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null; // the CLOSING delimiter we are waiting for
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== null) {
      if (ch === quote) {
        if (quote !== "]" && body[i + 1] === quote) {
          i++; // a doubled delimiter is an escaped one, not the end
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      items.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(body.slice(start).trim());
  return items.filter((s) => s.length > 0);
}

/** A TABLE CONSTRAINT rather than a column definition. Inserting one of these
 *  is NOT an additive column append — `ALTER TABLE … ADD COLUMN` cannot
 *  produce it, so its appearance means the table was rebuilt. Matched on the
 *  item's first word, case-insensitively; a column that borrowed one of these
 *  reserved words as its NAME would be rejected, which is the safe direction. */
export function isTableConstraintItem(item: string): boolean {
  const first = item.trim().split(/[\s(]/)[0] ?? "";
  return ["UNIQUE", "PRIMARY", "FOREIGN", "CHECK", "CONSTRAINT"].includes(first.toUpperCase());
}

/**
 * R-D30 / R-E-C9: is `after` just `before` with more COLUMNS added?
 *
 * The original form of this test assumed SQLite inserts a new column
 * immediately before the body's final `)`, and asked whether the old body is a
 * string PREFIX of the new one. That assumption is WRONG, and slice E's
 * migration 092 is where it broke: SQLite inserts an added column after the
 * last COLUMN DEFINITION, which on a table carrying trailing TABLE CONSTRAINTS
 * sits BEFORE them. `earnings_emails` ends `…, error TEXT, UNIQUE(event_id,
 * phase))`, so `ALTER TABLE … ADD COLUMN provider_message_id TEXT` produces
 * `…, error TEXT, provider_message_id TEXT, UNIQUE(event_id, phase))` — the
 * prefix test fails and a genuinely additive migration is reported as a
 * rebuild. Slices C and D never hit it because 090 and 091 CREATE tables; 092
 * is the first ADD COLUMN this script has seen against a constrained table.
 *
 * So the comparison is on ITEM LISTS, not on a string prefix. Additive iff:
 *   - the header (`CREATE TABLE "name"`) and anything after the closing paren
 *     (`WITHOUT ROWID`, `STRICT`) are unchanged;
 *   - every BEFORE item appears in AFTER, byte-identical once whitespace is
 *     collapsed, in the SAME RELATIVE ORDER;
 *   - the only difference is one or more INSERTED items;
 *   - every inserted item is a COLUMN DEFINITION, never a table constraint; and
 *   - every inserted item sits IMMEDIATELY AFTER the last pre-existing COLUMN
 *     DEFINITION — i.e. at SQLite's one and only splice point.
 *
 * That last clause is the review's Important 2, tightened in fix round 3.
 * SQLite records the offset of the END of the last column definition
 * (`Table.addColOffset`) and splices an added column exactly there, so an
 * added column ALWAYS lands after every pre-existing column and BEFORE every
 * table constraint. Two shapes are therefore impossible for `ALTER TABLE …
 * ADD COLUMN`, and both are rejected: a column wedged BETWEEN two existing
 * columns, and a column sitting AFTER a trailing table constraint
 * (`…, UNIQUE(a), extra TEXT)`). Each means the table was REBUILT, which is
 * the class this whole check exists to catch. The subsequence walk on its own
 * accepted both.
 *
 * So, stated positively, this function returns true for EXACTLY ONE kind of
 * change: one or more whole new column definitions appearing as an unbroken
 * run at the splice point, with every other byte of the DDL — header, every
 * pre-existing column, every table constraint, the trailing table options —
 * untouched and in the same order.
 *
 * It returns false for everything else, including: a rebuild; a dropped or
 * added CHECK; a removed, renamed or retyped column; a REORDER of two existing
 * columns; an inserted or changed table constraint; a changed trailing table
 * option (`WITHOUT ROWID` / `STRICT`); a renamed table; an unchanged body
 * (nothing added is not an append); and a table whose BEFORE body has no
 * column definition at all (`lastColIdx === -1` — not a shape SQLite produces,
 * and failing closed there costs nothing).
 *
 * Against the string-prefix test it replaces, it is NOT simply "stronger" (an
 * earlier revision of this comment claimed that and the review disproved it).
 * The two differ in both directions, and each difference is deliberate:
 *   - STRICTER by one shape — the prefix test accepted a column appended at
 *     the very end of the body, AFTER any trailing table constraint. That is
 *     a hand-written rebuild's shape, not one SQLite writes, and it is now
 *     rejected.
 *   - LOOSER by one shape — it accepts the 092 shape, columns added before a
 *     trailing table constraint, which is what SQLite ACTUALLY writes and
 *     which the prefix test wrongly reported as a rebuild.
 * Everything else the prefix test rejected is still rejected, the mid-table
 * insertion included (which the FIRST item-list revision briefly let through).
 * Net: the accepted set is now exactly SQLite's own `ADD COLUMN` output —
 * neither wider nor narrower.
 */
export function isColumnAppend(before: string, after: string): boolean {
  // Comments are stripped BEFORE collapsing — see stripSqlComments.
  const b = collapse(stripSqlComments(before));
  const a = collapse(stripSqlComments(after));

  const bClose = b.lastIndexOf(")");
  const aClose = a.lastIndexOf(")");
  if (bClose === -1 || aClose === -1) return false;
  // Trailing table options (WITHOUT ROWID, STRICT) must be untouched.
  if (collapse(b.slice(bClose + 1)) !== collapse(a.slice(aClose + 1))) return false;

  const bOpen = b.indexOf("(");
  const aOpen = a.indexOf("(");
  if (bOpen === -1 || aOpen === -1 || bOpen >= bClose || aOpen >= aClose) return false;
  // `CREATE TABLE "name"` — a renamed table is not an append.
  if (collapse(b.slice(0, bOpen)) !== collapse(a.slice(0, aOpen))) return false;

  const bItems = splitTopLevelItems(b.slice(bOpen + 1, bClose));
  const aItems = splitTopLevelItems(a.slice(aOpen + 1, aClose));
  if (bItems.length === 0 || aItems.length <= bItems.length) return false;

  // The index of the LAST pre-existing column definition. SQLite splices an
  // added column immediately after it, so nothing may be inserted at or before
  // this point. A table with no column definition at all is not a shape we can
  // reason about — fail closed.
  let lastColIdx = -1;
  for (let i = 0; i < bItems.length; i++) {
    if (!isTableConstraintItem(bItems[i])) lastColIdx = i;
  }
  if (lastColIdx === -1) return false;

  // Walk AFTER left to right, consuming BEFORE in order. Anything that does
  // not match the next expected BEFORE item is an INSERTION.
  const inserted: string[] = [];
  let j = 0;
  for (const item of aItems) {
    if (j < bItems.length && item === bItems[j]) {
      j++;
      continue;
    }
    // `j` is the next BEFORE item still to be matched, and SQLite's splice
    // point is IMMEDIATELY after the last pre-existing column definition, so
    // the only position an ADD COLUMN can occupy is `j === lastColIdx + 1`.
    // `j <= lastColIdx` means a pre-existing COLUMN DEFINITION is still ahead
    // of this insertion (a mid-table insertion); `j > lastColIdx + 1` means a
    // pre-existing TABLE CONSTRAINT has already been consumed, so the item was
    // spliced in after the constraints. ADD COLUMN can do neither.
    if (j !== lastColIdx + 1) return false;
    inserted.push(item);
  }
  // A BEFORE item that never matched was dropped, edited or reordered.
  if (j !== bItems.length) return false;
  if (inserted.length === 0) return false;
  return inserted.every((item) => !isTableConstraintItem(item));
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
    const beforeDdl = ddlByName(db);
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
    const afterDdl = ddlByName(db);
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

    // 3b. Every pre-existing table's and index's DDL is unchanged, or changed
    //     only by appending columns to a TABLE (review M8, R-D30).
    let ddlOk = true;
    const columnAppends: string[] = [];
    for (const [key, sql] of beforeDdl) {
      const after = afterDdl.get(key);
      if (after === undefined) {
        ddlOk = false;
        failures.push(`${key} no longer exists after migration`);
        continue;
      }
      if (after === sql) continue;
      if (key.startsWith('table "') && sql !== null && after !== null && isColumnAppend(sql, after)) {
        columnAppends.push(key.slice('table "'.length, -1));
        continue;
      }
      ddlOk = false;
      failures.push(`DDL changed for ${key}`);
    }
    checks.push({
      name:
        "pre-existing table and index DDL additive" +
        (columnAppends.length > 0 ? ` (column-append: ${columnAppends.join(", ")})` : ""),
      pass: ddlOk,
    });

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
