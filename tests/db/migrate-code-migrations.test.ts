import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations, migrationOrder, pendingMigrationsAfter } from "@/lib/db/migrate";

/** Every temp dir this file makes, removed after each test (they used to leak). */
const tmpDirs: string[] = [];

function tmpMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-ts-"));
  tmpDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function appliedNames(db: Database.Database): string[] {
  return (db.prepare("SELECT filename FROM schema_migrations ORDER BY id").all() as { filename: string }[]).map(
    (r) => r.filename,
  );
}

describe("runMigrations — code (.ts) migrations", () => {
  it("orders .sql and .ts migrations together by numeric prefix, name as tie-break", () => {
    expect(migrationOrder(["003_c.sql", "001_a.sql"], ["002_b.ts"])).toEqual(["001_a.sql", "002_b.ts", "003_c.sql"]);
    expect(migrationOrder(["010_x.sql"], ["009_y.ts", "011_z.ts"])).toEqual(["009_y.ts", "010_x.sql", "011_z.ts"]);
  });

  it("runs a mixed sequence in order, inside one transaction each, and records every filename", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({
      "001_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);",
      "003_c.sql": "INSERT INTO b (v) VALUES ('from-003');",
    });
    runMigrations(db, {
      migrationsDir: dir,
      codeMigrations: {
        "002_b.ts": (d) => {
          d.exec("CREATE TABLE b (v TEXT); INSERT INTO b (v) VALUES ('from-002')");
        },
      },
    });
    expect(appliedNames(db)).toEqual(["001_a.sql", "002_b.ts", "003_c.sql"]);
    const rows = (db.prepare("SELECT v FROM b ORDER BY rowid").all() as { v: string }[]).map((r) => r.v);
    expect(rows).toEqual(["from-002", "from-003"]);
  });

  it("rolls back a throwing .ts migration completely and leaves earlier ones applied", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({ "001_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);" });
    expect(() =>
      runMigrations(db, {
        migrationsDir: dir,
        codeMigrations: {
          "002_boom.ts": (d) => {
            d.exec("CREATE TABLE half (id INTEGER)");
            throw new Error("boom");
          },
        },
      }),
    ).toThrow("boom");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toContain("a");
    expect(tables).not.toContain("half");
    expect(appliedNames(db)).toEqual(["001_a.sql"]);
  });

  it("is idempotent for .ts migrations — a second run applies nothing", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({ "001_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);" });
    const calls: number[] = [];
    const opts = {
      migrationsDir: dir,
      codeMigrations: { "002_b.ts": () => { calls.push(1); } },
    };
    runMigrations(db, opts);
    runMigrations(db, opts);
    expect(calls).toHaveLength(1);
    expect(appliedNames(db)).toEqual(["001_a.sql", "002_b.ts"]);
  });

  it("still applies the real migration set with the default registry", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(appliedNames(db).length).toBeGreaterThanOrEqual(87);
  });
});

// A cutover script (scripts/migrate-089-document-identity.ts) brings a database
// to the pre-089 schema with `runMigrations(conn, { codeMigrations: {} })` and
// then runs 089 itself. The runner applies EVERY pending `.sql` on disk in
// numeric order, so a later-numbered migration would be applied AHEAD of 089 —
// against the pre-089 schema it was never written for. The script refuses when
// this reports anything.
describe("pendingMigrationsAfter", () => {
  it("names unapplied migrations that sort after the cutover, and nothing else", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({
      "088_before.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);",
      "090_after.sql": "CREATE TABLE b (id INTEGER PRIMARY KEY);",
      "091_later.sql": "CREATE TABLE c (id INTEGER PRIMARY KEY);",
    });
    const opts = { migrationsDir: dir, codeMigrations: {} };
    expect(pendingMigrationsAfter(db, "089_x.ts", opts)).toEqual(["090_after.sql", "091_later.sql"]);

    // Already applied is not pending.
    runMigrations(db, { migrationsDir: dir, codeMigrations: {} });
    expect(pendingMigrationsAfter(db, "089_x.ts", opts)).toEqual([]);
  });

  it("counts a later CODE migration too, and ignores same-numbered/earlier ones", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({ "089_other.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);" });
    expect(
      pendingMigrationsAfter(db, "089_x.ts", {
        migrationsDir: dir,
        codeMigrations: { "090_b.ts": () => {}, "080_a.ts": () => {} },
      }),
    ).toEqual(["090_b.ts"]);
  });

  it("counts every later migration as pending on a database with no schema_migrations table yet", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({ "090_after.sql": "CREATE TABLE b (id INTEGER PRIMARY KEY);" });
    expect(pendingMigrationsAfter(db, "089_x.ts", { migrationsDir: dir, codeMigrations: {} })).toEqual([
      "090_after.sql",
    ]);
  });
});
