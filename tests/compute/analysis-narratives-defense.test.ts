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

import { NARRATIVE_SURFACES, generateNarrative } from "@/lib/compute/analysis-narratives";

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
});
