import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertNarrative } from "@/lib/queries/analysis-narratives";
import {
  generateNarrative,
  NARRATIVE_SURFACES,
} from "@/lib/compute/analysis-narratives";

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
});
