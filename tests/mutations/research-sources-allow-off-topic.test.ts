// tests/mutations/research-sources-allow-off-topic.test.ts
//
// Pins the allow_off_topic round-trip (migration 055): updateSource persists
// the flag and getResearchSources returns it — the ManageSourcesModal toggle
// depends on both ends. The D3 gate behavior itself is covered in
// tests/gmail/process-portfolio-relevance.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { updateSource, createSource } from "@/lib/mutations/research";
import { getResearchSources } from "@/lib/queries/research";

describe("allow_off_topic source flag", () => {
  let db: Database.Database;
  let sourceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    sourceId = createSource(db, { name: "Test Letter", sender_email: "x@y.com" });
  });

  it("defaults to filtered (0 or NULL) on a new source", () => {
    const src = getResearchSources(db).find((s) => s.id === sourceId);
    expect(src).toBeDefined();
    expect(src!.allow_off_topic === 1).toBe(false);
  });

  it("persists allow_off_topic via updateSource and surfaces it in getResearchSources", () => {
    updateSource(db, sourceId, { allow_off_topic: 1 });
    let src = getResearchSources(db).find((s) => s.id === sourceId);
    expect(src!.allow_off_topic).toBe(1);

    updateSource(db, sourceId, { allow_off_topic: 0 });
    src = getResearchSources(db).find((s) => s.id === sourceId);
    expect(src!.allow_off_topic).toBe(0);
  });
});
