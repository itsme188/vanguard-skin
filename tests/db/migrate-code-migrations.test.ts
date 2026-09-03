import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations, migrationOrder } from "@/lib/db/migrate";

function tmpMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-ts-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

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
