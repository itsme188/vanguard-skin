/**
 * Narrative input size and provenance (Analysis AI plumbing, 2026-11-15).
 *
 * - The factor-heatmap narrative sends per-factor bucket aggregates (weight,
 *   position count, the largest names, coverage), not the per-position factor
 *   matrix, and never a dollar market value.
 * - Every narrative context is compact JSON (no pretty-print indentation).
 * - The fingerprint still moves when a holding's factor bucket changes or a
 *   name enters the book, and stays put for sub-rounding price noise.
 * - `modelUsed` records the model that answered, not the one first resolved.
 *
 * Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import {
  buildFactorHeatmapContext,
  buildFactorHeatmapFingerprintInputs,
  fingerprintNarrativeInputs,
  generateNarrative,
  computeNarrativeFingerprint,
  HEATMAP_TOP_NAMES_PER_BUCKET,
} from "@/lib/compute/analysis-narratives";
import type { FactorHeatmapRow } from "@/lib/queries/analysis";
import { FACTOR_COLUMNS } from "@/lib/factors";
import { generateTextForFeature } from "@/lib/ai/generate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-resolved-first" })),
}));

function row(symbol: string, weight: number, factors: Partial<FactorHeatmapRow> = {}): FactorHeatmapRow {
  const base: Record<string, unknown> = {
    symbol,
    name: `${symbol} Corp`,
    security_type: "Stock",
    market_value: weight * 1000,
    weight_pct: weight,
    is_option: false,
    factor_source: "auto",
    style: null,
  };
  for (const c of FACTOR_COLUMNS) base[c] = null;
  return { ...base, ...factors } as unknown as FactorHeatmapRow;
}

const ROWS: FactorHeatmapRow[] = [
  row("ZZA", 40, { ai_exposure: "High", crypto_adjacent: "No", growth_vs_value: "Growth" }),
  row("ZZB", 30, { ai_exposure: "High", crypto_adjacent: "No", growth_vs_value: "Value" }),
  row("ZZC", 20, { ai_exposure: "Low", crypto_adjacent: "No", growth_vs_value: "Growth", style: "Blend" }),
  row("ZZD", 10), // no factors at all
];

describe("buildFactorHeatmapContext", () => {
  it("aggregates weight and positions per bucket, with the top names and coverage", () => {
    const ctx = buildFactorHeatmapContext(ROWS);
    expect(ctx.coverage).toEqual({ positions: 4, classified: 3, classifiedWeightPct: 90 });
    const ai = ctx.factors.find((f) => f.factor === "ai_exposure")!;
    expect(ai.buckets[0]).toEqual({
      bucket: "High",
      weightPct: 70,
      positions: 2,
      topNames: [
        { symbol: "ZZA", weightPct: 40 },
        { symbol: "ZZB", weightPct: 30 },
      ],
    });
    expect(ai.buckets[1].bucket).toBe("Low");
    expect(ai.unclassified).toEqual({ weightPct: 10, positions: 1 });
  });

  it("reads a Blend-style security as Blend on Growth vs Value, as the heatmap shows it", () => {
    const gv = buildFactorHeatmapContext(ROWS).factors.find((f) => f.factor === "growth_vs_value")!;
    expect(gv.buckets.map((b) => b.bucket).sort()).toEqual(["Blend", "Growth", "Value"]);
  });

  it("keeps at most HEATMAP_TOP_NAMES_PER_BUCKET names per bucket, largest first by size", () => {
    const many = Array.from({ length: 8 }, (_, i) => row(`ZQ${i}`, 10 + i, { ai_exposure: "High" }));
    const high = buildFactorHeatmapContext(many).factors.find((f) => f.factor === "ai_exposure")!.buckets[0];
    expect(high.positions).toBe(8);
    expect(high.topNames).toHaveLength(HEATMAP_TOP_NAMES_PER_BUCKET);
    expect(high.topNames[0].symbol).toBe("ZQ7");
  });

  it("carries no dollar market value and is far smaller than the per-position matrix", () => {
    const big = Array.from({ length: 80 }, (_, i) =>
      row(`ZR${i}`, 1.25, Object.fromEntries(FACTOR_COLUMNS.map((c) => [c, i % 2 ? "High" : "Low"]))),
    );
    const ctx = JSON.stringify(buildFactorHeatmapContext(big));
    expect(ctx).not.toContain("market_value");
    expect(ctx.length).toBeLessThan(JSON.stringify(big).length / 4);
    // Bounded by factors x buckets x top names, not by the number of positions.
    expect(ctx.length).toBeLessThan(6000);
  });
});

describe("factor-heatmap fingerprint", () => {
  const fp = (rows: FactorHeatmapRow[]) =>
    fingerprintNarrativeInputs("factor-heatmap", buildFactorHeatmapFingerprintInputs(rows));

  it("changes when a holding moves to another factor bucket", () => {
    const moved = ROWS.map((r) => (r.symbol === "ZZB" ? { ...r, ai_exposure: "Low" } : r));
    expect(fp(moved)).not.toBe(fp(ROWS));
  });

  it("changes when a new name enters the book, even a small one", () => {
    expect(fp([...ROWS, row("ZZE", 0.1, { ai_exposure: "Low" })])).not.toBe(fp(ROWS));
  });

  it("does not change for price noise that leaves every rounded weight in place", () => {
    const noisy = ROWS.map((r) => ({ ...r, market_value: r.market_value * 1.001, weight_pct: r.weight_pct + 0.01 }));
    expect(fp(noisy)).toBe(fp(ROWS));
  });

  it("changes when a bucket's weight moves a full rounding step", () => {
    const shifted = ROWS.map((r) => (r.symbol === "ZZA" ? { ...r, weight_pct: 45 } : r));
    expect(fp(shifted)).not.toBe(fp(ROWS));
  });
});

describe("narrative prompt and provenance (via generateNarrative)", () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.mocked(generateTextForFeature).mockReset();
    db = new Database(":memory:");
    runMigrations(db);
    db.exec("DELETE FROM accounts");
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test Account')");
    db.exec("INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (1, 'ZZA', 'Zed A', 'Stock', 'USD'), (2, 'ZZB', 'Zed B', 'Stock', 'USD')");
    db.exec("INSERT INTO security_factors (security_id, ai_exposure, crypto_adjacent) VALUES (1, 'High', 'No'), (2, 'Low', 'No')");
    const today = todayET();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100), (1, 2, ?, 100)").run(today, today);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 100, 'test'), (2, ?, 50, 'test')").run(today, today);
  });

  const PROSE = "The book leans hard on artificial intelligence names with almost no crypto exposure.";

  it("sends compact JSON aggregates for the heatmap, with no market value", async () => {
    let prompt = "";
    vi.mocked(generateTextForFeature).mockImplementationOnce(async (_f, args) => {
      prompt = String(args.prompt);
      return { text: PROSE, finishReason: "stop" } as never;
    });
    await generateNarrative(db, { scope: "all", surfaceKey: "factor-heatmap", weekOf: "2026-11-16", forceRegen: true });
    const json = prompt.slice(prompt.indexOf("Data (JSON):\n") + "Data (JSON):\n".length);
    expect(json).not.toContain("\n");
    expect(json).not.toContain("market_value");
    const ctx = JSON.parse(json);
    expect(ctx.coverage.positions).toBe(2);
    expect(ctx.factors.find((f: { factor: string }) => f.factor === "ai_exposure").buckets[0].topNames[0].symbol).toBe("ZZA");
  });

  it("sends compact JSON for the other surfaces too", async () => {
    let prompt = "";
    vi.mocked(generateTextForFeature).mockImplementationOnce(async (_f, args) => {
      prompt = String(args.prompt);
      return { text: PROSE, finishReason: "stop" } as never;
    });
    await generateNarrative(db, { scope: "all", surfaceKey: "factor-analysis", weekOf: "2026-11-16", forceRegen: true });
    const json = prompt.slice(prompt.indexOf("Data (JSON):\n") + "Data (JSON):\n".length);
    expect(json.startsWith("{")).toBe(true);
    expect(json).not.toContain("\n  ");
  });

  it("the stored fingerprint equals the read-side fingerprint for the heatmap", async () => {
    vi.mocked(generateTextForFeature).mockResolvedValueOnce({ text: PROSE, finishReason: "stop" } as never);
    const r = await generateNarrative(db, { scope: "all", surfaceKey: "factor-heatmap", weekOf: "2026-11-16", forceRegen: true });
    expect(r.inputFingerprint).toBe(computeNarrativeFingerprint(db, "all", "factor-heatmap"));
  });

  it("records the model that answered (a failover run), not the one first resolved", async () => {
    const res = { text: PROSE, finishReason: "stop" };
    Object.defineProperty(res, "answeredModelId", { value: "claude-answered-after-failover", enumerable: false });
    vi.mocked(generateTextForFeature).mockResolvedValueOnce(res as never);
    await generateNarrative(db, { scope: "all", surfaceKey: "factor-heatmap", weekOf: "2026-11-16", forceRegen: true });
    const stored = db.prepare("SELECT model_used FROM analysis_narratives").get() as { model_used: string };
    expect(stored.model_used).toBe("claude-answered-after-failover");
  });

  it("falls back to the resolved model when the helper reports none", async () => {
    vi.mocked(generateTextForFeature).mockResolvedValueOnce({ text: PROSE, finishReason: "stop" } as never);
    await generateNarrative(db, { scope: "all", surfaceKey: "factor-heatmap", weekOf: "2026-11-16", forceRegen: true });
    const stored = db.prepare("SELECT model_used FROM analysis_narratives").get() as { model_used: string };
    expect(stored.model_used).toBe("claude-resolved-first");
  });
});
