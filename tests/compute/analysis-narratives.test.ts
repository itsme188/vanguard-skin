import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertNarrative } from "@/lib/queries/analysis-narratives";
import {
  generateNarrative,
  NARRATIVE_SURFACES,
} from "@/lib/compute/analysis-narratives";
import { generateTextForFeature } from "@/lib/ai/generate";

// Mock generateTextForFeature so tests don't burn real Sonnet calls when
// ANTHROPIC_API_KEY is loaded into the env (e.g. via .env.local). Without
// this mock the "forceRegen bypasses cache" test would race the 5s vitest
// timeout against a real network round-trip.
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn().mockRejectedValue(
    new Error("generateTextForFeature mocked off in tests")
  ),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(feature: string, modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6-20250219" })),
}));

describe("generateNarrative", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("returns cached narrative when present (no AI call)", async () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Cached prose.",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = await generateNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
    });
    expect(r.narrativeMd).toBe("Cached prose.");
    expect(r.fromCache).toBe(true);
  });

  it("rejects unknown surfaceKey at the boundary", async () => {
    await expect(
      generateNarrative(db, {
        scope: "vanguard",
        surfaceKey: "bogus",
        weekOf: "2026-05-04",
      })
    ).rejects.toThrow(/unknown surface/i);
  });

  it("exports the 5 expected surface keys", () => {
    expect(NARRATIVE_SURFACES).toEqual([
      "factor-analysis",
      "risk-metrics",
      "position-risk",
      "factor-heatmap",
      "defense",
    ]);
  });

  it("forceRegen=true should bypass cache (re-throws since AI not mocked)", async () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Cached prose.",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    // forceRegen skips the cache → tries to call Sonnet → no API key in test env
    // → throws. We just want to confirm the cache was bypassed (i.e. the call
    // did NOT short-circuit at the cache hit).
    await expect(
      generateNarrative(db, {
        scope: "vanguard",
        surfaceKey: "factor-analysis",
        weekOf: "2026-05-04",
        forceRegen: true,
      })
    ).rejects.toThrow(); // any error type — point is, it didn't return cached
  });
});

describe("buildContextForSurface multi-account fidelity (via generateNarrative)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    // Start from a known account set (migrations may seed defaults).
    db.exec("DELETE FROM accounts");
    // Two Vanguard accounts → resolveScope("vanguard") returns BOTH ids.
    db.exec(
      "INSERT INTO accounts (id, name) VALUES (1, 'Vanguard Taxable'), (2, 'Vanguard Brokerage')"
    );
    // AAPL held in acct 1; NVDA held ONLY in acct 2 (the account the old
    // firstAccountId code silently dropped).
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple'), (2, 'NVDA', 'Nvidia')");
    db.exec("INSERT INTO security_factors (security_id, ai_exposure) VALUES (1, 'High'), (2, 'High')");
    const today = new Date().toISOString().slice(0, 10);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (2, 2, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 100, 'test')").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 100, 'test')").run(today);
  });

  it("includes account-2-only holdings in the context and drops the old preamble", async () => {
    let capturedPrompt = "";
    vi.mocked(generateTextForFeature).mockImplementationOnce(async (_feature, args) => {
      const p = args.prompt;
      capturedPrompt = typeof p === "string" ? p : "";
      return { text: "The portfolio carries meaningful AI exposure across names." } as never;
    });

    await generateNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      forceRegen: true,
    });

    // NVDA lives only in account 2 — its presence proves the context spans the
    // full account set, not just the first id.
    expect(capturedPrompt).toContain("NVDA");
    expect(capturedPrompt).toContain("AAPL");
    // The cosmetic "primary account only" hedge is gone now that data is real.
    expect(capturedPrompt).not.toMatch(/multiple accounts/i);
  });
});
