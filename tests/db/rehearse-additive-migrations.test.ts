import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { CODE_MIGRATIONS } from "@/lib/db/code-migrations";
import { rehearseAdditiveMigrations } from "@/scripts/rehearse-additive-migrations";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rehearse-additive-migrations-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A file-backed DB with every migration on disk applied (through 091 in
 *  this worktree — slice C's 090 is not on disk here). */
function buildFullyMigratedDb(filePath: string): void {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.close();
}

/** Rolls a fully-migrated DB back to "089 on disk" per the task recipe:
 *  drop 091's bookkeeping row and its two tables (SQLite drops a table's own
 *  indexes automatically). */
function rollBackTo089(filePath: string): void {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.exec(`DELETE FROM schema_migrations WHERE filename LIKE '091%'`);
  db.exec(`DROP TABLE print_watch_callouts`);
  db.exec(`DROP TABLE print_watch_reads`);
  db.close();
}

/** Seeds one row in a pre-existing table so the row-count-unchanged check is
 *  meaningful (synthetic identifiers only — never real tickers/positions). */
function seedCalendarEventRow(filePath: string): void {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.exec(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
     VALUES ('manual', 'earnings', '2026-09-10', 'Synthetic Co', 'rehearse-test-seed-1', 'SYNCO')`,
  );
  db.close();
}

describe("rehearseAdditiveMigrations", () => {
  it("rehearses 091 cleanly on a DB rolled back to 089, with data preserved", async () => {
    const dbPath = path.join(tmpDir, "rehearse-089.db");
    buildFullyMigratedDb(dbPath);
    rollBackTo089(dbPath);
    seedCalendarEventRow(dbPath);

    const result = await rehearseAdditiveMigrations(dbPath);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pending).toEqual(["091_print_watch_first_pass.sql"]);
    expect(result.report).toContain("print_watch_reads");
    expect(result.report).toContain("print_watch_callouts");
    expect(result.report).toContain("RESULT: PASS");

    // The seeded row must still be there, untouched, after the rehearsal.
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT title FROM calendar_events WHERE source_key = ?`)
      .get("rehearse-test-seed-1") as { title: string } | undefined;
    db.close();
    expect(row?.title).toBe("Synthetic Co");
  });

  it("reports nothing pending on an already fully-migrated database", async () => {
    const dbPath = path.join(tmpDir, "rehearse-full.db");
    buildFullyMigratedDb(dbPath);

    const result = await rehearseAdditiveMigrations(dbPath);

    expect(result.ok).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.report).toContain("nothing pending");
  });

  it("refuses a path whose basename is vanguard.db, even on a harmless temp copy", async () => {
    const dbPath = path.join(tmpDir, "vanguard.db");
    buildFullyMigratedDb(dbPath);

    await expect(rehearseAdditiveMigrations(dbPath)).rejects.toThrow(/vanguard\.db/);
  });

  it("refuses a path that does not exist", async () => {
    const dbPath = path.join(tmpDir, "does-not-exist.db");

    await expect(rehearseAdditiveMigrations(dbPath)).rejects.toThrow(/no such file/);
  });

  it("refuses anything under the directory the app's own resolver points at (R-D23)", async () => {
    // The live location is READ FROM THE RESOLVER, never hardcoded — so point
    // the resolver at this temp directory and a copy inside it must be refused
    // exactly as the real data directory would be. `assertSafeTarget` reads
    // `process.env` through the resolver's default argument, so the env is set
    // and restored here rather than injected.
    const dbPath = path.join(tmpDir, "copy-inside-the-live-dir.db");
    buildFullyMigratedDb(dbPath);
    const savedDir = process.env.VANGUARD_DB_DIR;
    const savedPath = process.env.DATABASE_PATH;
    try {
      delete process.env.DATABASE_PATH;
      process.env.VANGUARD_DB_DIR = tmpDir;
      await expect(rehearseAdditiveMigrations(dbPath)).rejects.toThrow(/live database directory/);
    } finally {
      if (savedDir === undefined) delete process.env.VANGUARD_DB_DIR;
      else process.env.VANGUARD_DB_DIR = savedDir;
      if (savedPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = savedPath;
    }
  });

  it("PASSES an ALTER TABLE … ADD COLUMN, naming it a column-append (review M8, R-D30)", async () => {
    // "Additive" means the chain may CREATE and may APPEND columns, never
    // rewrite. The only lever a test has over the pending set is the
    // code-migration registry the runner and the script both read, so a
    // throwaway migration is registered here (and removed in `finally`) that
    // touches a table 091 never sees. Slice C's 090 may add columns at the
    // rebase, so this has to pass — visibly, with the table named.
    const dbPath = path.join(tmpDir, "rehearse-ddl-append.db");
    buildFullyMigratedDb(dbPath);
    const probe = "092_ddl_probe_not_a_real_migration.ts";
    CODE_MIGRATIONS[probe] = (db) => db.exec(`ALTER TABLE calendar_events ADD COLUMN qa_ddl_probe TEXT`);
    try {
      const result = await rehearseAdditiveMigrations(dbPath);
      expect(result.pending).toEqual([probe]);
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.report).toContain("[PASS] pre-existing table and index DDL additive (column-append: calendar_events)");
      expect(result.report).toContain("RESULT: PASS");
    } finally {
      delete CODE_MIGRATIONS[probe];
    }
  });

  it("FAILS when a pending migration rewrites a pre-existing index (review M8, R-D30)", async () => {
    // An index has no additive form: a definition that changed is a rewrite,
    // whatever route it took to get there.
    const dbPath = path.join(tmpDir, "rehearse-ddl-rewrite.db");
    buildFullyMigratedDb(dbPath);
    const probe = "092_ddl_probe_not_a_real_migration.ts";
    CODE_MIGRATIONS[probe] = (db) => {
      db.exec(`DROP INDEX idx_pw_documents_print`);
      db.exec(`CREATE INDEX idx_pw_documents_print ON print_watch_documents(kind)`);
    };
    try {
      const result = await rehearseAdditiveMigrations(dbPath);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(['DDL changed for index "idx_pw_documents_print"']);
      expect(result.report).toContain("[FAIL] pre-existing table and index DDL additive");
      expect(result.report).toContain("RESULT: FAIL");
    } finally {
      delete CODE_MIGRATIONS[probe];
    }
  });
});
