import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// QA analysis-factor-narrative--asserts-market-beta-near-1-beside-beta-tile-0-43
// The factor narrative was regressed against SPY for every scope while the
// tiles under it open on the scope's default benchmark. It now uses that same
// default, names it in the prompt payload, and so carries it in the
// fingerprint.
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));
vi.mock("@/lib/queries/accounts", () => ({
  resolveScope: vi.fn(() => undefined),
}));
const FIXED_RESULT = {
  marketRegression: null,
  sizeTilt: null,
  styleTilt: null,
  sectorTilt: null,
  geographyTilt: null,
  tilts: [],
};
vi.mock("@/lib/compute/factors", () => ({
  computeFactorAnalysis: vi.fn(() => FIXED_RESULT),
}));

import {
  computeNarrativeFingerprint,
  fingerprintNarrativeInputs,
  generateNarrative,
  narrativeBenchmarkForScope,
} from "@/lib/compute/analysis-narratives";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { generateTextForFeature } from "@/lib/ai/generate";
import { getDefaultBenchmark } from "@/lib/analysis/benchmarks";

describe("factor narrative benchmark", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    vi.mocked(computeFactorAnalysis).mockClear();
    vi.mocked(generateTextForFeature).mockReset();
  });

  it("uses the card's per-scope default benchmark", () => {
    for (const scope of ["all", "vanguard", "ibkr", "roth"]) {
      expect(narrativeBenchmarkForScope(scope)).toBe(getDefaultBenchmark(scope));
    }
  });

  it("regresses against that benchmark, not a fixed SPY", () => {
    computeNarrativeFingerprint(db, "vanguard", "factor-analysis");
    expect(vi.mocked(computeFactorAnalysis)).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({ benchmarkSymbol: "VTI" }),
    );
    computeNarrativeFingerprint(db, "ibkr", "factor-analysis");
    expect(vi.mocked(computeFactorAnalysis)).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({ benchmarkSymbol: "QQQ" }),
    );
  });

  it("the benchmark is part of the fingerprint", () => {
    // Identical factor result, different benchmark: the fingerprints differ.
    const vti = computeNarrativeFingerprint(db, "vanguard", "factor-analysis");
    const qqq = computeNarrativeFingerprint(db, "ibkr", "factor-analysis");
    expect(vti).not.toBe(qqq);
    expect(vti).toBe(
      fingerprintNarrativeInputs("factor-analysis", { benchmark: "VTI", ...FIXED_RESULT }),
    );
    // A row fingerprinted before the benchmark joined the inputs reads as drifted.
    expect(vti).not.toBe(fingerprintNarrativeInputs("factor-analysis", FIXED_RESULT));
  });

  it("the prompt carries the benchmark and tells the model to name it", async () => {
    vi.mocked(generateTextForFeature).mockResolvedValue({
      text: "A placeholder narrative that is comfortably longer than forty characters.",
    } as Awaited<ReturnType<typeof generateTextForFeature>>);
    await generateNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      forceRegen: true,
    });
    const call = vi.mocked(generateTextForFeature).mock.calls[0][1] as { prompt: string };
    expect(call.prompt).toContain('"benchmark": "VTI"');
    expect(call.prompt).toContain("name that benchmark");
  });
});
