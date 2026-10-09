import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));
vi.mock("@/lib/compute/factors", () => ({ computeFactorAnalysis: vi.fn() }));

import { dropCashEquivalentContributors, generateMacroThemes } from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeFactorAnalysis } from "@/lib/compute/factors";

const WEEK = "2026-05-04";

// QA finding analysis-macro-themes--identical-top-exposure-across-themes-money-market-leads-regression-1
// (recommended option 1: cash equivalents leave every theme's top list).
function seedDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO research_articles
         (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (?, 1, ?, 't@test.com', 'Synthetic body text about markets this week.', datetime('${WEEK}', '-${i} days'), datetime('now'), 'neutral', '[]')`,
    ).run(i + 1, `Article ${i}`);
  }
  const sec = db.prepare("INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)");
  // The live shape: a sweep fund typed 'Mutual Fund', identified by its category.
  sec.run("SWEEP", "Sweep Fund", "Mutual Fund", "Cash Equivalent");
  sec.run("MMKT", "Money Market Fund", "money_market", null);
  sec.run("AAA", "AAA Inc", "Stock", null);
  sec.run("BBB", "BBB Inc", "Stock", null);
  sec.run("CCC", "CCC Bond Fund", "Mutual Fund", "Short-Term Bond");
  sec.run("DDD", "DDD Inc", "Stock", null);
  return db;
}

describe("dropCashEquivalentContributors", () => {
  it("removes cash equivalents by the shared identity and keeps the order of the rest", () => {
    const db = seedDb();
    const out = dropCashEquivalentContributors(db, [
      { symbol: "SWEEP", weight: 30 },
      { symbol: "AAA", weight: 20 },
      { symbol: "MMKT", weight: 15 },
      { symbol: "CCC", weight: 10 },
    ]);
    // A short-term bond fund carries duration: it is a holding, not cash.
    expect(out).toEqual([{ symbol: "AAA", weight: 20 }, { symbol: "CCC", weight: 10 }]);
  });

  it("keeps a symbol with no securities row and handles an empty list", () => {
    const db = seedDb();
    expect(dropCashEquivalentContributors(db, [{ symbol: "ZZZ", weight: 5 }])).toEqual([{ symbol: "ZZZ", weight: 5 }]);
    expect(dropCashEquivalentContributors(db, [])).toEqual([]);
  });
});

describe("generateMacroThemes — top contributors", () => {
  // Every theme cites an input and quotes it: since 2026-10-08 a theme without a
  // verifiable citation is dropped before caching (tests/compute/macro-themes-citations.test.ts).
  const reply = JSON.stringify([
    { name: "Rate repricing", factor_label: "interest_rate_sensitive", direction: "risk-off", summary: "A hot jobs print revived the hike debate.", cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: "Synthetic body text about markets this week." },
    { name: "AI capex cycle", factor_label: "ai_exposure", direction: "risk-on", summary: "Capex guides kept climbing through the week.", cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: "Synthetic body text about markets this week." },
  ]);

  beforeEach(() => {
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(generateTextForFeature).mockResolvedValue({ text: reply } as never);
    vi.mocked(computeFactorAnalysis).mockReturnValue({
      tilts: [
        {
          factor: "interest_rate_sensitive", exposurePct: 40,
          topContributors: [
            { symbol: "SWEEP", weight: 18 }, { symbol: "AAA", weight: 9 }, { symbol: "BBB", weight: 6 },
            { symbol: "CCC", weight: 4 }, { symbol: "DDD", weight: 3 },
          ],
        },
        {
          factor: "ai_exposure", exposurePct: 25,
          topContributors: [
            { symbol: "SWEEP", weight: 5 }, { symbol: "MMKT", weight: 4 }, { symbol: "AAA", weight: 3 },
            { symbol: "MMKT", weight: 2 }, { symbol: "BBB", weight: 1 },
          ],
        },
      ],
    } as never);
  });

  it("the sweep fund no longer leads the rate theme; the next holding takes its slot", async () => {
    const { themes } = await generateMacroThemes(seedDb(), { scope: "all", weekOf: WEEK, forceRegen: true });
    expect(themes[0].top_contributors.map((c) => c.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("a list runs short rather than naming cash when the factor's five names are mostly cash", async () => {
    const { themes } = await generateMacroThemes(seedDb(), { scope: "all", weekOf: WEEK, forceRegen: true });
    expect(themes[1].top_contributors.map((c) => c.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("the exposure figure is untouched — only the names change", async () => {
    const { themes } = await generateMacroThemes(seedDb(), { scope: "all", weekOf: WEEK, forceRegen: true });
    expect(themes.map((t) => t.exposure_pct)).toEqual([40, 25]);
  });
});
