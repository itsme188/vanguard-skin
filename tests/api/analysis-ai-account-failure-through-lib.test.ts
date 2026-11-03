/**
 * [qa:dashboard-analysis-narrative-cards-diagnostics-defense-refresh-to-regenerate-macro-this-week-generate-this-wee-regression-1]
 *
 * The earlier fix (tests/api/analysis-ai-account-failure.test.ts) mocked
 * generateNarrative / generateMacroThemes themselves to throw the provider's
 * error, so it never saw what the REAL lib functions throw: each re-wrapped
 * the provider failure in a new Error with no `cause`, and `accountFailureOf`
 * in the route could no longer tell an out-of-credit account from any other
 * failure. Live, both routes still answered 500 (the narrative body carrying
 * the raw provider sentence and a model family) and the cards invited a retry.
 *
 * Here the lib functions are REAL; only the AI seam (`generateTextForFeature`,
 * `resolveFeatureModel`) is mocked, and it throws the error the real AI SDK
 * builds for Anthropic's out-of-credit answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { aiUnavailableReason } from "@/lib/earnings/ai-unavailable";
import {
  ANTHROPIC_FAILURES,
  CREDIT_BALANCE_MESSAGE,
  errorFromRealSdk,
} from "@/tests/helpers/ai-sdk-real-errors";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import { generateTextForFeature } from "@/lib/ai/generate";
import {
  POST as narrativePOST,
  __resetRateLimitForTests,
} from "@/app/api/analysis/narrative/route";
import {
  POST as macroPOST,
  __resetMacroRegenLimitForTests,
} from "@/app/api/analysis/macro-themes/route";

let creditError: unknown;

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Enough signal for the macro generator to reach the AI call: two relevant
  // articles received now (inside any theme week's 7-day look-back).
  db.prepare(
    "INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO research_articles
       (id, source_id, subject, sender, raw_text, received_at, processed_at, summary, sentiment, mentioned_symbols, is_relevant)
     VALUES (?, 1, ?, 't@test.com', ?, datetime('now'), datetime('now'), ?, 'mixed', '[]', 1)`,
  );
  insert.run(1, "Rates week in review", "Yields ended the week flat.", "Treasury yields ended the week roughly flat.");
  insert.run(2, "Positioning note", "Positioning looks light.", "Positioning looks light ahead of the next release.");
  return db;
}

beforeEach(async () => {
  hoisted.db = seedDb();
  __resetRateLimitForTests();
  __resetMacroRegenLimitForTests();
  creditError ??= (await errorFromRealSdk(ANTHROPIC_FAILURES.billing400, { maxRetries: 0 })).error;
  vi.mocked(generateTextForFeature).mockReset();
  vi.mocked(generateTextForFeature).mockRejectedValue(creditError);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function narrativeReq(surface: string) {
  return new Request("http://x/api/analysis/narrative", {
    method: "POST",
    body: JSON.stringify({ scope: "all", surface }),
    headers: { "Content-Type": "application/json" },
  }) as never;
}

function macroReq(scope: string) {
  return new Request("http://localhost/api/analysis/macro-themes", {
    method: "POST",
    body: JSON.stringify({ scope }),
    headers: { "Content-Type": "application/json" },
  }) as unknown as NextRequest;
}

describe("an out-of-credit account through the REAL narrative generator", () => {
  for (const surface of ["position-risk", "defense"]) {
    it(`${surface}: answers 503 ai_account with the shared sentence`, async () => {
      const res = await narrativePOST(narrativeReq(surface));
      expect(vi.mocked(generateTextForFeature)).toHaveBeenCalled();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ success: false, error: aiUnavailableReason("billing"), reason: "ai_account" });
      const text = JSON.stringify(body);
      expect(text).not.toContain(CREDIT_BALANCE_MESSAGE);
      expect(text).not.toMatch(/Sonnet|Opus|Haiku|claude-/i);
    });
  }

  it("any other failure keeps a 500 but never echoes provider text or a model family", async () => {
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(generateTextForFeature).mockRejectedValue(new Error("raw vendor text 529 overloaded"));
    const res = await narrativePOST(narrativeReq("position-risk"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/raw vendor text|Sonnet|Opus|Haiku|claude-/i);
  });
});

describe("an out-of-credit account through the REAL macro-themes generator", () => {
  it("answers 503 ai_account with the shared sentence, never 'try again in a few minutes'", async () => {
    const res = await macroPOST(macroReq("ibkr"));
    expect(vi.mocked(generateTextForFeature)).toHaveBeenCalled();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: aiUnavailableReason("billing"), reason: "ai_account" });
    expect(body.error).not.toMatch(/few minutes|credit balance/);
  });
});
