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
  MACRO_NONE_VERIFIED_MESSAGE,
  MacroThemeSchema,
  generateMacroThemes,
} from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { renderMacroThemesMarkdown } from "@/lib/digest/macro-themes-markdown";

// Owner ruling (2026-10-08): a cached theme said the opposite of the article it
// cited. Each theme now names the input it cites and quotes it; a theme whose
// citation cannot be checked against what was sent is dropped before caching.

const WEEK = "2026-05-04";

const ARTICLES = [
  {
    id: 1, subject: "ZZA raises its outlook", sentiment: "bullish",
    summary: "ZZA raised full-year guidance after a strong quarter. Management pointed to firm pricing and a growing backlog.",
    raw: "ZZA lifted its full-year outlook on Tuesday.\nOrders rose for a third straight quarter, the company said.",
  },
  {
    id: 2, subject: "ZZB warns on demand", sentiment: "bearish",
    summary: "ZZB cut its revenue forecast and warned that demand from industrial customers is weakening.",
    raw: "ZZB shares fell after the company trimmed its revenue forecast for the year.",
  },
  {
    id: 3, subject: "Rates week in review", sentiment: "mixed",
    summary: "Treasury yields ended the week roughly flat after a volatile run of data releases.",
    raw: "Bond markets swung on every release this week and finished close to where they started.",
  },
  {
    id: 4, subject: "Unscored market note", sentiment: null,
    summary: "A short note on positioning ahead of the next inflation release, with no firm conclusion.",
    raw: "Positioning looks light ahead of the next inflation release.",
  },
] as const;

function seedDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
  const insert = db.prepare(
    `INSERT INTO research_articles
       (id, source_id, subject, sender, raw_text, received_at, processed_at, summary, sentiment, mentioned_symbols, is_relevant)
     VALUES (?, 1, ?, 't@test.com', ?, datetime('${WEEK}', ?), datetime('now'), ?, ?, '[]', ?)`,
  );
  for (const a of ARTICLES) insert.run(a.id, a.subject, a.raw, `-${a.id} hours`, a.summary, a.sentiment, 1);
  // In the database, in the week, but voted off-topic: never sent.
  insert.run(50, "Off-topic promo", "A promotional mailing about a conference next spring.", "-1 hours",
    "A promotional mailing about a conference next spring.", "neutral", 0);
  db.prepare(
    `INSERT INTO calendar_events
       (id, event_date, event_type, source, source_key, week_of, title, symbol, actual_value, enriched_at, superseded)
     VALUES (20, date('${WEEK}', '-2 days'), 'macro', 'test', 'test:cpi', date('${WEEK}', '-2 days'), 'CPI Release', NULL, '0.3%', datetime('${WEEK}', '-2 days'), 0)`,
  ).run();
  return db;
}

type Reply = Record<string, unknown>;

const base = (name: string): Reply => ({
  name, factor_label: "cyclical", direction: "risk-on",
  summary: "A synthetic one-sentence theme summary for the test.",
});

function replyWith(themes: Reply[]) {
  vi.mocked(generateTextForFeature).mockResolvedValue({ text: JSON.stringify(themes) } as never);
}

async function run(themes: Reply[], db = seedDb()) {
  replyWith(themes);
  const result = await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
  return { db, result };
}

const GOOD: Reply = {
  ...base("Guidance raises"),
  cited_kind: "article", cited_id: 1, cited_read: "positive",
  cited_excerpt: "ZZA raised full-year guidance after a strong quarter.",
};

