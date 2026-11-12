import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  getModelCatalog,
  setModelCatalog,
  isModelCatalogStale,
  pruneToCallable,
} from "@/lib/ai/model-catalog";
import { resolveTier } from "@/lib/ai/model-tiers";

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
    setModelCatalog(db, ["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(getModelCatalog(db)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(isModelCatalogStale(db)).toBe(false);
  });
  it("is stale when never set", () => {
    expect(isModelCatalogStale(db)).toBe(true);
  });
  it("is stale when older than the guard window", () => {
    setModelCatalog(db, ["claude-opus-5-5"]);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'model_catalog_updated_at'")
      .run(new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString());
    expect(isModelCatalogStale(db)).toBe(true);
  });
});

describe("pruneToCallable", () => {
  const listed = ["claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

  it("prunes a listed-but-uncallable model (opus 404s) so frontier falls to the next callable rung", async () => {
    const probed: string[] = [];
    const probe = async (id: string) => { probed.push(id); return id !== "claude-opus-5-5"; };
    const callable = await pruneToCallable(listed, probe);
    expect(callable).not.toContain("claude-opus-5-5");
    expect(callable).toContain("claude-sonnet-5-5");
    // probed the frontier selection (opus), then re-selected sonnet and probed it
    expect(probed).toContain("claude-opus-5-5");
    expect(probed).toContain("claude-sonnet-5-5");
    // Fable is listed but no ladder selects it, so it is never probed (2026-11-07).
    expect(probed).not.toContain("claude-fable-5");
  });

  it("keeps everything when all probes pass", async () => {
    const callable = await pruneToCallable(listed, async () => true);
    expect(callable).toEqual(listed);
  });

  it("does NOT prune on a transient (non-404) probe result — only confirmed-uncallable is dropped", async () => {
    // probe returns true for transient/unknown; here everything 'callable' → kept
    const callable = await pruneToCallable(["claude-opus-5-5", "claude-sonnet-5-5"], async () => true);
    expect(callable).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("a dead current Haiku is probed once, and the catalog then resolves cheap to a callable Haiku (review of 1d8d8517)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const full = [...listed, "claude-haiku-4-5-20251001"];
    const probed: string[] = [];
    const probe = async (id: string) => { probed.push(id); return id !== "claude-haiku-5-5"; };
    const callable = await pruneToCallable(full, probe);
    expect(probed.filter((id) => id === "claude-haiku-5-5")).toHaveLength(1);
    expect(callable).not.toContain("claude-haiku-5-5");
    expect(resolveTier("cheap", callable)).toBe("claude-haiku-4-5-20251001");
    warn.mockRestore();
  });

  it("every id dead: each probed at most once, no throw", async () => {
    const probed: string[] = [];
    const callable = await pruneToCallable(listed, async (id) => { probed.push(id); return false; });
    expect(new Set(probed).size).toBe(probed.length);
    expect(callable).toEqual(["claude-fable-5"]);
  });

  it("probes each tier's selection at most once and is bounded", async () => {
    let calls = 0;
    const probe = async (id: string) => { calls++; return id !== "claude-opus-5-5"; };
    await pruneToCallable(listed, probe);
    // frontier: opus(fail)->sonnet(ok); workhorse: sonnet(ok); cheap: haiku(ok) = 4 distinct probes max
    expect(calls).toBeLessThanOrEqual(4);
  });
});
