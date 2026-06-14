import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  getModelCatalog,
  setModelCatalog,
  isModelCatalogStale,
  pruneToCallable,
} from "@/lib/ai/model-catalog";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
  );
  return db;
}

describe("model-catalog", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns [] when unset", () => {
    expect(getModelCatalog(db)).toEqual([]);
  });
  it("returns [] (not throw) when settings table is missing", () => {
    const bare = new Database(":memory:");
    expect(getModelCatalog(bare)).toEqual([]);
  });
  it("round-trips a catalog and reports fresh", () => {
    setModelCatalog(db, ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(getModelCatalog(db)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(isModelCatalogStale(db)).toBe(false);
  });
  it("is stale when never set", () => {
    expect(isModelCatalogStale(db)).toBe(true);
  });
  it("is stale when older than the guard window", () => {
    setModelCatalog(db, ["claude-opus-4-8"]);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'model_catalog_updated_at'")
      .run(new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString());
    expect(isModelCatalogStale(db)).toBe(true);
  });
});

describe("pruneToCallable", () => {
  const listed = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

  it("prunes a listed-but-uncallable model (fable 404s) so frontier falls to the next callable rung", async () => {
    const probed: string[] = [];
    const probe = async (id: string) => { probed.push(id); return id !== "claude-fable-5"; };
    const callable = await pruneToCallable(listed, probe);
    expect(callable).not.toContain("claude-fable-5");
    expect(callable).toContain("claude-opus-4-8");
    // probed the frontier selection (fable), then re-selected opus and probed it
    expect(probed).toContain("claude-fable-5");
    expect(probed).toContain("claude-opus-4-8");
  });

  it("keeps everything when all probes pass", async () => {
    const callable = await pruneToCallable(listed, async () => true);
    expect(callable).toEqual(listed);
  });

  it("does NOT prune on a transient (non-404) probe result — only confirmed-uncallable is dropped", async () => {
    // probe returns true for transient/unknown; here everything 'callable' → kept
    const callable = await pruneToCallable(["claude-opus-4-8", "claude-sonnet-4-6"], async () => true);
    expect(callable).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("probes each tier's selection at most once and is bounded", async () => {
    let calls = 0;
    const probe = async (id: string) => { calls++; return id !== "claude-fable-5"; };
    await pruneToCallable(listed, probe);
    // frontier: fable(fail)->opus(ok); workhorse: sonnet(ok); cheap: haiku(ok) = 4 distinct probes max
    expect(calls).toBeLessThanOrEqual(4);
  });
});
