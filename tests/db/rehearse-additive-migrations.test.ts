import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
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
});
