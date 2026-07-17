import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEarningsSourceHierarchy } from "@/lib/queries/research";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Clear seeded data from migration 019 to isolate test data
  db.prepare("DELETE FROM research_sources").run();
});

function seedSource(name: string, rank: number | null, note: string | null = null): number {
  const res = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active, earnings_rank, earnings_note) VALUES (?, ?, 1, ?, ?)"
    )
    .run(name, `${name.toLowerCase().replace(/\s+/g, "")}@example.com`, rank, note);
  return res.lastInsertRowid as number;
}

describe("getEarningsSourceHierarchy", () => {
  it("returns only ranked sources, ordered by rank ascending", () => {
    seedSource("Unranked Letter", null);
    seedSource("Third", 3);
    seedSource("First", 1, "Bogies tables — quote exact numbers.");
    seedSource("Second", 2);

    const rows = getEarningsSourceHierarchy(db);
    expect(rows.map((r) => r.name)).toEqual(["First", "Second", "Third"]);
    expect(rows[0].earnings_note).toBe("Bogies tables — quote exact numbers.");
    expect(rows[1].earnings_note).toBeNull();
  });

  it("breaks duplicate ranks by id ascending", () => {
    const a = seedSource("Dup A", 2);
    const b = seedSource("Dup B", 2);
    const rows = getEarningsSourceHierarchy(db);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
  });

  it("returns empty array when nothing is ranked", () => {
    seedSource("Only Unranked", null);
    expect(getEarningsSourceHierarchy(db)).toEqual([]);
  });
});
