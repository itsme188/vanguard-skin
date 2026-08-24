import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getOrGenerateNarrative } from "@/lib/chart/narrate-levels";
import type { SuggestedLevel } from "@/lib/chart/suggested-levels";
import type { OhlcBar } from "@/lib/chart/indicators";

// Mock the AI layer so tests don't hit the real API.
vi.mock("ai", () => ({
  jsonSchema: (s: unknown) => s,
}));

vi.mock("@/lib/ai/generate", () => ({
  generateObjectForFeature: vi.fn(async () => ({ object: { narrative: "mocked sentence." } })),
}));

const SAMPLE_LEVEL: SuggestedLevel = {
  price: 150,
  type: "support",
  touches: 4,
  lastTouchDate: "2026-04-10",
  firstTouchDate: "2025-12-05",
  confidence: "high",
  // distancePct is a PERCENT, not a fraction — suggested-levels.ts computes
  // (distance / currentPrice) * 100. With price 150 vs the currentPrice 175
  // these tests pass, the real figure is (150 - 175) / 175 * 100 = -14.3.
  distancePct: -14.3,
};

const SAMPLE_BARS: OhlcBar[] = Array.from({ length: 20 }, (_, i) => ({
  date: `2026-04-${String(i + 1).padStart(2, "0")}`,
  open: 150 + i,
  high: 152 + i,
  low: 148 + i,
  close: 151 + i,
}));

