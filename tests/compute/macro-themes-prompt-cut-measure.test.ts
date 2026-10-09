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
  MACRO_PROMPT_INPUT_CAP,
  buildMacroSignalBlob,
  generateMacroThemes,
} from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";

// History: this file first MEASURED the old prompt, which was built as
//   JSON.stringify({ articles, enriched_events, alerts }, null, 2).slice(0, 16000)
// with the articles first. On a full-size week the cut landed mid-article,
// fewer than a third of the articles got through and no event or alert did.
//
// Owner ruling (2026-10-08): keep a size cap, but fill it in priority order
// with WHOLE items: calendar events and alerts first (a fixed smaller share),
// then articles ranked by relevance to what is held, then newest. This file now
// pins that behaviour on the same synthetic full-size week.

const WEEK = "2026-05-04";
const ARTICLES = 70; // more than the old LIMIT 60: the whole week is ranked
const EVENTS = 30;
const ALERTS = 30;
const HELD_ARTICLE_ID = ARTICLES; // the OLDEST article: the old cut never reached it
const OFF_TOPIC_ARTICLE_ID = 900;

// A newsletter-sized body: far longer than the prompt keeps.
const BODY = "Synthetic newsletter paragraph about markets and rates. ".repeat(60);
const SUMMARY =
  "Synthetic summary: the letter argues that rates stay higher for longer and that cyclicals lag. It closes with a note on positioning into the next print.";

function seedFullWeek() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
  // The enriched shape lib/gmail/process.ts writes: summary, sentiment and a
  // JSON array of mentioned symbols.
  const insertArticle = db.prepare(
    `INSERT INTO research_articles
       (id, source_id, subject, sender, raw_text, received_at, processed_at, summary, sentiment, mentioned_symbols, is_relevant)
     VALUES (?, 1, ?, 't@test.com', ?, datetime('${WEEK}', ?), datetime('now'), ?, 'neutral', ?, ?)`,
  );
  for (let i = 0; i < ARTICLES; i++) {
    const id = i + 1;
    insertArticle.run(
      id,
      `Synthetic article ${String(id).padStart(2, "0")}: a typical newsletter subject line`,
      BODY,
      `-${i * 2} hours`,
      SUMMARY,
      // Only the oldest article mentions the one held name.
      id === HELD_ARTICLE_ID ? '["ZZA","BBB"]' : '["AAA","BBB","CCC"]',
      1,
    );
  }
  // Newest of all, but voted off-topic: it must never reach the model.
  insertArticle.run(OFF_TOPIC_ARTICLE_ID, "Synthetic off-topic promo", BODY, "+0 hours", SUMMARY, '["ZZA"]', 0);

  for (let i = 0; i < EVENTS; i++) {
    db.prepare(
      `INSERT INTO calendar_events
         (id, event_date, event_type, source, source_key, week_of, title, symbol, actual_value, reaction_snapshot, enriched_at, superseded)
       VALUES (?, date('${WEEK}', '-2 days'), 'macro', 'test', ?, date('${WEEK}', '-2 days'), ?, NULL, '1.00', ?, datetime('${WEEK}', '-2 days'), 0)`,
    ).run(
      1000 + i,
      `test:event:${i}`,
      `Synthetic release ${String(i + 1).padStart(2, "0")}`,
      // The stored shape (lib/calendar/reaction-snapshot-core.ts).
      JSON.stringify({
        t0_utc: "2026-05-02T12:30:00.000Z", window_min: 120, source: "tws",
        spy: { t_pre: 500, t_post: 502, delta_pct: 0.4 },
        qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
        tlt: { t_pre: 90, t_post: 90.9, delta_pct: 1.0 },
      }),
    );
  }

  db.exec("INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test Account')");
  const alertSecurityId = Number(
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Inc', 'Stock')").run().lastInsertRowid,
  );
  const heldSecurityId = Number(
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZA', 'ZZA Inc', 'Stock')").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, '2026-05-01', 100)").run(heldSecurityId);
  for (let i = 0; i < ALERTS; i++) {
    const levelId = upsertLevel(db, { security_id: alertSecurityId, level_type: "support", price: 100 + i });
    triggerLevel(db, { levelId, securityId: alertSecurityId, triggeredPrice: 99 + i });
  }
  return db;
}

interface SentInputs {
  enriched_events: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  articles: Array<{ id: number; subject: string; summary?: string; excerpt?: string; symbols: string[] }>;
}

async function generateAndCapture() {
  const db = seedFullWeek();
  await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
  const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
  const sent = prompt.slice(prompt.indexOf("Inputs:\n") + "Inputs:\n".length);
  return { db, sent };
}

