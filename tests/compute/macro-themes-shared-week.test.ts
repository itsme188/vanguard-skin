/**
 * One AI reply per week, shared by every scope (Analysis tab fix wave
 * 2026-11-15, unit I1). The model input is the same for every scope, but the
 * Sunday briefing bought it four times and the four rows of one week carried
 * different theme names. Also: a reply cut off at the output cap is a named
 * failure, and the cache read recomputes the exposure figures.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
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
  MACRO_THEME_SCOPES,
  MacroThemesCutOffError,
  MacroThemesParseError,
  generateMacroThemes,
  planMacroThemes,
  pregenerateMacroThemesForWeek,
  withCurrentExposure,
  type MacroTheme,
} from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const WEEK = "2026-05-04";
const BODY = "Synthetic body text about markets this week.";

// Account ids by scope, so the factor mock can answer per scope.
let ids: Record<string, number> = {};

function seedDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO research_articles
         (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (?, 1, ?, 't@test.com', ?, datetime('${WEEK}', '-${i} days'), datetime('now'), 'neutral', '[]')`,
    ).run(i + 1, `Article ${i}`, BODY);
  }
  // The migrations seed the three accounts; look each scope's id up by name.
  const idOf = (name: string) => (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
  ids = { vanguard: idOf("Vanguard Taxable"), roth: idOf("Vanguard Roth IRA"), ibkr: idOf("IBKR") };
  return db;
}

function reply(names: string[]) {
  return JSON.stringify(names.map((name, i) => ({
    name,
    factor_label: i === 0 ? "ai_exposure" : "interest_rate_sensitive",
    direction: "risk-on",
    summary: "Synthetic summary of a theme for the week.",
    cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: BODY,
  })));
}

/** Exposure by scope: all 50/20, vanguard 40/30, roth 10/60, ibkr 70/5. */
const PCT: Record<string, [number, number]> = { all: [50, 20], vanguard: [40, 30], roth: [10, 60], ibkr: [70, 5] };
function scopeOf(accountIds: number[] | undefined): string {
  if (!accountIds) return "all";
  return Object.entries(ids).find(([, id]) => accountIds.includes(id))?.[0] ?? "all";
}
function mockTilts(shift = 0) {
  vi.mocked(computeFactorAnalysis).mockImplementation(((_db: unknown, o: { accountIds?: number[] }) => {
    const [ai, rate] = PCT[scopeOf(o.accountIds)];
    return {
      tilts: [
        { factor: "ai_exposure", exposurePct: ai + shift, topContributors: [{ symbol: "ZZA", weight: 10 }] },
        { factor: "interest_rate_sensitive", exposurePct: rate + shift, topContributors: [{ symbol: "ZZB", weight: 5 }] },
      ],
    };
  }) as never);
}

const ai = () => vi.mocked(generateTextForFeature);

beforeEach(() => {
  ai().mockReset();
  ai().mockResolvedValue({ text: reply(["Theme one", "Theme two"]), finishReason: "stop" } as never);
  vi.mocked(computeFactorAnalysis).mockReset();
  mockTilts();
});

function cachedThemes(db: Database.Database, scope: string): MacroTheme[] {
  return JSON.parse(getCachedMacroThemes(db, scope, WEEK)!.themesJson) as MacroTheme[];
}

