import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

/** Authoring-time column list of the rebuilt table. The migration's INSERT…SELECT
 *  copies exactly the first 18 of these (the pre-088 columns, in this order). */
const EXPECTED_BOGEY_COLUMNS = [
  "id", "event_id", "source", "source_label", "source_url", "raw_pdf_r2_key",
  "research_document_id", "research_article_id", "eps_consensus", "eps_whisper",
  "revenue_consensus_usd", "revenue_whisper_usd", "segment_breakdown_json",
  "guidance_notes", "notes", "uploaded_at", "ai_extraction_model", "expected_move_pct",
  "eps_consensus_vendor", "extra_metrics_json",
];

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("migration 088: live print v2 slice A", () => {
  it("creates the three new tables with their primary keys", () => {
    const db = fresh();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["earnings_prepare_steps", "earnings_bogey_scans", "cloud_outbox"]));
    const pk = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk("earnings_prepare_steps")).toEqual(["event_id", "step"]);
    expect(pk("earnings_bogey_scans")).toEqual(["event_id", "article_id", "extractor_version"]);
    expect(pk("cloud_outbox")).toEqual(["id"]);
  });

  it("rebuilds earnings_bogeys with exactly the authoring-time column list, in order", () => {
    const db = fresh();
    const cols = (db.prepare(`PRAGMA table_info(earnings_bogeys)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(EXPECTED_BOGEY_COLUMNS);
  });

  it("accepts source 'finnhub' and still rejects an unknown source", () => {
    const db = fresh();
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-03','x','k1','BETA')`).run();
    const insert = (source: string) =>
      db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (1, ?, 'lbl')`).run(source);
    expect(() => insert("finnhub")).not.toThrow();
    expect(() => insert("bogus")).toThrow(/CHECK/);
  });

  it("preserves ids, values, the UNIQUE key, and both indexes across the rebuild", () => {
    // Run every migration up to 087, seed, then apply 088 alone.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = path.join(process.cwd(), "lib", "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "088_")) db.exec(fs.readFileSync(path.join(dir, f), "utf-8"));
    db.prepare(`INSERT INTO calendar_events (id, source, event_type, event_date, title, source_key, symbol) VALUES (7,'finnhub','earnings','2026-09-03','x','k7','BETA')`).run();
    db.prepare(`INSERT INTO earnings_bogeys (id, event_id, source, source_label, eps_consensus, revenue_consensus_usd, expected_move_pct) VALUES (42, 7, 'manual', 'desk', 1.25, 1e9, 6.5)`).run();
    db.exec(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith("088_"))!), "utf-8"));
    const row = db.prepare(`SELECT id, event_id, source, source_label, eps_consensus, revenue_consensus_usd, expected_move_pct, eps_consensus_vendor, extra_metrics_json FROM earnings_bogeys`).get() as Record<string, unknown>;
    expect(row).toEqual({ id: 42, event_id: 7, source: "manual", source_label: "desk", eps_consensus: 1.25, revenue_consensus_usd: 1e9, expected_move_pct: 6.5, eps_consensus_vendor: null, extra_metrics_json: null });
    expect(() => db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (7,'manual','desk')`).run()).toThrow(/UNIQUE/);
    // The UNIQUE(event_id, source, source_label) constraint has always produced a
    // third, SQLite-generated autoindex (verified present pre-088 too) — the
    // property under test is that the rebuild preserves the FULL index set, not
    // that only the two explicit CREATE INDEX statements survive.
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='earnings_bogeys'`).all() as { name: string }[]).map((r) => r.name).sort();
    expect(idx).toEqual(["idx_earnings_bogeys_event", "idx_earnings_bogeys_uploaded", "sqlite_autoindex_earnings_bogeys_1"]);
    // FK still cascades from calendar_events.
    db.prepare(`DELETE FROM calendar_events WHERE id = 7`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
  });

  it("carries the AUTOINCREMENT high-water mark across the rebuild even after the highest id is deleted", () => {
    // Same replay-pre-088-files-then-apply-088 approach as the "preserves ids,
    // values..." test above: run every migration file up to (not including)
    // 088 directly via db.exec, then apply 088's SQL text on its own.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = path.join(process.cwd(), "lib", "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "088_")) db.exec(fs.readFileSync(path.join(dir, f), "utf-8"));
    db.prepare(`INSERT INTO calendar_events (id, source, event_type, event_date, title, source_key, symbol) VALUES (9,'finnhub','earnings','2026-09-03','x','k9','GAMMA')`).run();
    db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (9,'manual','a')`).run();
    db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (9,'manual','b')`).run();
    db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (9,'manual','c')`).run();
    // Delete the highest id (3) — without the fix, the rebuild's counter
    // regresses to MAX(id) of the surviving rows (2), and the next insert
    // reissues id 3.
    db.prepare(`DELETE FROM earnings_bogeys WHERE id = 3`).run();
    db.exec(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith("088_"))!), "utf-8"));
    const seq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'earnings_bogeys'`).get() as { seq: number };
    expect(seq.seq).toBe(3);
    const next = db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (9,'manual','d')`).run();
    expect(next.lastInsertRowid).toBe(4);
  });

  it("[C-15] applies cleanly when a later-numbered migration (slice B's 089) was recorded first", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = path.join(process.cwd(), "lib", "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
    for (const f of files.filter((f) => f < "088_")) {
      db.exec(fs.readFileSync(path.join(dir, f), "utf-8"));
      db.prepare(`INSERT INTO schema_migrations (filename) VALUES (?)`).run(f);
    }
    // Pretend 089 (a .ts migration on B's branch) already ran: the runner keys on filename, not order.
    db.prepare(`INSERT INTO schema_migrations (filename) VALUES ('089_print_watch_document_identity.ts')`).run();
    runMigrations(db);
    const applied = (db.prepare(`SELECT filename FROM schema_migrations ORDER BY id`).all() as { filename: string }[]).map((r) => r.filename);
    expect(applied.filter((f) => f.startsWith("088_"))).toHaveLength(1);
    expect(applied).toContain("089_print_watch_document_identity.ts");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('earnings_prepare_steps','earnings_bogey_scans','cloud_outbox')`).get()).toEqual({ n: 3 });
  });
});
