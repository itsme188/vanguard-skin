import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

// TODO (f7): the factor narrative route returns the benchmark the stored prose
// was written against, and the card prints it.
//
// `analysis_narratives` has no benchmark column. The benchmark is part of the
// factor prompt payload, so it is part of `input_fingerprint`: a stored
// fingerprint that equals today's is the proof that the prose was written
// against today's benchmark for that scope. When that proof is missing
// (drifted, legacy NULL, compute failed, empty book) the route names nothing.
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { runMigrations } = await import("@/lib/db/migrate");
  const db = new Database(":memory:");
  runMigrations(db);
  return { db };
});
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
vi.mock("@/lib/compute/risk", () => ({
  computeRiskMetrics: vi.fn(() => ({ sharpe: 1 })),
  computePositionRisk: vi.fn(() => null),
}));

import { db } from "@/lib/db";
import { GET, POST, __resetRateLimitForTests } from "@/app/api/analysis/narrative/route";
import {
  computeNarrativeFingerprint,
  fingerprintNarrativeInputs,
  provenNarrativeBenchmark,
} from "@/lib/compute/analysis-narratives";
import { upsertNarrative } from "@/lib/queries/analysis-narratives";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { generateTextForFeature } from "@/lib/ai/generate";
import { mondayOf } from "@/lib/calendar/date-utils";

const WEEK = mondayOf(new Date().toISOString().slice(0, 10));

function seed(scope: string, surfaceKey: string, inputFingerprint: string | null) {
  upsertNarrative(db, {
    scope,
    surfaceKey,
    weekOf: WEEK,
    narrativeMd: "Beta against the benchmark sits a little under one.",
    modelUsed: "test-model",
    inputFingerprint,
  });
}

function tableDump(): string {
  return JSON.stringify(db.prepare(`SELECT * FROM analysis_narratives ORDER BY id`).all());
}

async function get(scope: string, surface: string) {
  const res = await GET(
    new Request(`http://x/api/analysis/narrative?scope=${scope}&surface=${surface}`) as never,
  );
  return res.json();
}

describe("GET /api/analysis/narrative: the benchmark the stored prose was written against", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM analysis_narratives`).run();
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(computeFactorAnalysis).mockReset();
    vi.mocked(computeFactorAnalysis).mockReturnValue(FIXED_RESULT as never);
    __resetRateLimitForTests();
  });

  it("names the scope's benchmark for a cached factor row whose inputs still match", async () => {
    seed("vanguard", "factor-analysis", computeNarrativeFingerprint(db, "vanguard", "factor-analysis"));
    seed("ibkr", "factor-analysis", computeNarrativeFingerprint(db, "ibkr", "factor-analysis"));

    const vanguard = await get("vanguard", "factor-analysis");
    expect(vanguard.drifted).toBe(false);
    expect(vanguard.benchmark).toBe("VTI");
    expect((await get("ibkr", "factor-analysis")).benchmark).toBe("QQQ");
  });

  it("names nothing for a missing row", async () => {
    const body = await get("vanguard", "factor-analysis");
    expect(body.notGenerated).toBe(true);
    expect(body.benchmark).toBeNull();
  });

  it("names nothing when the stored inputs cannot be shown to match (drifted or legacy NULL)", async () => {
    // A row written before the benchmark joined the payload (the prose was
    // regressed against SPY for every scope then) has another fingerprint.
    seed("vanguard", "factor-analysis", fingerprintNarrativeInputs("factor-analysis", FIXED_RESULT));
    const drifted = await get("vanguard", "factor-analysis");
    expect(drifted.drifted).toBe(true);
    expect(drifted.benchmark).toBeNull();

    seed("ibkr", "factor-analysis", null);
    const legacy = await get("ibkr", "factor-analysis");
    expect(legacy.drifted).toBe(true);
    expect(legacy.benchmark).toBeNull();
  });

  it("names nothing when the prose was written over an empty book (no regression was run)", async () => {
    vi.mocked(computeFactorAnalysis).mockReturnValue(null as never);
    seed("vanguard", "factor-analysis", computeNarrativeFingerprint(db, "vanguard", "factor-analysis"));
    const body = await get("vanguard", "factor-analysis");
    expect(body.drifted).toBe(false);
    expect(body.benchmark).toBeNull();
  });

  it("names nothing for a surface that has no benchmark", async () => {
    seed("vanguard", "risk-metrics", computeNarrativeFingerprint(db, "vanguard", "risk-metrics"));
    const body = await get("vanguard", "risk-metrics");
    expect(body.drifted).toBe(false);
    expect(body.benchmark).toBeNull();
  });

  it("GET writes nothing and makes no AI call, on a hit and on a miss", async () => {
    seed("vanguard", "factor-analysis", computeNarrativeFingerprint(db, "vanguard", "factor-analysis"));
    const before = tableDump();
    const changesBefore = (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;

    await get("vanguard", "factor-analysis"); // hit
    await get("roth", "factor-analysis"); // miss

    expect(tableDump()).toBe(before);
    expect((db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n).toBe(changesBefore);
    expect(generateTextForFeature).not.toHaveBeenCalled();
  });

  it("POST returns the benchmark of the prose it just wrote", async () => {
    vi.mocked(generateTextForFeature).mockResolvedValue({
      text: "Beta versus the total-market fund is modest and the tilts lean toward growth names.",
    } as never);
    const res = await POST(
      new Request("http://x/api/analysis/narrative", {
        method: "POST",
        body: JSON.stringify({ scope: "vanguard", surface: "factor-analysis" }),
        headers: { "Content-Type": "application/json" },
      }) as never,
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.benchmark).toBe("VTI");
  });
});

describe("provenNarrativeBenchmark", () => {
  it("needs both fingerprints, equal, on the factor surface", () => {
    expect(provenNarrativeBenchmark("vanguard", "factor-analysis", "a", "a")).toBe("VTI");
    expect(provenNarrativeBenchmark("vanguard", "factor-analysis", "a", "b")).toBeNull();
    expect(provenNarrativeBenchmark("vanguard", "factor-analysis", null, "a")).toBeNull();
    expect(provenNarrativeBenchmark("vanguard", "factor-analysis", "a", null)).toBeNull();
    expect(provenNarrativeBenchmark("vanguard", "defense", "a", "a")).toBeNull();
  });
});

describe("NarrativeBlock prints the benchmark the route returned", () => {
  const src = readFileSync("app/dashboard/components/analysis/NarrativeBlock.tsx", "utf8");

  it("reads it from both the cache read and the regenerate response", () => {
    const load = anchorIndex(src, "fetch(`/api/analysis/narrative?scope=");
    const loadBlock = src.slice(load, anchorIndex(src, ".finally(", load));
    expect(loadBlock).toContain("setBenchmark(readBenchmark(data))");

    const post = anchorIndex(src, 'method: "POST"');
    const postBlock = src.slice(post, anchorIndex(src, "} catch {", post));
    expect(postBlock).toContain("setBenchmark(readBenchmark(data))");
  });

  it("clears it when the scope changes, before the new read lands", () => {
    const effect = anchorIndex(src, "setNotGenerated(false);");
    const fetchAt = anchorIndex(src, "fetch(`/api/analysis/narrative?scope=");
    const reset = anchorIndex(src, "setBenchmark(null);");
    expect(reset).toBeLessThan(fetchAt);
    expect(effect).toBeLessThan(fetchAt);
  });

  it("the caption says what the prose was written against, and only when known", () => {
    const at = anchorIndex(src, "Written against {benchmark}");
    expect(src.slice(at - 200, at)).toContain("{benchmark && (");
  });
});