describe("getOrGenerateNarrative", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type) VALUES (1, 'AAPL', 'stock')`,
    ).run();
    vi.clearAllMocks();
  });

  it("generates a new narrative on cache miss and persists it", async () => {
    const result = await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: SAMPLE_LEVEL,
      recentBars: SAMPLE_BARS,
    });

    expect(result).toBe("mocked sentence.");
    const row = db
      .prepare(
        `SELECT narrative FROM suggested_level_narratives
         WHERE security_id = ? AND level_price = ? AND direction = ?`,
      )
      .get(1, 150, "support") as { narrative: string };
    expect(row.narrative).toBe("mocked sentence.");
  });

  it("returns cached narrative on second call same day (no second AI invocation)", async () => {
    const { generateObjectForFeature } = await import("@/lib/ai/generate");

    await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: SAMPLE_LEVEL,
      recentBars: SAMPLE_BARS,
    });
    await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: SAMPLE_LEVEL,
      recentBars: SAMPLE_BARS,
    });

    expect(generateObjectForFeature).toHaveBeenCalledTimes(1);
  });

  it("caches independently per direction (support vs resistance at same price)", async () => {
    const { generateObjectForFeature } = await import("@/lib/ai/generate");

    await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: SAMPLE_LEVEL,
      recentBars: SAMPLE_BARS,
    });
    await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: { ...SAMPLE_LEVEL, type: "resistance" },
      recentBars: SAMPLE_BARS,
    });

    expect(generateObjectForFeature).toHaveBeenCalledTimes(2);
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM suggested_level_narratives`)
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it("returns null and does not throw when the AI call fails", async () => {
    const { generateObjectForFeature } = await import("@/lib/ai/generate");
    (generateObjectForFeature as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("upstream 500"),
    );

    const result = await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: SAMPLE_LEVEL,
      recentBars: SAMPLE_BARS,
    });

    expect(result).toBeNull();
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM suggested_level_narratives`)
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("returns null on empty narrative", async () => {
    const { generateObjectForFeature } = await import("@/lib/ai/generate");
    (generateObjectForFeature as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      { object: { narrative: "   " } },
    );

    const result = await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAPL",
      currentPrice: 175,
      level: SAMPLE_LEVEL,
      recentBars: SAMPLE_BARS,
    });
    expect(result).toBeNull();
  });

  // QA regression security-detail-suggested-levels--narrative-magnitude-
  // contradiction-regression-6: the model wrote "1619% above" for a level
  // whose true distance is +19.3%. The formula (chart, chip) was fine — the
  // prose was model noise. Gate it at storage so a bad sentence never
  // reaches suggested_level_narratives (or a later ACCEPT'd thesis).
  it("replaces an implausible model narrative with a computed fallback before storing", async () => {
    const { generateObjectForFeature } = await import("@/lib/ai/generate");
    (generateObjectForFeature as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      object: {
        narrative:
          "Single touch on 2024-09-11 offers minimal support confirmation; price currently 1619% above this historical level.",
      },
    });

    const level = { ...SAMPLE_LEVEL, price: 495.6, lastTouchDate: "2024-09-11", touches: 1 };
    const result = await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "META",
      currentPrice: 591.33,
      level,
      recentBars: SAMPLE_BARS,
    });

    expect(result).not.toBeNull();
    expect(result).not.toContain("1619");
    expect(result).toMatch(/19\.3%/);

    const row = db
      .prepare(
        `SELECT narrative FROM suggested_level_narratives
         WHERE security_id = ? AND level_price = ? AND direction = ?`,
      )
      .get(1, 495.6, "support") as { narrative: string };
    expect(row.narrative).not.toContain("1619");
    expect(row.narrative).toBe(result);
  });

  it("stores a plausible model narrative verbatim (no false-positive gating)", async () => {
    const { generateObjectForFeature } = await import("@/lib/ai/generate");
    const goodNarrative =
      "Single touch on 2024-09-11 offers minimal support confirmation; price currently 19.3% above this historical level.";
    (generateObjectForFeature as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      object: { narrative: goodNarrative },
    });

    const level = { ...SAMPLE_LEVEL, price: 495.6, lastTouchDate: "2024-09-11", touches: 1 };
    const result = await getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "META",
      currentPrice: 591.33,
      level,
      recentBars: SAMPLE_BARS,
    });

    expect(result).toBe(goodNarrative);
  });

  // QA finding security-detail-levels--suggestion-narrative-contradicts-chip-
  // accept-persists-regression-1 (root cause a): buildPrompt multiplied
  // level.distancePct by 100, but lib/chart/suggested-levels.ts already
  // returns it as a PERCENT ((distance / currentPrice) * 100) and
  // LevelsPanel renders it raw with a '%'. The prompt therefore told the
  // model "Distance from current: -2218.4%" for a level 22.2% away, and the
  // model back-solved a hallucinated current price into its sentence.
  describe("prompt distance (double-scaling regression)", () => {
    function lastPrompt(fn: unknown): string {
      const { mock } = fn as { mock: { calls: [string, { prompt: string }][] } };
      return mock.calls[mock.calls.length - 1][1].prompt;
    }

    it("states distancePct as the percent it already is — never re-scaled by 100", async () => {
      const { generateObjectForFeature } = await import("@/lib/ai/generate");
      // Live repro shape: current 278.91, support 217.05.
      // distancePct = (217.05 - 278.91) / 278.91 * 100 = -22.2 (a PERCENT).
      const level = { ...SAMPLE_LEVEL, price: 217.05, distancePct: -22.2 };

      await getOrGenerateNarrative(db, {
        securityId: 1,
        symbol: "CRWD",
        currentPrice: 278.91,
        level,
        recentBars: SAMPLE_BARS,
      });

      const prompt = lastPrompt(generateObjectForFeature);
      expect(prompt).toContain("Distance from current: -22.2%");
      expect(prompt).not.toContain("-2220");
      // No distance line may ever carry a 3+ digit magnitude for a level
      // this close — that is the double-scaling signature.
      expect(prompt).not.toMatch(/Distance from current: -?\d{3,}/);
    });

    it("keeps a resistance level's positive distance unscaled too", async () => {
      const { generateObjectForFeature } = await import("@/lib/ai/generate");
      const level = {
        ...SAMPLE_LEVEL,
        type: "resistance" as const,
        price: 320.5,
        distancePct: 14.9,
      };

      await getOrGenerateNarrative(db, {
        securityId: 1,
        symbol: "CRWD",
        currentPrice: 278.91,
        level,
        recentBars: SAMPLE_BARS,
      });

      expect(lastPrompt(generateObjectForFeature)).toContain("Distance from current: 14.9%");
    });
  });
});
