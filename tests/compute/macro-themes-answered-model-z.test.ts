/**
 * Macro themes, review round 3 (Analysis tab fix wave 2026-11-15), Z4.
 *
 *  - The cached rows record the model that ANSWERED (`answeredModelId` on the
 *    helper result, non-enumerable), falling back to the resolved id.
 *  - The `noneVerified` result reports `generatedAt` in the same SQLite
 *    `YYYY-MM-DD HH:MM:SS` form as every other branch.
 *
 * No AI call: `generateTextForFeature` and `resolveFeatureModel` are mocked.
 * All text is synthetic.
 */
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
vi.mock("@/lib/compute/factors", () => ({ computeFactorAnalysis: vi.fn(() => ({ tilts: [] })) }));

import { MACRO_THEME_SCOPES, generateMacroThemes } from "@/lib/compute/macro-themes";
import { generateTextForFeature } from "@/lib/ai/generate";

const WEEK = "2026-05-04";
const BODY = "Synthetic body text about markets this week.";
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

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
  return db;
}

const CITED_REPLY = JSON.stringify([{
  name: "Theme one",
  factor_label: "ai_exposure",
  direction: "risk-on",
  summary: "Synthetic summary of a theme for the week.",
  cited_kind: "article", cited_id: 1, cited_read: "mixed", cited_excerpt: BODY,
}]);

function textResult(text: string, answeredModelId?: string) {
  const res = { text, finishReason: "stop" };
  if (answeredModelId) Object.defineProperty(res, "answeredModelId", { value: answeredModelId, enumerable: false });
  return res;
}

const ai = () => vi.mocked(generateTextForFeature);

function modelsUsed(db: Database.Database): string[] {
  return (db.prepare("SELECT DISTINCT model_used FROM analysis_macro_themes WHERE week_of = ?").all(WEEK) as Array<{ model_used: string }>)
    .map((r) => r.model_used);
}

beforeEach(() => {
  ai().mockReset();
});

describe("Z4: macro themes record the model that answered", () => {
  it("stores answeredModelId on every scope's row", async () => {
    const db = seedDb();
    ai().mockResolvedValue(textResult(CITED_REPLY, "claude-haiku-5-5") as never);
    const r = await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(r.themes).toHaveLength(1);
    expect(modelsUsed(db)).toEqual(["claude-haiku-5-5"]);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM analysis_macro_themes WHERE week_of = ?").get(WEEK) as { n: number }).n;
    expect(n).toBe(MACRO_THEME_SCOPES.length);
  });

  it("falls back to the resolved id when the helper reports none", async () => {
    const db = seedDb();
    ai().mockResolvedValue(textResult(CITED_REPLY) as never);
    await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(modelsUsed(db)).toEqual(["test-model"]);
  });

  it("the noneVerified result's generatedAt has the same form as every other branch", async () => {
    const db = seedDb();
    ai().mockResolvedValue(textResult(JSON.stringify([
      { name: "Uncited", factor_label: "ai_exposure", direction: "risk-on", summary: "Synthetic summary of a theme." },
    ])) as never);
    const r = await generateMacroThemes(db, { scope: "all", weekOf: WEEK });
    expect(r.noneVerified).toBe(true);
    expect(r.generatedAt).toMatch(SQL_TIME);

    const ok = seedDb();
    ai().mockResolvedValue(textResult(CITED_REPLY) as never);
    const written = await generateMacroThemes(ok, { scope: "all", weekOf: WEEK });
    expect(written.generatedAt).toMatch(SQL_TIME);
  });
});
