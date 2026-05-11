import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { MacroThemesSchema, type MacroThemeAi, buildMacroSignalBlob, generateMacroThemes } from "@/lib/compute/macro-themes";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("MacroThemesSchema", () => {
  it("accepts a well-formed 3-theme array", () => {
    const sample: MacroThemeAi[] = [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off", summary: "Trade-deal headlines pushed risk down all week." },
      { name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off", summary: "Mega-caps gave back gains after weak Capex commentary." },
      { name: "Rate-cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on", summary: "Softer CPI revived September cut bets." },
    ];
    expect(() => MacroThemesSchema.parse(sample)).not.toThrow();
  });

  it("rejects an empty array (need at least one theme)", () => {
    expect(() => MacroThemesSchema.parse([])).toThrow();
  });

  it("rejects a 6-theme array (cap at 5)", () => {
    const six = Array.from({ length: 6 }).map((_, i) => ({
      name: `T${i}`, factor_label: "ai_exposure",
      direction: "risk-on" as const, summary: "x".repeat(20),
    }));
    expect(() => MacroThemesSchema.parse(six)).toThrow();
  });

  it("rejects an unknown direction value", () => {
    const bad = [{ name: "X", factor_label: "ai_exposure", direction: "sideways", summary: "x".repeat(20) }];
    expect(() => MacroThemesSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown factor_label", () => {
    const bad = [{ name: "X", factor_label: "weather_exposure", direction: "risk-on", summary: "x".repeat(20) }];
    expect(() => MacroThemesSchema.parse(bad)).toThrow();
  });
});

describe("buildMacroSignalBlob", () => {
  function seed() {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO research_articles
           (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
         VALUES (?, 1, ?, 't@test.com', ?, datetime('now', '-${i} days'), datetime('now'), ?, ?)`
      ).run(i + 1, `Article ${i}`, `Body ${i} mentioning AAPL and NVDA and tariffs`,
            i % 2 === 0 ? "negative" : "positive",
            JSON.stringify(["AAPL", "NVDA"]));
    }
    db.prepare(
      `INSERT INTO calendar_events
         (id, event_date, event_type, source, source_key, week_of, title, symbol, actual_value, reaction_snapshot, enriched_at)
       VALUES (1, date('now', '-2 days'), 'macro', 'fred', 'fred:CPIAUCSL:2026-05-08', date('now','-2 days'), 'CPI Release', 'CPI', '0.3%',
         '{"spy":{"close":580,"change":-0.012}}', datetime('now','-2 days'))`
    ).run();
    return db;
  }

  it("aggregates last 7d of articles + enriched events", () => {
    const db = seed();
    const blob = buildMacroSignalBlob(db, "all", "2026-05-04");
    expect(blob.articleCount).toBe(3);
    expect(blob.enrichedEventCount).toBe(1);
    expect(blob.totalSignalCount).toBe(4);
    expect(blob.articles[0].mentioned_symbols).toContain("AAPL");
    expect(blob.enrichedEvents[0].symbol).toBe("CPI");
  });

  it("respects 7-day cutoff and ignores older articles", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (99, 1, 'old', 't@test.com', 'old', datetime('now','-30 days'), datetime('now'), 'neutral', '[]')`
    ).run();
    const blob = buildMacroSignalBlob(db, "all", "2026-05-04");
    expect(blob.articleCount).toBe(3);
  });

  it("flags under-threshold input when < 2 articles + 0 enriched events", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'T', 't@t.com', 1)").run();
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (1, 1, 's', 't@t.com', 'b', datetime('now'), datetime('now'), 'neutral', '[]')`
    ).run();
    const blob = buildMacroSignalBlob(db, "all", "2026-05-04");
    expect(blob.underThreshold).toBe(true);
  });
});

describe("generateMacroThemes", () => {
  function seedDb() {
    const db = new Database(":memory:");
    runMigrations(db);
    return db;
  }

  it("returns cache hit when row exists for (scope, week)", async () => {
    const db = seedDb();
    const themes = [{
      name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
      summary: "Trade-deal headlines pushed risk down all week.",
      exposure_bucket: "moderate", top_contributors: [{ symbol: "AAPL", weight: 0.04 }],
    }];
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify(themes), sourceSummary: null, modelUsed: "claude-sonnet-4-6",
    });
    const result = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(result.fromCache).toBe(true);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].name).toBe("Tariff escalation");
  });

  it("returns empty array with underThreshold=true when insufficient signal", async () => {
    const db = seedDb();
    const result = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(result.fromCache).toBe(false);
    expect(result.themes).toEqual([]);
    expect(result.underThreshold).toBe(true);
  });

  it("post-process degrades to empty top_contributors when factor result lacks tilts", async () => {
    // Cache a theme generated against a freshly-migrated DB with no
    // factor classifications. computeFactorAnalysis returns null or an
    // object without `tilts`, and post-process must not throw — it
    // should just set top_contributors to [].
    const db = seedDb();
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify([{
        name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off",
        summary: "Mega-caps gave back gains after weak Capex commentary.",
        exposure_bucket: "low", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const result = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(result.themes[0].top_contributors).toEqual([]);
  });
});
