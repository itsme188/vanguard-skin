import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { updateSource } from "@/lib/mutations/research";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSource(name: string): number {
  const res = db
    .prepare("INSERT INTO research_sources (name, is_active) VALUES (?, 1)")
    .run(name);
  return res.lastInsertRowid as number;
}

function readSource(id: number): { earnings_rank: number | null; earnings_note: string | null } {
  return db
    .prepare("SELECT earnings_rank, earnings_note FROM research_sources WHERE id = ?")
    .get(id) as { earnings_rank: number | null; earnings_note: string | null };
}

describe("updateSource — earnings hierarchy fields", () => {
  it("sets and clears earnings_rank", () => {
    const id = seedSource("VK");
    updateSource(db, id, { earnings_rank: 2 });
    expect(readSource(id).earnings_rank).toBe(2);
    updateSource(db, id, { earnings_rank: null });
    expect(readSource(id).earnings_rank).toBeNull();
  });

  it("sets and clears earnings_note", () => {
    const id = seedSource("TMT");
    updateSource(db, id, { earnings_note: "Bogies tables." });
    expect(readSource(id).earnings_note).toBe("Bogies tables.");
    updateSource(db, id, { earnings_note: null });
    expect(readSource(id).earnings_note).toBeNull();
  });
});
