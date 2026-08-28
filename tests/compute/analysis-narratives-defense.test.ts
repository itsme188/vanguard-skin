import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Mock generateTextForFeature so tests don't burn real Sonnet calls when
// ANTHROPIC_API_KEY is loaded into the env (e.g. via .env.local). Mirrors the
// mock shape in tests/compute/analysis-narratives.test.ts exactly — the file
// under test imports `generateTextForFeature` + `AIRefusalError` from
// "@/lib/ai/generate" and `resolveFeatureModel` from "@/lib/ai/models".
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn().mockResolvedValue({
    text: "Your book is roughly 18% protected, mostly through same-name puts on the largest tech longs.",
  }),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(feature: string, modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6-20250219" })),
}));

import {
  NARRATIVE_SURFACES,
  generateNarrative,
  computeNarrativeFingerprint,
} from "@/lib/compute/analysis-narratives";
import {
  getCachedNarrative,
  isNarrativeDrifted,
} from "@/lib/queries/analysis-narratives";

describe("defense narrative surface", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("is a registered surface", () => {
    expect(NARRATIVE_SURFACES).toContain("defense");
  });

  it("generates and caches a defense narrative", async () => {
    const r = await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29" });
    expect(r.narrativeMd).toContain("protected");
    const again = await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29" });
    expect(again.fromCache).toBe(true);
  });

  it("stores the input fingerprint alongside the prose, and it matches the current inputs", async () => {
    await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29" });
    const row = getCachedNarrative(db, "all", "defense", "2026-06-29");
    expect(row?.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const current = computeNarrativeFingerprint(db, "all", "defense");
    expect(row?.inputFingerprint).toBe(current);
    expect(isNarrativeDrifted(row, current)).toBe(false);
  });

  it("a legacy row written without a fingerprint reads as drifted against current inputs", () => {
    db.prepare(
      `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used)
       VALUES ('all','defense','2026-06-29','Legacy 30% claim.', datetime('now'), 'm')`,
    ).run();
    const row = getCachedNarrative(db, "all", "defense", "2026-06-29");
    expect(isNarrativeDrifted(row, computeNarrativeFingerprint(db, "all", "defense"))).toBe(true);
  });

  it("computeNarrativeFingerprint is deterministic for unchanged inputs and covers every surface", () => {
    for (const surface of NARRATIVE_SURFACES) {
      const a = computeNarrativeFingerprint(db, "all", surface);
      const b = computeNarrativeFingerprint(db, "all", surface);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(a).toBe(b);
    }
  });
});
