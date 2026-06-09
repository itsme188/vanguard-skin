// tests/mutations/research-sources-update-whitelist.test.ts
//
// Pins the updateSource column allowlist: the PATCH /api/research/sources
// route spreads `{ id, ...updates }` straight from the request body, and
// updateSource's dynamic SET loop interpolates each key as a SQL column
// name. Unknown keys must be silently dropped (never interpolated), so a
// crafted body can't probe the schema or throw on prepare.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { updateSource, createSource } from "@/lib/mutations/research";
import { getResearchSources } from "@/lib/queries/research";

describe("updateSource column allowlist", () => {
  let db: Database.Database;
  let sourceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    sourceId = createSource(db, { name: "Test Letter", sender_email: "x@y.com" });
  });

  it("ignores unknown keys instead of interpolating them into SQL", () => {
    expect(() =>
      updateSource(db, sourceId, {
        name: "Renamed",
        // hostile / typo'd keys that are not columns
        ["nonexistent_column" as never]: 1,
        ["name = 'pwned' WHERE 1=1; --" as never]: "x",
      } as never)
    ).not.toThrow();

    const src = getResearchSources(db).find((s) => s.id === sourceId);
    expect(src!.name).toBe("Renamed");
  });

  it("no-ops cleanly when every key is unknown", () => {
    expect(() =>
      updateSource(db, sourceId, { ["bogus" as never]: 1 } as never)
    ).not.toThrow();
    const src = getResearchSources(db).find((s) => s.id === sourceId);
    expect(src!.name).toBe("Test Letter");
  });

  it("still updates every legitimate column", () => {
    updateSource(db, sourceId, {
      name: "N",
      sender_email: "a@b.com",
      sender_pattern: "pat",
      subject_pattern: "subj",
      is_active: 0,
      fetch_frequency: "weekly",
      max_age_days: 14,
      processing_prompt: "prompt",
      website_url: "https://x.com",
      allow_off_topic: 1,
    });
    const src = getResearchSources(db).find((s) => s.id === sourceId);
    expect(src!.name).toBe("N");
    expect(src!.is_active).toBe(0);
    expect(src!.allow_off_topic).toBe(1);
  });
});
