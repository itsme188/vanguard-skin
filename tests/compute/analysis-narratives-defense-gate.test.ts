import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn().mockResolvedValue({ text: "Narrative prose that is comfortably longer than forty characters." }),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6-20250219" })),
}));
vi.mock("@/lib/compute/hedging", () => ({ computeDefenseAnalysis: vi.fn() }));

import { generateNarrative, computeNarrativeFingerprint, fingerprintNarrativeInputs } from "@/lib/compute/analysis-narratives";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

function analysis(summaryOverrides: Record<string, number>) {
  return {
    summary: {
      hedgeCount: 0,
      shortExposure: 0,
      optionPositionCount: 0,
      shortPositionCount: 0,
      protectionRatio: 0,
      ...summaryOverrides,
    },
    standaloneBets: [],
    sectorCoverage: [],
    rankedExposures: [],
    hedgeScores: [],
    diagnostics: [],
  } as never;
}

describe("defense narrative empty gate mirrors DefenseView", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    vi.mocked(generateTextForFeature).mockClear();
  });

  it("a written put (option position, no hedge/short exposure) is NOT empty", async () => {
    vi.mocked(computeDefenseAnalysis).mockReturnValue(
      analysis({ optionPositionCount: 1, shortPositionCount: 1 }),
    );
    await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29", forceRegen: true });
    const args = vi.mocked(generateTextForFeature).mock.calls[0][1] as { prompt: unknown };
    const prompt = String(args.prompt);
    expect(prompt).toContain("optionPositionCount");
    expect(prompt).not.toContain("no data available");
    expect(computeNarrativeFingerprint(db, "all", "defense")).not.toBe(
      fingerprintNarrativeInputs("defense", { empty: "defense" }),
    );
  });

  it("a truly empty book still returns the empty context with the stable fingerprint", async () => {
    vi.mocked(computeDefenseAnalysis).mockReturnValue(analysis({}));
    await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29", forceRegen: true });
    const args = vi.mocked(generateTextForFeature).mock.calls[0][1] as { prompt: unknown };
    expect(String(args.prompt)).toContain("no data available");
    expect(computeNarrativeFingerprint(db, "all", "defense")).toBe(
      fingerprintNarrativeInputs("defense", { empty: "defense" }),
    );
  });
});
