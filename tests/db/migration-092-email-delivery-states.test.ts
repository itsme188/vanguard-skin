import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "lib/db/migrations");
const MIGRATION = "092_earnings_email_delivery_states.sql";

/** The migrations directory MINUS 092 — i.e. the schema as it stood at 091. */
function migrationsThrough091(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-mig-091-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith(".sql") || f === MIGRATION) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** One JSON line per row over the NAMED columns only, so the two new columns
 *  cannot mask a change to an old one. */
function digest(db: Database.Database, cols: string[]): string[] {
  return (db.prepare(`SELECT * FROM earnings_emails ORDER BY id`).all() as Array<Record<string, unknown>>)
    .map((row) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))));
}

let db: Database.Database;
let workspace: { dir: string; cleanup: () => void };
let eventId: number;

beforeEach(() => {
  workspace = migrationsThrough091();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // PASS 1 — build the database the way it exists on disk today, at 091.
  runMigrations(db, { migrationsDir: workspace.dir });
  eventId = Number(
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
       VALUES ('manual','earnings','2026-09-10','XMPL earnings','XMPL','k1')`,
    ).run().lastInsertRowid,
  );
});

afterEach(() => {
  db.close();
  workspace.cleanup();
});

describe("migration 092 — earnings_emails delivery states", () => {
  it("starts from a real 091 database: neither new column exists and 092 is unapplied", () => {
    expect(columnsOf(db, "earnings_emails")).toEqual([
      "id", "event_id", "phase", "recipient", "sent_at",
      "ai_input_hash", "ai_output_md", "error", "claim_token",
    ]);
    expect(
      db.prepare(`SELECT filename FROM schema_migrations WHERE filename = ?`).get(MIGRATION),
    ).toBeUndefined();
  });

  it("applies 092 ALONE over representative rows and leaves every pre-existing field byte-identical", () => {
    const before = columnsOf(db, "earnings_emails");
    const ins = db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error, claim_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // The three shapes 091 can hold: a completed local send, a live claim, a
    // Worker-delivered row.
    ins.run(eventId, "preview", "me@example.com", "2026-09-09 20:05:00", "h1", "# body", null, null);
    const second = Number(
      db.prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings','2026-09-11','XMPL earnings','XMPL','k2')`,
      ).run().lastInsertRowid,
    );
    ins.run(second, "recap", "me@example.com", "2026-09-11 20:05:00", null, null, "in_progress", "tok-live");
    const third = Number(
      db.prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings','2026-09-12','XMPL earnings','XMPL','k3')`,
      ).run().lastInsertRowid,
    );
    ins.run(third, "recap", "cloud-fallback", "2026-09-12 20:05:00", null, null, "sent-by-cloud", null);

    const rowsBefore = digest(db, before);
    const seqBefore = db
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'earnings_emails'`)
      .get() as { seq: number } | undefined;

    // PASS 2 — the REAL directory. Everything below 092 is already recorded in
    // schema_migrations, so exactly one migration runs.
    runMigrations(db);

    expect(
      db.prepare(`SELECT filename FROM schema_migrations WHERE filename = ?`).get(MIGRATION),
    ).toBeTruthy();
    expect(columnsOf(db, "earnings_emails")).toEqual([...before, "provider_message_id", "provider_response"]);
    expect(digest(db, before)).toEqual(rowsBefore);
    expect(
      db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'earnings_emails'`).get(),
    ).toEqual(seqBefore);
    expect(
      db.prepare(`SELECT COUNT(*) c FROM earnings_emails
                   WHERE provider_message_id IS NOT NULL OR provider_response IS NOT NULL`).get(),
    ).toEqual({ c: 0 });
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(db.prepare(`PRAGMA integrity_check`).get()).toEqual({ integrity_check: "ok" });
  });

  it("accepts every one of the five error states — there is no CHECK on error", () => {
    runMigrations(db);
    const ins = db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, error) VALUES (?, ?, 'x@y.com', ?)`,
    );
    for (const [phase, state] of [["preview", null], ["recap", "sending"]] as const) {
      expect(() => ins.run(eventId, phase, state)).not.toThrow();
    }
    for (const state of ["in_progress", "sent-by-cloud", "delivery_unknown", "Send failed: boom"]) {
      db.prepare(`UPDATE earnings_emails SET error = ? WHERE phase = 'recap'`).run(state);
      expect(
        (db.prepare(`SELECT error FROM earnings_emails WHERE phase = 'recap'`).get() as { error: string }).error,
      ).toBe(state);
    }
  });

  it("stores both provider columns and defaults them to NULL", () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, error) VALUES (?, 'recap', 'x@y.com', NULL)`,
    ).run(eventId);
    expect(
      db.prepare(`SELECT provider_message_id, provider_response FROM earnings_emails WHERE event_id = ?`).get(eventId),
    ).toEqual({ provider_message_id: null, provider_response: null });
    db.prepare(
      `UPDATE earnings_emails SET provider_message_id = ?, provider_response = ? WHERE event_id = ?`,
    ).run("<m1@d>", "250 2.0.0 OK", eventId);
    expect(
      db.prepare(`SELECT provider_message_id, provider_response FROM earnings_emails WHERE event_id = ?`).get(eventId),
    ).toEqual({ provider_message_id: "<m1@d>", provider_response: "250 2.0.0 OK" });
  });
});