describe("generateMacroThemes — every theme is checked against the input it cites", () => {
  beforeEach(() => {
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(computeFactorAnalysis).mockReturnValue({ tilts: [] } as never);
  });

  it("asks the model to name its source, quote it and say what the source says", async () => {
    await run([GOOD]);
    const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
    for (const field of ["cited_kind", "cited_id", "cited_excerpt", "cited_read"]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toMatch(/word for word/i);
  });

  it("does not show the model the stored sentiment it is checked against", async () => {
    await run([GOOD]);
    const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
    const sent = JSON.parse(prompt.slice(prompt.indexOf("Inputs:\n") + "Inputs:\n".length)) as {
      articles: Array<Record<string, unknown>>;
    };
    expect(sent.articles.length).toBe(ARTICLES.length);
    for (const a of sent.articles) expect(a).not.toHaveProperty("sentiment");
  });

  it("keeps a theme whose quote is in the cited article, and stores the quote and the article's title", async () => {
    const { db, result } = await run([GOOD]);
    expect(result.themes).toHaveLength(1);
    expect(result.droppedThemes).toBe(0);
    expect(result.noneVerified).toBeFalsy();
    const [theme] = result.themes;
    expect(theme.cited_kind).toBe("article");
    expect(theme.cited_id).toBe(1);
    expect(theme.cited_title).toBe("ZZA raises its outlook");
    expect(theme.cited_excerpt).toBe("ZZA raised full-year guidance after a strong quarter.");
    expect(theme.cited_read).toBe("positive");

    const cached = await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(cached.fromCache).toBe(true);
    expect(cached.themes[0].cited_excerpt).toBe(theme.cited_excerpt);
    // What is cached still satisfies the persisted schema.
    expect(() => MacroThemeSchema.parse(cached.themes[0])).not.toThrow();
  });

  it("matches the quote ignoring case, line breaks, runs of spaces, quote marks and a trailing ellipsis", async () => {
    const { result } = await run([
      // The raw text has a line break between these two sentences.
      { ...GOOD, cited_excerpt: "  “zza LIFTED its   full-year outlook on tuesday. Orders rose for a third straight quarter…” " },
    ]);
    expect(result.themes).toHaveLength(1);
  });

  // Codex review: ids overlap across articles, events and alerts, so a
  // citation with no kind is not guessed to be an article.
  it("drops a theme whose citation names no source kind", async () => {
    const { cited_kind: _omit, ...noKind } = GOOD;
    const { result } = await run([GOOD, noKind]);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].cited_kind).toBe("article");
  });

  it("drops a theme that cites nothing", async () => {
    const { result } = await run([GOOD, base("Uncited theme")]);
    expect(result.themes.map((t) => t.name)).toEqual(["Guidance raises"]);
    expect(result.droppedThemes).toBe(1);
  });

  it("drops a theme citing an id that was not sent — unknown, or in the database but filtered out", async () => {
    const { result } = await run([
      GOOD,
      { ...GOOD, name: "Unknown id", cited_id: 999 },
      { ...base("Filtered article"), cited_kind: "article", cited_id: 50, cited_read: "mixed",
        cited_excerpt: "A promotional mailing about a conference next spring." },
    ]);
    expect(result.themes.map((t) => t.name)).toEqual(["Guidance raises"]);
    expect(result.droppedThemes).toBe(2);
  });

  it("drops a theme whose quote is not in the cited article — a paraphrase, or another article's text", async () => {
    const { result } = await run([
      GOOD,
      { ...GOOD, name: "Paraphrase", cited_excerpt: "ZZA increased its guidance for the full year after strong results." },
      // Real text, wrong article.
      { ...GOOD, name: "Wrong article", cited_excerpt: "ZZB cut its revenue forecast and warned that demand" },
      // Too short to be a sentence: "ZZA" alone proves nothing.
      { ...GOOD, name: "Too short", cited_excerpt: "ZZA raised" },
    ]);
    expect(result.themes.map((t) => t.name)).toEqual(["Guidance raises"]);
    expect(result.droppedThemes).toBe(3);
  });

  it("drops a theme that reads the article the opposite way to its stored sentiment", async () => {
    const { result } = await run([
      GOOD,
      // Article 2 is stored bearish; the theme reads it as good news.
      { ...base("Demand recovery"), cited_kind: "article", cited_id: 2, cited_read: "positive",
        cited_excerpt: "ZZB cut its revenue forecast and warned that demand from industrial customers is weakening." },
      // Article 1 is stored bullish; the theme reads it as bad news.
      { ...GOOD, name: "Guidance cut", cited_read: "negative" },
    ]);
    expect(result.themes.map((t) => t.name)).toEqual(["Guidance raises"]);
    expect(result.droppedThemes).toBe(2);
  });

  it("drops a theme on a bullish or bearish article when the model did not say how it read it", async () => {
    const { cited_read: _omit, ...noRead } = GOOD;
    const { result } = await run([GOOD, { ...noRead, name: "No read given" }, { ...GOOD, name: "Odd read", cited_read: "sideways" }]);
    expect(result.themes.map((t) => t.name)).toEqual(["Guidance raises"]);
    expect(result.droppedThemes).toBe(2);
  });

  it("a mixed read, or a mixed, neutral or missing stored sentiment, never drops a theme", async () => {
    const { result } = await run([
      { ...GOOD, name: "Mixed read on bullish", cited_read: "mixed" },
      { ...base("Positive read on mixed"), cited_kind: "article", cited_id: 3, cited_read: "positive",
        cited_excerpt: "Treasury yields ended the week roughly flat" },
      { ...base("Negative read on unscored"), cited_kind: "article", cited_id: 4, cited_read: "negative",
        cited_excerpt: "Positioning looks light ahead of the next inflation release." },
      // No read at all is acceptable where no clash is possible.
      { ...base("No read on unscored"), cited_kind: "article", cited_id: 4,
        cited_excerpt: "A short note on positioning ahead of the next inflation release" },
    ]);
    expect(result.themes).toHaveLength(4);
    expect(result.droppedThemes).toBe(0);
  });

  it("a theme may cite a calendar event: it must quote what was sent, and has no sentiment to clash with", async () => {
    const { result } = await run([
      { ...base("Inflation print"), cited_kind: "event", cited_id: 20, cited_read: "negative", cited_excerpt: "CPI Release" },
      { ...base("Invented print"), cited_kind: "event", cited_id: 20, cited_excerpt: "CPI came in far hotter than expected" },
      { ...base("Unknown event"), cited_kind: "event", cited_id: 21, cited_excerpt: "CPI Release" },
      // An article id is not an event id.
      { ...base("Kind mismatch"), cited_kind: "event", cited_id: 1, cited_excerpt: "ZZA raised full-year guidance after a strong quarter." },
      { ...base("Unknown kind"), cited_kind: "tweet", cited_id: 20, cited_excerpt: "CPI Release" },
    ]);
    expect(result.themes.map((t) => t.name)).toEqual(["Inflation print"]);
    expect(result.themes[0].cited_kind).toBe("event");
    expect(result.themes[0].cited_title).toBe("CPI Release");
    expect(result.droppedThemes).toBe(4);
  });

  it("records how many themes were dropped beside the cached themes", async () => {
    const { db } = await run([GOOD, base("Uncited one"), base("Uncited two")]);
    const row = getCachedMacroThemes(db, "all", WEEK)!;
    expect(JSON.parse(row.themesJson)).toHaveLength(1);
    expect(JSON.parse(row.sourceSummary!).droppedThemes).toBe(2);
  });

  it("when EVERY theme fails, caches nothing and says so — it is not the insufficient-signal verdict", async () => {
    const { db, result } = await run([base("Uncited one"), { ...GOOD, cited_read: "negative" }]);
    expect(result.themes).toEqual([]);
    expect(result.noneVerified).toBe(true);
    expect(result.droppedThemes).toBe(2);
    expect(result.underThreshold).toBe(false);
    expect(getCachedMacroThemes(db, "all", WEEK)).toBeNull();
    expect(MACRO_NONE_VERIFIED_MESSAGE).toMatch(/none could be verified against its source/i);
    expect(MACRO_NONE_VERIFIED_MESSAGE).toMatch(/try again/i);
  });

  it("when every theme fails on a refresh, the week's earlier verified themes stay cached", async () => {
    const db = seedDb();
    await run([GOOD], db);
    const { result } = await run([base("Uncited")], db);
    expect(result.noneVerified).toBe(true);
    const row = getCachedMacroThemes(db, "all", WEEK)!;
    expect(JSON.parse(row.themesJson)[0].name).toBe("Guidance raises");
  });

  it("the weekly briefing markdown never carries the quote or the source (the email stays direction-only)", async () => {
    const { result } = await run([GOOD]);
    const md = renderMacroThemesMarkdown(result.themes) ?? "";
    expect(md).toContain("Guidance raises");
    expect(md).not.toContain("raised full-year guidance");
    expect(md).not.toContain("ZZA raises its outlook");
    expect(md).not.toMatch(/cited|positive/);
  });
});

describe("themes cached before citations existed", () => {
  const old = {
    name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
    summary: "Trade-deal headlines pushed risk down all week.",
    exposure_bucket: "very-high", top_contributors: [{ symbol: "AAA", weight: 4 }],
  };

  it("still parse, with no citation fields", () => {
    const parsed = MacroThemeSchema.parse(old);
    expect(parsed.cited_id).toBeUndefined();
    expect(parsed.cited_excerpt).toBeUndefined();
  });

  it("are served from the cache as they are — a cache read never re-checks or drops them", async () => {
    const db = seedDb();
    upsertMacroThemes(db, { scope: "all", weekOf: WEEK, themesJson: JSON.stringify([old]), sourceSummary: null, modelUsed: "v1" });
    const result = await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(result.fromCache).toBe(true);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].name).toBe("Tariff escalation");
  });
});