describe("macro-themes prompt: a full-size week is filled in priority order, whole items only", () => {
  beforeEach(() => {
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(generateTextForFeature).mockResolvedValue({
      text: JSON.stringify([
        {
          name: "Rate repricing", factor_label: "interest_rate_sensitive", direction: "risk-off",
          summary: "A hot jobs print revived the hike debate.",
          cited_kind: "article", cited_id: HELD_ARTICLE_ID, cited_read: "negative",
          cited_excerpt: "rates stay higher for longer and that cyclicals lag",
        },
      ]),
    } as never);
    vi.mocked(computeFactorAnalysis).mockReturnValue({ tilts: [] } as never);
  });

  it("the week loaded is the relevant week: the off-topic article is not in it", () => {
    const blob = buildMacroSignalBlob(seedFullWeek(), "all", WEEK);
    expect(blob.articles).toHaveLength(ARTICLES);
    expect(blob.articles.map((a) => a.id)).not.toContain(OFF_TOPIC_ARTICLE_ID);
    expect(blob.enrichedEvents).toHaveLength(EVENTS);
    expect(blob.alerts).toHaveLength(ALERTS);
  });

  it("stays inside the cap and is never cut mid-item: what was sent is valid JSON", async () => {
    const { sent } = await generateAndCapture();
    expect(sent.length).toBeLessThanOrEqual(MACRO_PROMPT_INPUT_CAP);
    expect(MACRO_PROMPT_INPUT_CAP).toBe(16000);
    const parsed = JSON.parse(sent) as SentInputs;
    // Every article that was sent arrived whole.
    for (const a of parsed.articles) {
      expect(typeof a.id).toBe("number");
      expect(a.subject).toMatch(/^Synthetic article \d\d/);
      expect(a.summary).toBe(SUMMARY);
      expect(Array.isArray(a.symbols)).toBe(true);
    }
  });

  it("calendar events and alerts reach the model, ahead of the articles", async () => {
    const { sent } = await generateAndCapture();
    const parsed = JSON.parse(sent) as SentInputs;
    expect(parsed.enriched_events.length).toBeGreaterThan(0);
    expect(parsed.alerts.length).toBeGreaterThan(0);
    expect(sent.indexOf('"enriched_events"')).toBeLessThan(sent.indexOf('"articles"'));
    expect(sent.indexOf('"alerts"')).toBeLessThan(sent.indexOf('"articles"'));
  });

  it("events are trimmed to what the model needs: no raw reaction snapshot, but the moves", async () => {
    const { sent } = await generateAndCapture();
    const parsed = JSON.parse(sent) as SentInputs;
    expect(sent).not.toContain("reaction_snapshot");
    expect(sent).not.toContain("t_pre");
    expect(sent).not.toContain("t0_utc");
    const [event] = parsed.enriched_events;
    expect(event.title).toMatch(/^Synthetic release/);
    expect(event.actual).toBe("1.00");
    expect(event.reaction).toBe("SPY +0.40%, QQQ -0.50%, TLT +1.00%");
  });

  it("articles always get the larger part of the budget", async () => {
    const { sent } = await generateAndCapture();
    const parsed = JSON.parse(sent) as SentInputs;
    const articleChars = JSON.stringify(parsed.articles).length;
    const otherChars = JSON.stringify(parsed.enriched_events).length + JSON.stringify(parsed.alerts).length;
    expect(otherChars).toBeLessThanOrEqual(MACRO_PROMPT_INPUT_CAP * 0.25);
    expect(articleChars).toBeGreaterThan(otherChars * 2);
    // More whole articles than the old cut delivered (it managed about 14).
    expect(parsed.articles.length).toBeGreaterThanOrEqual(15);
  });

  it("the article on a held name is sent first, though it is the oldest of the week", async () => {
    const { sent } = await generateAndCapture();
    const parsed = JSON.parse(sent) as SentInputs;
    expect(parsed.articles[0].id).toBe(HELD_ARTICLE_ID);
    // After the held-relevant one, newest first.
    expect(parsed.articles.slice(1, 4).map((a) => a.id)).toEqual([1, 2, 3]);
    expect(parsed.articles.map((a) => a.id)).not.toContain(OFF_TOPIC_ARTICLE_ID);
  });

  it("the stored source summary lists what was actually sent, and how much of the week that is", async () => {
    const { db, sent } = await generateAndCapture();
    const parsed = JSON.parse(sent) as SentInputs;
    const row = getCachedMacroThemes(db, "all", WEEK);
    const summary = JSON.parse(row!.sourceSummary!) as {
      articles: Array<{ id: number; title: string }>;
      events: Array<{ id: number }>;
      alerts: Array<{ id: number }>;
      totals: { articles: number; events: number; alerts: number };
    };
    expect(summary.articles.map((a) => a.id)).toEqual(parsed.articles.map((a) => a.id));
    expect(summary.events.map((e) => e.id)).toEqual(parsed.enriched_events.map((e) => e.id));
    expect(summary.alerts.map((a) => a.id)).toEqual(parsed.alerts.map((a) => a.id));
    expect(summary.articles[0].title).toMatch(/^Synthetic article 70/);
    expect(summary.totals).toEqual({ articles: ARTICLES, events: EVENTS, alerts: ALERTS });
  });
});
