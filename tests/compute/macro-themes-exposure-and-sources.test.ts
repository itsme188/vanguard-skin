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

import {
  MacroThemeSchema,
  buildMacroSignalBlob,
  generateMacroThemes,
  rankThemeExposures,
} from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { renderMacroThemesMarkdown } from "@/lib/digest/macro-themes-markdown";

const WEEK = "2026-05-04";

// QA finding analysis-macro-themes--exposure-badge-always-very-high-regression-1
// (owner ruling: show the computed percentage plus a highest / lowest this-week
// marker; drop the absolute bucket word, which saturated at "very-high").
describe("rankThemeExposures", () => {
  it("marks the most and least exposed theme and nothing in between", () => {
    expect(rankThemeExposures([40, 62, 31, 55, 47])).toEqual([null, "highest", "lowest", null, null]);
  });

  it("marks every theme tied at an end (two themes on one factor share a figure)", () => {
    expect(rankThemeExposures([62, 62, 31, 40])).toEqual(["highest", "highest", "lowest", null]);
  });

  it("compares at the whole-percent precision the card prints", () => {
    // 30.4 and 29.6 both print as 30%, so neither may be called the highest.
    expect(rankThemeExposures([30.4, 29.6, 12])).toEqual(["highest", "highest", "lowest"]);
    expect(rankThemeExposures([30.4, 29.6])).toEqual([null, null]);
  });

  it("gives no marker when there is nothing to rank", () => {
    expect(rankThemeExposures([])).toEqual([]);
    expect(rankThemeExposures([44])).toEqual([null]);
    expect(rankThemeExposures([44, 44, 44])).toEqual([null, null, null]);
  });

  it("leaves an unknown exposure unranked and ranks the rest", () => {
    expect(rankThemeExposures([null, 20, undefined, 50, Number.NaN])).toEqual([null, "lowest", null, "highest", null]);
    expect(rankThemeExposures([null, 20])).toEqual([null, null]);
  });
});

describe("MacroThemeSchema back-compat", () => {
  const base = {
    name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
    summary: "Trade-deal headlines pushed risk down all week.",
    exposure_bucket: "very-high", top_contributors: [{ symbol: "AAA", weight: 4 }],
  };

  it("still parses a theme cached before the percentage and marker existed", () => {
    const parsed = MacroThemeSchema.parse(base);
    expect(parsed.exposure_pct).toBeUndefined();
    expect(parsed.exposure_rank).toBeUndefined();
  });

  it("parses the new fields, including a null marker", () => {
    expect(MacroThemeSchema.parse({ ...base, exposure_pct: 31.5, exposure_rank: "highest" }).exposure_rank).toBe("highest");
    expect(MacroThemeSchema.parse({ ...base, exposure_pct: 31.5, exposure_rank: null }).exposure_rank).toBeNull();
  });
});

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
  return db;
}

function insertEvent(
  db: Database.Database,
  e: { id: number; type: string; title: string; symbol: string | null; key: string; superseded?: number },
) {
  db.prepare(
    `INSERT INTO calendar_events
       (id, event_date, event_type, source, source_key, week_of, title, symbol, actual_value, enriched_at, superseded)
     VALUES (?, date('${WEEK}', '-2 days'), ?, 'test', ?, date('${WEEK}', '-2 days'), ?, ?, '1.00', datetime('${WEEK}', '-2 days'), ?)`,
  ).run(e.id, e.type, e.key, e.title, e.symbol, e.superseded ?? 0);
}

// QA finding analysis-macro-sources--superseded-earnings-twins-listed-and-fed-to-model
describe("buildMacroSignalBlob — calendar events", () => {
  it("drops a superseded earnings twin and keeps the canonical row", () => {
    const db = seedDb();
    insertEvent(db, { id: 10, type: "earnings", title: "AAA Earnings", symbol: "AAA", key: "manual:AAA" });
    insertEvent(db, { id: 11, type: "earnings", title: "AAA Earnings", symbol: "AAA", key: "feed:AAA", superseded: 1 });
    const blob = buildMacroSignalBlob(db, "all", WEEK);
    expect(blob.enrichedEvents.map((e) => e.id)).toEqual([10]);
    expect(blob.enrichedEventCount).toBe(1);
  });

  it("a superseded twin never takes a slot from a live row at the limit", () => {
    const db = seedDb();
    for (let i = 0; i < 30; i++) {
      insertEvent(db, { id: 100 + i, type: "earnings", title: `T${i} Earnings`, symbol: `T${i}`, key: `feed:T${i}`, superseded: 1 });
    }
    insertEvent(db, { id: 5, type: "earnings", title: "ZZZ Earnings", symbol: "ZZZ", key: "manual:ZZZ" });
    expect(buildMacroSignalBlob(db, "all", WEEK).enrichedEvents.map((e) => e.id)).toEqual([5]);
  });

  // QA finding analysis-macro-sources--generic-links-unlabeled-events-regression-3
  it("carries each event's own name, so a symbol-less macro release is not anonymous", () => {
    const db = seedDb();
    insertEvent(db, { id: 20, type: "macro", title: "CPI Release", symbol: null, key: "fred:cpi" });
    const [event] = buildMacroSignalBlob(db, "all", WEEK).enrichedEvents;
    expect(event.title).toBe("CPI Release");
    expect(event.symbol).toBeNull();
  });
});

