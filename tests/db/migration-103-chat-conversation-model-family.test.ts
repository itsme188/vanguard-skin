/**
 * 103: chat_conversations.model_family, the model CLASS a conversation was
 * started on (owner-approved 2026-11-13). Additive and nullable: NULL means
 * "the chat's default", so every conversation written before it keeps
 * resolving exactly as before. The allowed values (haiku, sonnet, opus) are
 * checked in code (lib/chat/model-choice.ts), not by a constraint.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "lib/db/migrations");

function migrationsBefore103(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-mig-102-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith(".sql")) continue;
    if (Number.parseInt(f.slice(0, 3), 10) >= 103) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

type Col = { name: string; type: string; notnull: number; dflt_value: unknown };
const cols = (db: Database.Database) =>
  db.prepare("PRAGMA table_info(chat_conversations)").all() as Col[];

describe("migration 103 - chat_conversations.model_family", () => {
  it("is the only file numbered 103", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("103_"));
    expect(files).toEqual(["103_chat_conversation_model_family.sql"]);
  });

  it("exists on a fresh database as a nullable TEXT with no default", () => {
    const db = new Database(":memory:");
    runMigrations(db, { codeMigrations: {} });
    const col = cols(db).find((c) => c.name === "model_family");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it("keeps existing conversations and messages intact, with model_family NULL", () => {
    const ws = migrationsBefore103();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, { migrationsDir: ws.dir, codeMigrations: {} });
    expect(cols(db).map((c) => c.name)).not.toContain("model_family");
    const before = cols(db).map((c) => c.name);
    const id = Number(
      db.prepare("INSERT INTO chat_conversations (title, scope) VALUES ('old thread', 'ibkr')").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', 'hi')").run(id);

    runMigrations(db, { codeMigrations: {} });

    const row = db.prepare("SELECT * FROM chat_conversations WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.title).toBe("old thread");
    expect(row.scope).toBe("ibkr");
    expect(row.model_family).toBeNull();
    // Nothing else changed: the old columns, in order, then the new one.
    expect(cols(db).map((c) => c.name)).toEqual([...before, "model_family"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    ws.cleanup();
    db.close();
  });

  it("adds no constraint: the allowed values are validated in code", () => {
    const db = new Database(":memory:");
    runMigrations(db, { codeMigrations: {} });
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_conversations'").get() as { sql: string }).sql;
    expect(sql).not.toMatch(/model_family[^,]*CHECK/i);
    db.close();
  });
});