describe("one reply per week, shared by every scope", () => {
  it("the Sunday pre-generation makes exactly one AI call and writes all four scopes with the same theme names and their own exposure", async () => {
    const db = seedDb();
    await pregenerateMacroThemesForWeek(db, WEEK);
    expect(ai()).toHaveBeenCalledTimes(1);

    const names = MACRO_THEME_SCOPES.map((s) => cachedThemes(db, s).map((t) => t.name));
    for (const n of names) expect(n).toEqual(["Theme one", "Theme two"]);

    for (const s of MACRO_THEME_SCOPES) {
      expect(cachedThemes(db, s).map((t) => t.exposure_pct)).toEqual(PCT[s]);
    }
    // ibkr: ai 70 highest; roth: ai 10 lowest — scope-specific markers.
    expect(cachedThemes(db, "ibkr")[0].exposure_rank).toBe("highest");
    expect(cachedThemes(db, "roth")[0].exposure_rank).toBe("lowest");

    // One source summary and one generated time for the week.
    const rows = MACRO_THEME_SCOPES.map((s) => getCachedMacroThemes(db, s, WEEK)!);
    expect(new Set(rows.map((r) => r.sourceSummary)).size).toBe(1);
    expect(new Set(rows.map((r) => r.generatedAt)).size).toBe(1);
  });

  it("a second Sunday pass in the same week makes no AI call", async () => {
    const db = seedDb();
    await pregenerateMacroThemesForWeek(db, WEEK);
    await pregenerateMacroThemesForWeek(db, WEEK);
    expect(ai()).toHaveBeenCalledTimes(1);
  });

  it("a POST-style request for a scope with no row reuses another scope's reply with no AI call, keeping the reply's generated time", async () => {
    const db = seedDb();
    // A week written before the change: only "all" has a row.
    upsertMacroThemes(db, {
      scope: "all", weekOf: WEEK,
      themesJson: JSON.stringify([{
        name: "Old shared theme", factor_label: "ai_exposure", direction: "risk-off",
        summary: "Synthetic summary of a theme for the week.", exposure_bucket: "low",
        exposure_pct: 1, exposure_rank: null, top_contributors: [],
        cited_kind: "article", cited_id: 1, cited_title: "Article 0", cited_excerpt: BODY,
      }]),
      sourceSummary: JSON.stringify({ articles: [{ id: 1, title: "Article 0" }], events: [], alerts: [] }),
      modelUsed: "donor-model",
    });
    db.prepare("UPDATE analysis_macro_themes SET generated_at = '2026-05-03 12:00:00'").run();

    expect(planMacroThemes(db, "roth", WEEK, true)).toBe("reuse");
    const r = await generateMacroThemes(db, { scope: "roth", weekOf: WEEK, forceRegen: true });
    expect(ai()).not.toHaveBeenCalled();
    expect(r.themes.map((t) => t.name)).toEqual(["Old shared theme"]);
    expect(r.themes[0].exposure_pct).toBe(10); // roth's own figure, not the donor's
    expect(r.themes[0].cited_excerpt).toBe(BODY);
    const row = getCachedMacroThemes(db, "roth", WEEK)!;
    expect(row.generatedAt).toBe("2026-05-03 12:00:00");
    expect(row.modelUsed).toBe("donor-model");
    expect(r.sourceSummary?.articles).toEqual([{ id: 1, title: "Article 0" }]);
  });

  it("an explicit regeneration of a scope that has a row makes ONE call and refreshes every scope", async () => {
    const db = seedDb();
    await pregenerateMacroThemesForWeek(db, WEEK);
    ai().mockResolvedValue({ text: reply(["Fresh one", "Fresh two"]), finishReason: "stop" } as never);
    expect(planMacroThemes(db, "vanguard", WEEK, true)).toBe("generate");
    await generateMacroThemes(db, { scope: "vanguard", weekOf: WEEK, forceRegen: true });
    expect(ai()).toHaveBeenCalledTimes(2);
    for (const s of MACRO_THEME_SCOPES) {
      expect(cachedThemes(db, s).map((t) => t.name)).toEqual(["Fresh one", "Fresh two"]);
    }
  });

  it("an empty (under-threshold) row elsewhere is not a reply to reuse", async () => {
    const db = seedDb();
    upsertMacroThemes(db, { scope: "all", weekOf: WEEK, themesJson: "[]", sourceSummary: null, modelUsed: "(none)" });
    expect(planMacroThemes(db, "ibkr", WEEK, true)).toBe("generate");
  });

  it("the under-threshold verdict is written for every scope with no AI call", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const r = await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(r.underThreshold).toBe(true);
    expect(ai()).not.toHaveBeenCalled();
    for (const s of MACRO_THEME_SCOPES) expect(getCachedMacroThemes(db, s, WEEK)!.themesJson).toBe("[]");
  });

  it("noneVerified writes no scope", async () => {
    const db = seedDb();
    ai().mockResolvedValue({
      text: JSON.stringify([{ name: "Uncited", factor_label: "ai_exposure", direction: "risk-on", summary: "Synthetic summary of a theme." }]),
      finishReason: "stop",
    } as never);
    const r = await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
    expect(r.noneVerified).toBe(true);
    for (const s of MACRO_THEME_SCOPES) expect(getCachedMacroThemes(db, s, WEEK)).toBeNull();
  });

  it("a failure while computing one scope's exposure leaves no scope half-written", async () => {
    const db = seedDb();
    await pregenerateMacroThemesForWeek(db, WEEK);
    const before = MACRO_THEME_SCOPES.map((s) => getCachedMacroThemes(db, s, WEEK)!.themesJson);
    ai().mockResolvedValue({ text: reply(["Fresh one", "Fresh two"]), finishReason: "stop" } as never);
    let calls = 0;
    vi.mocked(computeFactorAnalysis).mockImplementation((() => {
      calls++;
      if (calls === 3) throw new Error("factor read failed");
      return { tilts: [] };
    }) as never);
    await expect(generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true })).rejects.toThrow(/factor read failed/);
    expect(MACRO_THEME_SCOPES.map((s) => getCachedMacroThemes(db, s, WEEK)!.themesJson)).toEqual(before);
  });
});

