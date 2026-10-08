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

import { buildMacroSignalBlob, generateMacroThemes } from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";

// MEASUREMENT, not a fix (found 2026-10-07, not in the QA ledger).
//
// generateMacroThemes builds its prompt inputs as
//   JSON.stringify({ articles, enriched_events, alerts }, null, 2).slice(0, 16000)
// with up to 60 articles FIRST. This file feeds it a synthetic full-size week
// and measures what survives the cut. It changes nothing: the numbers are for
// the owner to rule on (reorder the sections, budget each one, or raise the
// cap). When the prompt is changed, the CHARACTERIZATION block below is the
// part to rewrite; the measurement itself should keep working.

const WEEK = "2026-05-04";
const INPUT_CAP = 16000; // the literal in generateMacroThemes
const ARTICLES = 60; // the query's LIMIT
const EVENTS = 30;
const ALERTS = 30;

// A newsletter-sized body: far longer than the 800 characters the prompt keeps.
const BODY = "Synthetic newsletter paragraph about markets and rates. ".repeat(60);

function seedFullWeek() {
  const db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
  for (let i = 0; i < ARTICLES; i++) {
    db.prepare(
      `INSERT INTO research_articles
         (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (?, 1, ?, 't@test.com', ?, datetime('${WEEK}', '-${i} hours'), datetime('now'), 'neutral', '["AAA","BBB","CCC"]')`,
    ).run(i + 1, `Synthetic article ${String(i + 1).padStart(2, "0")}: a typical newsletter subject line`, BODY);
  }
  for (let i = 0; i < EVENTS; i++) {
    db.prepare(
      `INSERT INTO calendar_events
         (id, event_date, event_type, source, source_key, week_of, title, symbol, actual_value, reaction_snapshot, enriched_at, superseded)
       VALUES (?, date('${WEEK}', '-2 days'), 'macro', 'test', ?, date('${WEEK}', '-2 days'), ?, NULL, '1.00', ?, datetime('${WEEK}', '-2 days'), 0)`,
    ).run(1000 + i, `test:event:${i}`, `Synthetic release ${String(i + 1).padStart(2, "0")}`, JSON.stringify({ spy: 0.4, tnx: -0.03, note: "synthetic reaction" }));
  }
  const securityId = Number(
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Inc', 'Stock')").run().lastInsertRowid,
  );
  for (let i = 0; i < ALERTS; i++) {
    const levelId = upsertLevel(db, { security_id: securityId, level_type: "support", price: 100 + i });
    triggerLevel(db, { levelId, securityId, triggeredPrice: 99 + i });
  }
  return db;
}

interface Measurement {
  uncutChars: number;
  uncutArticleChars: number;
  uncutEventChars: number;
  uncutAlertChars: number;
  sentChars: number;
  charsPerArticle: number;
  articlesComplete: number;
  articlesStarted: number;
  eventsSectionReached: boolean;
  eventsSeen: number;
  alertsSectionReached: boolean;
  articlesThatWouldFitBeforeEvents: number;
}

async function measure(): Promise<Measurement> {
  const db = seedFullWeek();
  const blob = buildMacroSignalBlob(db, "all", WEEK);
  // The seed is only a measurement if it really is the full-size week.
  expect([blob.articles.length, blob.enrichedEvents.length]).toEqual([ARTICLES, EVENTS]);

  await generateMacroThemes(db, { scope: "all", weekOf: WEEK, forceRegen: true });
  const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
  const sent = prompt.slice(prompt.indexOf("Inputs:\n") + "Inputs:\n".length);

  // The same object generateMacroThemes serialises, rebuilt from the blob, to
  // size each section BEFORE the cut.
  const articles = blob.articles.map((a) => ({
    id: a.id, subject: a.subject, sentiment: a.sentiment, symbols: a.mentioned_symbols, excerpt: a.excerpt.slice(0, 800),
  }));
  const uncut = JSON.stringify({ articles, enriched_events: blob.enrichedEvents, alerts: blob.alerts }, null, 2);
  // The harness must mirror the real serialisation, or the section sizes mean nothing.
  expect(sent).toBe(uncut.slice(0, INPUT_CAP));

  const eventsAt = uncut.indexOf('"enriched_events"');
  const alertsAt = uncut.indexOf('"alerts"');
  const charsPerArticle = eventsAt / ARTICLES;
  return {
    uncutChars: uncut.length,
    uncutArticleChars: eventsAt,
    uncutEventChars: alertsAt - eventsAt,
    uncutAlertChars: uncut.length - alertsAt,
    sentChars: sent.length,
    charsPerArticle: Math.round(charsPerArticle),
    // An article is complete when its closing excerpt line made it through.
    articlesComplete: (sent.match(/"excerpt": "[^"]*"\n/g) ?? []).length,
    articlesStarted: (sent.match(/"subject": "Synthetic article/g) ?? []).length,
    eventsSectionReached: sent.includes('"enriched_events"'),
    eventsSeen: (sent.match(/Synthetic release/g) ?? []).length,
    alertsSectionReached: sent.includes('"alerts"'),
    articlesThatWouldFitBeforeEvents: Math.floor(INPUT_CAP / charsPerArticle),
  };
}

describe("macro-themes prompt: what a full-size week loses to the 16,000-character cut", () => {
  beforeEach(() => {
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(generateTextForFeature).mockResolvedValue({
      text: JSON.stringify([
        { name: "Rate repricing", factor_label: "interest_rate_sensitive", direction: "risk-off", summary: "A hot jobs print revived the hike debate." },
      ]),
    } as never);
    vi.mocked(computeFactorAnalysis).mockReturnValue({ tilts: [] } as never);
  });

  it("measures the cut and prints the numbers", async () => {
    const m = await measure();
    console.info(`[macro-prompt-cut] ${JSON.stringify(m)}`);
    // Structural facts that hold whatever the owner rules.
    expect(m.sentChars).toBeLessThanOrEqual(INPUT_CAP);
    expect(m.uncutChars).toBe(m.uncutArticleChars + m.uncutEventChars + m.uncutAlertChars);
    expect(m.articlesComplete).toBeLessThanOrEqual(m.articlesStarted);
  });

  // CHARACTERIZATION of today's behaviour — the reason this file exists. These
  // are expected to change when the owner rules on the prompt; they are pinned
  // so the change is deliberate and its effect is visible in the diff.
  it("today: articles alone overflow the cap, so no event and no alert reaches the model", async () => {
    const m = await measure();
    expect(m.uncutArticleChars).toBeGreaterThan(INPUT_CAP);
    expect(m.eventsSectionReached).toBe(false);
    expect(m.eventsSeen).toBe(0);
    expect(m.alertsSectionReached).toBe(false);
    // Fewer than a third of the 60 articles the query loads get through whole.
    expect(m.articlesComplete).toBeLessThan(ARTICLES / 3);
  });
});
