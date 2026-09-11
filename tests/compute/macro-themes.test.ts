import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { MacroThemesSchema, MacroThemesParseError, type MacroThemeAi, buildMacroSignalBlob, generateMacroThemes, parseThemesJson } from "@/lib/compute/macro-themes";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { readFileSync } from "node:fs";

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
         VALUES (?, 1, ?, 't@test.com', ?, datetime('2026-05-04', '-${i} days'), datetime('now'), ?, ?)`
      ).run(i + 1, `Article ${i}`, `Body ${i} mentioning AAPL and NVDA and tariffs`,
            i % 2 === 0 ? "negative" : "positive",
            JSON.stringify(["AAPL", "NVDA"]));
    }
    db.prepare(
      `INSERT INTO calendar_events
         (id, event_date, event_type, source, source_key, week_of, title, symbol, actual_value, reaction_snapshot, enriched_at)
       VALUES (1, date('2026-05-04', '-2 days'), 'macro', 'fred', 'fred:CPIAUCSL:2026-05-08', date('2026-05-04','-2 days'), 'CPI Release', 'CPI', '0.3%',
         '{"spy":{"close":580,"change":-0.012}}', datetime('2026-05-04','-2 days'))`
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
       VALUES (99, 1, 'old', 't@test.com', 'old', datetime('2026-05-04','-30 days'), datetime('now'), 'neutral', '[]')`
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

describe("parseThemesJson", () => {
  const theme = {
    name: "Tariff escalation",
    factor_label: "tariff_exposure",
    direction: "risk-off",
    summary: "Trade-deal headlines pushed risk assets down through the week.",
  };

  it("parses clean JSON and a code-fenced wrap", () => {
    const json = JSON.stringify([theme]);
    expect(parseThemesJson(json)).toHaveLength(1);
    expect(parseThemesJson("```json\n" + json + "\n```")).toHaveLength(1);
  });

  it("recovers from a raw control character inside a string literal", () => {
    // Sonnet intermittently emits an unescaped newline mid-string — plain
    // JSON.parse rejects it with "Bad control character in string literal"
    // (the exact failure the 2026-07-27 sweep saw 500 on a cold cache).
    const broken = `[{"name":"Tariff escalation","factor_label":"tariff_exposure","direction":"risk-off","summary":"Trade-deal headlines pushed\nrisk assets down through the week."}]`;
    expect(() => JSON.parse(broken)).toThrow();
    const parsed = parseThemesJson(broken);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].summary).toContain("pushed risk assets");
  });

  it("parses an array followed by trailing prose", () => {
    // Sonnet sometimes signs off after the JSON despite the system prompt.
    const parsed = parseThemesJson(
      JSON.stringify([theme]) + "\n\nLet me know if you want these broken out further.",
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Tariff escalation");
  });

  it("parses an array behind a leading preamble", () => {
    const parsed = parseThemesJson(
      "Here are the themes I identified this week:\n" + JSON.stringify([theme]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].factor_label).toBe("tariff_exposure");
  });

  it("throws a typed, USER-FACING error for a truncated reply and logs the raw detail", () => {
    // The 2026-09-10 sweep: the reply was cut mid-string and the raw
    // "Unterminated string in JSON at position 1074" rendered inside the card.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let caught: unknown;
      try {
        parseThemesJson('[{"name":"A","fa');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MacroThemesParseError);
      const err = caught as MacroThemesParseError;
      expect(err.message).toBe(
        "The model's reply couldn't be read as themes — try again in a moment.",
      );
      expect(err.message).not.toMatch(/JSON|position|Unexpected|Unterminated/);
      // The parser text survives for the server log, never for the user.
      expect(err.detail).toMatch(/JSON|Unexpected|Unterminated/);
      expect(err.detail).toContain('[{"name":"A","fa');
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0][0])).toContain('[{"name":"A","fa');
    } finally {
      errSpy.mockRestore();
    }
  });

  it("still throws for genuinely broken output, with no parser jargon in the message", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let caught: unknown;
      try {
        parseThemesJson("not json at all");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MacroThemesParseError);
      const err = caught as MacroThemesParseError;
      expect(err.message).not.toMatch(/JSON|position|Unexpected/);
      expect(err.message).toContain("try again in a moment");
      expect(err.detail.length).toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("reports a schema failure with its own user-facing message and the zod text in .detail", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Parses fine as JSON; fails MacroThemesSchema (unknown factor_label).
      const bad = JSON.stringify([{
        name: "Weather trade", factor_label: "weather_exposure",
        direction: "risk-on", summary: "y".repeat(30),
      }]);
      let caught: unknown;
      try {
        parseThemesJson(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MacroThemesParseError);
      const err = caught as MacroThemesParseError;
      expect(err.message).toBe(
        "The model's reply didn't match the themes format — try again in a moment.",
      );
      expect(err.detail).toContain("factor_label");
    } finally {
      errSpy.mockRestore();
    }
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

// ─────────────────────────────────────────────────────────────────────────
// Landing 2026-09-11. generateMacroThemes wrapped a provider failure as
// "Sonnet macro-themes generation failed: <raw provider text>" and a refusal
// as "Sonnet macro-themes generation refused". The route passed `e.message`
// straight into its JSON body and the Macro card rendered it verbatim, in red
// — so a model family name AND raw vendor text reached a user surface. The
// route now sanitises non-MacroThemesParseError throws, and the thrown text
// itself no longer names a model family (CLAUDE.md: never name a model id in
// user-facing copy; model ids come from resolveFeatureModel, not string
// literals).
//
// No jsdom/RTL harness here and the throw sites sit behind a paid AI call, so
// this is a source pin (the repo's established pattern for that shape).
describe("macro-themes generation errors carry no model family name", () => {
  const src = readFileSync("lib/compute/macro-themes.ts", "utf8");

  it("throws generic generation-failed / refused messages", () => {
    expect(src).toContain("throw new Error(`macro-themes generation refused`)");
    expect(src).toContain("throw new Error(`macro-themes generation failed: ${msg}`)");
  });

  it("names no model family in any thrown or returned string", () => {
    for (const line of src.split("\n")) {
      if (!/throw new Error\(|throw new MacroThemesParseError\(/.test(line)) continue;
      expect(line).not.toMatch(/Sonnet|Haiku|Opus|Claude|claude-|Anthropic/i);
    }
  });
});
