import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("migration 090 — print-watch go", () => {
  it("adds the two window columns to print_watch_prints, nullable", () => {
    const cols = db.prepare("PRAGMA table_info(print_watch_prints)").all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("forced_open_at")?.notnull).toBe(0);
    expect(byName.get("window_extended_until")?.notnull).toBe(0);
  });

  it("creates print_watch_go_requests with the status and input_kind CHECKs and both indexes", () => {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'print_watch_go_requests'").get() as { sql: string };
    expect(table.sql).toContain("CHECK (status IN ('queued','claimed','done','failed'))");
    expect(table.sql).toContain("CHECK (input_kind IN ('none','url','file'))");
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='print_watch_go_requests'").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(idx).toEqual(["idx_pw_go_requests_print", "idx_pw_go_requests_status"]);
  });

  it("refuses a go row whose print does not exist, and does NOT cascade-delete go rows with their print", () => {
    expect(() =>
      db.prepare(`INSERT INTO print_watch_go_requests (print_id, requested_at) VALUES (999, '2026-09-03T20:00:00.000Z')`).run(),
    ).toThrow(/FOREIGN KEY/);
    const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
    const printId = Number(db.prepare(`INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et) VALUES (?, 'ACME', '2026-09-10', '16:05')`).run(eventId).lastInsertRowid);
    db.prepare(`INSERT INTO print_watch_go_requests (print_id, requested_at) VALUES (?, '2026-09-03T20:00:00.000Z')`).run(printId);
    expect(() => db.prepare(`DELETE FROM print_watch_prints WHERE id = ?`).run(printId)).toThrow(/FOREIGN KEY/);
  });

  it("is recorded once and idempotent on a re-run", () => {
    const before = db.prepare(`SELECT count(*) AS n FROM schema_migrations WHERE filename = '090_print_watch_go.sql'`).get() as { n: number };
    expect(before.n).toBe(1);
    runMigrations(db);
    const after = db.prepare(`SELECT count(*) AS n FROM schema_migrations WHERE filename = '090_print_watch_go.sql'`).get() as { n: number };
    expect(after.n).toBe(1);
  });

  // Amendment (Codex round 1, finding #6): input-coherence CHECK.
  it("enforces input-kind coherence: file needs sha256+bytes_path, url needs input_url, a coherent row of each kind inserts", () => {
    const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k2','ACME')`).run().lastInsertRowid);
    const printId = Number(db.prepare(`INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et) VALUES (?, 'ACME', '2026-09-10', '16:05')`).run(eventId).lastInsertRowid);

    expect(() =>
      db
        .prepare(
          `INSERT INTO print_watch_go_requests (print_id, requested_at, input_kind, input_sha256, input_bytes_path) VALUES (?, '2026-09-03T20:00:00.000Z', 'file', NULL, '/tmp/x')`,
        )
        .run(printId),
    ).toThrow(/CHECK/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO print_watch_go_requests (print_id, requested_at, input_kind, input_url) VALUES (?, '2026-09-03T20:00:00.000Z', 'url', NULL)`,
        )
        .run(printId),
    ).toThrow(/CHECK/);

    expect(() =>
      db
        .prepare(`INSERT INTO print_watch_go_requests (print_id, requested_at, input_kind) VALUES (?, '2026-09-03T20:00:00.000Z', 'none')`)
        .run(printId),
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO print_watch_go_requests (print_id, requested_at, input_kind, input_url) VALUES (?, '2026-09-03T20:00:01.000Z', 'url', 'https://example.com/pr')`,
        )
        .run(printId),
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO print_watch_go_requests (print_id, requested_at, input_kind, input_sha256, input_bytes_path) VALUES (?, '2026-09-03T20:00:02.000Z', 'file', 'deadbeef', '/tmp/y')`,
        )
        .run(printId),
    ).not.toThrow();
  });
});
