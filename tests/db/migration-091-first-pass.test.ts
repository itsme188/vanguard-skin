import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}
function seedPrint(key: string): number {
  const eventId = Number(
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME',?,'ACME')`).run(key).lastInsertRowid,
  );
  return Number(
    db.prepare(`INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et, state) VALUES (?, 'ACME', '2026-09-10', '16:05', 'parsed')`).run(eventId).lastInsertRowid,
  );
}
function seedDoc(printId: number, sha: string): number {
  return Number(
    db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict, gate_version, parse_state) VALUES (?, 'user-drop', 'drop', ?, '/tmp/x.txt', 'accepted', 2, 'parsed')`).run(printId, sha).lastInsertRowid,
  );
}

describe("migration 091 — first-pass read tables", () => {
  it("records itself and creates both tables with the contract columns", () => {
    expect(db.prepare(`SELECT filename FROM schema_migrations WHERE filename = ?`).get("091_print_watch_first_pass.sql")).toBeTruthy();
    expect(columns("print_watch_reads")).toEqual([
      "id", "print_id", "fingerprint", "nonce", "status", "claim_token", "claimed_at", "heartbeat_at", "attempts",
      "next_retry_at", "model_id", "facts_json", "prose_json", "error", "error_code", "generated_at", "created_at",
    ]);
    expect(columns("print_watch_callouts")).toEqual([
      "id", "print_id", "read_id", "label", "label_norm", "value", "value_high", "unit", "value_text", "snippet", "doc_id",
      "doc_sha256", "evidence_sha256", "verifier_version", "vs_bogey_text", "state", "accepted_at", "revoked_at",
      "superseded_by_read_id", "created_at", "updated_at",
    ]);
  });

  it("reads: UNIQUE(print_id, fingerprint, nonce); status and error_code CHECKs", () => {
    const printId = seedPrint("k1");
    const ins = db.prepare(`INSERT INTO print_watch_reads (print_id, fingerprint, nonce, status, error_code) VALUES (?, 'fp', ?, ?, ?)`);
    ins.run(printId, 0, "generating", null);
    expect(() => ins.run(printId, 0, "generating", null)).toThrow(/UNIQUE/);
    expect(() => ins.run(printId, 1, "bogus", null)).toThrow(/CHECK/);
    expect(() => ins.run(printId, 1, "failed", "whatever")).toThrow(/CHECK/);
    ins.run(printId, 1, "failed", "model_drift");
  });

  it("callouts: semantic UNIQUE(print_id, doc_sha256, label_norm, unit); unit/state CHECKs; doc_id and read_id ON DELETE SET NULL", () => {
    const printId = seedPrint("k2");
    const docId = seedDoc(printId, "abc");
    const readId = Number(db.prepare(`INSERT INTO print_watch_reads (print_id, fingerprint, nonce, status) VALUES (?, 'fp', 0, 'done')`).run(printId).lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO print_watch_callouts (print_id, read_id, label, label_norm, value, unit, value_text, snippet, doc_id, doc_sha256, evidence_sha256, verifier_version)
       VALUES (?, ?, 'ARR', 'arr', 3740000000, ?, '$3.74B', ?, ?, 'abc', 'ev', 1)`,
    );
    ins.run(printId, readId, "usd", "ARR of $3.74B", docId);
    expect(() => ins.run(printId, readId, "usd", "a different snippet, same label+unit", docId)).toThrow(/UNIQUE/);
    ins.run(printId, readId, "percent", "ARR grew 24%", docId); // same label, different unit → distinct
    expect(() => ins.run(printId, readId, "furlongs", "x", docId)).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE print_watch_callouts SET state = 'weird' WHERE print_id = ?`).run(printId)).toThrow(/CHECK/);
    db.prepare(`DELETE FROM print_watch_documents WHERE id = ?`).run(docId);
    db.prepare(`DELETE FROM print_watch_reads WHERE id = ?`).run(readId);
    const rows = db.prepare(`SELECT doc_id, read_id, doc_sha256 FROM print_watch_callouts WHERE print_id = ?`).all(printId) as Array<{ doc_id: number | null; read_id: number | null; doc_sha256: string }>;
    expect(rows.every((r) => r.doc_id === null && r.read_id === null && r.doc_sha256 === "abc")).toBe(true);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
