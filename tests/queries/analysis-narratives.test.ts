import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCachedNarrative,
  upsertNarrative,
} from "@/lib/queries/analysis-narratives";

describe("analysis-narratives cache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("returns null for cache miss", () => {
    expect(
      getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04")
    ).toBeNull();
  });

  it("upsert + read returns the same row", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Tech tilt is doing the lifting.",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04");
    expect(r?.narrativeMd).toBe("Tech tilt is doing the lifting.");
    expect(r?.scope).toBe("vanguard");
    expect(r?.surfaceKey).toBe("factor-analysis");
    expect(r?.weekOf).toBe("2026-05-04");
    expect(r?.modelUsed).toBe("anthropic/claude-sonnet-4-6");
    expect(r?.generatedAt).toBeTruthy();
  });

  it("upsert is idempotent — second write replaces first, no duplicate row", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "v1",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "v2",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04");
    expect(r?.narrativeMd).toBe("v2");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM analysis_narratives")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("different (scope, surface, week) tuples can coexist", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "a",
      modelUsed: "m",
    });
    upsertNarrative(db, {
      scope: "ibkr",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "b",
      modelUsed: "m",
    });
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "risk-metrics",
      weekOf: "2026-05-04",
      narrativeMd: "c",
      modelUsed: "m",
    });
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-04-27",
      narrativeMd: "d",
      modelUsed: "m",
    });
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM analysis_narratives")
      .get() as { n: number };
    expect(count.n).toBe(4);
  });
});