describe("a reply cut off at the output cap", () => {
  it("is a named, user-facing failure and writes nothing, even when the start would parse", async () => {
    const db = seedDb();
    ai().mockResolvedValue({ text: reply(["Theme one"]), finishReason: "length" } as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
      await expect(p).rejects.toBeInstanceOf(MacroThemesCutOffError);
      await expect(p).rejects.toBeInstanceOf(MacroThemesParseError);
      await expect(p).rejects.toThrow(/cut off/);
      for (const s of MACRO_THEME_SCOPES) expect(getCachedMacroThemes(db, s, WEEK)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("withCurrentExposure (the cache read)", () => {
  it("recomputes the figures, marker and top holdings from the book as it is now, and writes nothing", async () => {
    const db = seedDb();
    await pregenerateMacroThemesForWeek(db, WEEK);
    const stored = cachedThemes(db, "vanguard");
    const rowBefore = getCachedMacroThemes(db, "vanguard", WEEK);

    mockTilts(25); // holdings changed since Sunday
    const now = withCurrentExposure(db, "vanguard", stored);
    expect(now.map((t) => t.exposure_pct)).toEqual([65, 55]);
    expect(now.map((t) => t.name)).toEqual(stored.map((t) => t.name));
    expect(now[0].cited_excerpt).toBe(BODY);
    expect(getCachedMacroThemes(db, "vanguard", WEEK)).toEqual(rowBefore);
  });

  it("drops a stale figure when the factor no longer has a tilt", () => {
    const db = seedDb();
    vi.mocked(computeFactorAnalysis).mockReturnValue({ tilts: [] } as never);
    const [t] = withCurrentExposure(db, "all", [{
      name: "X theme", factor_label: "ai_exposure", direction: "neutral", summary: "Synthetic summary of a theme.",
      exposure_bucket: "high", exposure_pct: 22, exposure_rank: "highest", top_contributors: [{ symbol: "ZZA", weight: 1 }],
    }]);
    expect(t.exposure_pct).toBeUndefined();
    expect(t.exposure_rank).toBeNull();
    expect(t.top_contributors).toEqual([]);
  });

  it("falls back to the stored figures when the book cannot be read", () => {
    const db = seedDb();
    vi.mocked(computeFactorAnalysis).mockImplementation(() => { throw new Error("boom"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stored: MacroTheme[] = [{
        name: "X theme", factor_label: "ai_exposure", direction: "neutral", summary: "Synthetic summary of a theme.",
        exposure_bucket: "high", exposure_pct: 22, exposure_rank: null, top_contributors: [],
      }];
      expect(withCurrentExposure(db, "all", stored)).toEqual(stored);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the Sunday briefing calls the shared pre-generation", () => {
  it("never runs the four scopes as separate generations", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/digest/send-briefing.ts"), "utf8");
    const at = anchorIndex(src, "// Macro themes pre-generation.");
    const block = src.slice(at, at + 1200);
    expect(block).toContain("pregenerateMacroThemesForWeek(db, macroWeek)");
    expect(block).not.toMatch(/generateMacroThemes\(db, \{ scope/);
  });
});
