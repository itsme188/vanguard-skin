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
  distancePct: -0.05,
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
});
