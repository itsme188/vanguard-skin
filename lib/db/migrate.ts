import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_MIGRATIONS, type CodeMigration } from "./code-migrations";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export interface RunMigrationsOptions {
  /** Directory of `.sql` migrations (tests point this at a temp dir). */
  migrationsDir?: string;
  /** Code migrations keyed by filename (tests inject their own). */
  codeMigrations?: Record<string, CodeMigration>;
}

function migrationNumber(name: string): number {
  const n = Number.parseInt(name.slice(0, 3), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** `.sql` files on disk and registry keys, ordered by numeric prefix then name. */
export function migrationOrder(sqlFiles: string[], codeNames: string[]): string[] {
  return [...sqlFiles, ...codeNames].sort(
    (a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b),
  );
}

/**
 * Unapplied migrations that sort AFTER `filename` — the guard a cutover script
 * needs before it hand-runs one migration.
 *
 * `scripts/migrate-089-document-identity.ts` brings a database to the pre-089
 * schema with `runMigrations(conn, { codeMigrations: {} })` and then runs 089
 * itself, in its own gated transaction. The runner applies EVERY pending file
 * on disk in numeric order, so a later-numbered `.sql` added after 089 was
 * written would be applied AHEAD of it, against a schema it was never written
 * for. The script refuses to start while this returns anything.
 *
 * A database with no `schema_migrations` table has applied nothing, so every
 * later migration counts as pending.
 */
export function pendingMigrationsAfter(
  db: Database.Database,
  filename: string,
  opts: RunMigrationsOptions = {},
): string[] {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const codeMigrations = opts.codeMigrations ?? CODE_MIGRATIONS;
  const hasTable = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
    .get() as { ok: number } | undefined;
  const applied = new Set(
    hasTable
      ? (db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[]).map(
          (r) => r.filename,
        )
      : [],
  );
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const order = migrationOrder(sqlFiles, Object.keys(codeMigrations));
  const cutoff = order.indexOf(filename);
  // The cutover file itself need not be on disk (089 lives in the registry the
  // script deliberately passes empty): fall back to its numeric prefix.
  const isAfter = (name: string): boolean =>
    cutoff >= 0 ? order.indexOf(name) > cutoff : migrationNumber(name) > migrationNumber(filename);
  return order.filter((name) => isAfter(name) && !applied.has(name));
}

export function runMigrations(db: Database.Database, opts: RunMigrationsOptions = {}): void {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const codeMigrations = opts.codeMigrations ?? CODE_MIGRATIONS;

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );

  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  for (const file of migrationOrder(sqlFiles, Object.keys(codeMigrations))) {
    if (applied.has(file)) continue;
    const run: CodeMigration = file.endsWith(".ts")
      ? codeMigrations[file]
      : ((sql: string) => (d: Database.Database) => d.exec(sql))(
          fs.readFileSync(path.join(migrationsDir, file), "utf-8"),
        );
    // Synchronous on purpose: a code migration must be `(db) => void` so the
    // whole step — the change AND its bookkeeping row — sits in ONE transaction.
    db.transaction(() => {
      run(db);
      db.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(file);
    })();
  }
}
