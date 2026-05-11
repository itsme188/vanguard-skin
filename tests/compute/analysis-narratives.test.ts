import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertNarrative } from "@/lib/queries/analysis-narratives";
import {
  generateNarrative,
  NARRATIVE_SURFACES,
} from "@/lib/compute/analysis-narratives";

// Mock the `ai` package's generateText so tests don't burn real Sonnet calls
// when ANTHROPIC_API_KEY is loaded into the env (e.g. via .env.local). Without
// this mock the "forceRegen bypasses cache" test would race the 5s vitest
// timeout against a real network round-trip.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn().mockRejectedValue(
      new Error("generateText mocked off in tests")
    ),
  };
});

describe("generateNarrative", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("returns cached narrative when present (no AI call)", async () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Cached prose.",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = await generateNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
    });
    expect(r.narrativeMd).toBe("Cached prose.");
    expect(r.fromCache).toBe(true);
  });

  it("rejects unknown surfaceKey at the boundary", async () => {
    await expect(
      generateNarrative(db, {
        scope: "vanguard",
        surfaceKey: "bogus",
        weekOf: "2026-05-04",
      })
    ).rejects.toThrow(/unknown surface/i);
  });

  it("exports the 4 expected surface keys", () => {
    expect(NARRATIVE_SURFACES).toEqual([
      "factor-analysis",
      "risk-metrics",
      "position-risk",
      "factor-heatmap",
    ]);
  });

  it("forceRegen=true should bypass cache (re-throws since AI not mocked)", async () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Cached prose.",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    // forceRegen skips the cache → tries to call Sonnet → no API key in test env
    // → throws. We just want to confirm the cache was bypassed (i.e. the call
    // did NOT short-circuit at the cache hit).
    await expect(
      generateNarrative(db, {
        scope: "vanguard",
        surfaceKey: "factor-analysis",
        weekOf: "2026-05-04",
        forceRegen: true,
      })
    ).rejects.toThrow(); // any error type — point is, it didn't return cached
  });
});
