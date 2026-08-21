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

  it("clearing earnings_rank also clears earnings_note (remove-from-hierarchy orphan)", () => {
    // Mirrors handleRemoveFromHierarchy's PATCH: it only sends
    // { earnings_rank: null }, never earnings_note. If the note survived,
    // re-adding the source via "+ earnings" would pre-fill stale prompt
    // instructions into a fresh hierarchy slot.
    const id = seedSource("VK");
    updateSource(db, id, { earnings_rank: 2, earnings_note: "Only trust the headline number." });
    expect(readSource(id)).toEqual({ earnings_rank: 2, earnings_note: "Only trust the headline number." });

    updateSource(db, id, { earnings_rank: null });
    expect(readSource(id)).toEqual({ earnings_rank: null, earnings_note: null });
  });

  it("an explicit earnings_note alongside a non-null earnings_rank is not clobbered", () => {
    // Guard against an overly-broad fix: only rank -> null should force the
    // note to null. A normal reorder/add PATCH that includes a rank must
    // still let the note through untouched.
    const id = seedSource("VK");
    updateSource(db, id, { earnings_rank: 1, earnings_note: "Read the guidance table only." });
    expect(readSource(id)).toEqual({ earnings_rank: 1, earnings_note: "Read the guidance table only." });
  });
});