describe("generateMacroThemes — exposure figure, marker and cited events", () => {
  // Every theme cites an input and quotes it: since 2026-10-08 a theme without a
  // verifiable citation is dropped before caching (tests/compute/macro-themes-citations.test.ts).
  const reply = JSON.stringify([
    { name: "AI capex cycle", factor_label: "ai_exposure", direction: "risk-on", summary: "Capex guides kept climbing through the week.", cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: "Synthetic body text about markets this week." },
    { name: "Rate repricing", factor_label: "interest_rate_sensitive", direction: "risk-off", summary: "A hot jobs print revived the hike debate.", cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: "Synthetic body text about markets this week." },
    { name: "Tariff headlines", factor_label: "tariff_exposure", direction: "risk-off", summary: "Trade headlines pushed cyclicals lower again.", cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: "Synthetic body text about markets this week." },
    { name: "Crypto bid", factor_label: "crypto_adjacent", direction: "risk-on", summary: "Crypto-linked names caught a late-week bid.", cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: "Synthetic body text about markets this week." },
  ]);

  beforeEach(() => {
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(generateTextForFeature).mockResolvedValue({ text: reply } as never);
    vi.mocked(computeFactorAnalysis).mockReturnValue({
      tilts: [
        { factor: "ai_exposure", exposurePct: 60, topContributors: [{ symbol: "AAA", weight: 20 }] },
        { factor: "interest_rate_sensitive", exposurePct: 45, topContributors: [] },
        { factor: "tariff_exposure", exposurePct: 30, topContributors: [] },
        // crypto_adjacent deliberately has no tilt row.
      ],
    } as never);
  });

  it("stores the percentage and the this-week marker, and keeps both on a cache read", async () => {
    const db = seedDb();
    const fresh = await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
    expect(fresh.themes.map((t) => [t.exposure_pct, t.exposure_rank])).toEqual([
      [60, "highest"],
      [45, null],
      [30, "lowest"],
      // No tilt for the factor: unknown, not 0% — and not the "lowest".
      [undefined, null],
    ]);
    // Every one of these cleared the old top threshold: the reason for the ruling.
    expect(fresh.themes.slice(0, 3).map((t) => t.exposure_bucket)).toEqual(["very-high", "very-high", "very-high"]);

    const cached = await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(cached.fromCache).toBe(true);
    expect(cached.themes[0].exposure_pct).toBe(60);
    expect(cached.themes[0].exposure_rank).toBe("highest");
    expect(vi.mocked(generateTextForFeature)).toHaveBeenCalledTimes(1);
  });

  it("the weekly briefing markdown never receives the percentage (outbound copy stays direction-only)", async () => {
    const db = seedDb();
    vi.mocked(computeFactorAnalysis).mockReturnValue({
      tilts: [
        { factor: "ai_exposure", exposurePct: 61.37, topContributors: [] },
        { factor: "interest_rate_sensitive", exposurePct: 44.21, topContributors: [] },
        { factor: "tariff_exposure", exposurePct: 29.83, topContributors: [] },
      ],
    } as never);
    const { themes } = await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
    const md = renderMacroThemesMarkdown(themes) ?? "";
    expect(md).toContain("AI capex cycle");
    expect(md).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(md).not.toMatch(/61|44\.2|29\.8/);
    expect(md).not.toMatch(/highest|lowest/);
  });

  it("the stored source summary names each cited event and lists no superseded twin", async () => {
    const db = seedDb();
    insertEvent(db, { id: 20, type: "macro", title: "CPI Release", symbol: null, key: "fred:cpi" });
    insertEvent(db, { id: 21, type: "earnings", title: "AAA Earnings", symbol: "AAA", key: "manual:AAA" });
    insertEvent(db, { id: 22, type: "earnings", title: "AAA Earnings", symbol: "AAA", key: "feed:AAA", superseded: 1 });
    await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
    const row = getCachedMacroThemes(db, "all", WEEK);
    const summary = JSON.parse(row!.sourceSummary!) as { events: Array<Record<string, unknown>> };
    expect(summary.events.map((e) => e.id).sort()).toEqual([20, 21]);
    const cpi = summary.events.find((e) => e.id === 20)!;
    expect(cpi.title).toBe("CPI Release");
    expect(cpi.event_type).toBe("macro");
  });
});
