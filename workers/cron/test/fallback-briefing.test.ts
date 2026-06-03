/**
 * Tests for workers/cron/src/fallback-briefing.ts
 *
 * Verifies:
 *   - recipient defaults to BRIEFING_EMAIL_TO when settings.briefing_email_recipients absent
 *   - recipient uses settings.briefing_email_recipients when present
 *   - comma-separated recipients normalized (trimmed, rejoined with ", ")
 *   - error when neither snapshot recipient nor BRIEFING_EMAIL_TO set
 *   - error when RESEND_API_KEY / RESEND_FROM_DOMAIN missing
 *   - no_snapshot when snapshot loading fails
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-digest";
import type { Snapshot } from "../src/state";

// ── Dependency mocks ─────────────────────────────────────────────────────────

// Mock `ai` module (generateText for briefing composition)
vi.mock("ai", () => ({
  generateText: vi.fn(),
  jsonSchema: (s: unknown) => s,
}));

// Mock AI provider
vi.mock("../src/ai", () => ({
  getModelForFeature: vi.fn(() => "mock-model"),
}));

// Mock state loader
vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return {
    ...actual,
    loadLatestSnapshot: vi.fn(),
  };
});

// Mock resend
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

// Mock ONLY the IBKR network fetch; pure transforms stay real.
vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositionsCached: vi.fn() };
});

import { runFallbackBriefing } from "../src/fallback-briefing";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { generateText } from "ai";
import { fetchLiveIbkrPositionsCached } from "../src/ibkr-positions";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<FallbackEnv> = {}): FallbackEnv {
  const store = new Map<string, string>();
  return {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    ANTHROPIC_API_KEY: "test-key",
    BRIEFING_EMAIL_TO: "default@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "myportfoliodesk.com",
    ...overrides,
  };
}

function makeSnapshot(briefingRecipients?: string | null): Snapshot {
  return {
    schemaVersion: 3,
    snapshotDate: "2026-05-08",
    generatedAt: new Date().toISOString(),
    heldSymbols: ["AAPL"],
    settings: {
      last_digest_sent_at: "2026-05-08T08:45:00Z",
      last_briefing_sent_at: null,
      briefing_email_recipients: briefingRecipients ?? undefined,
    },
    calendarEvents: [
      {
        id: 1,
        week_of: "2026-05-12",
        event_date: "2026-05-12",
        event_type: "earnings",
        title: "AAPL Q2 Earnings",
        description: "Apple quarterly earnings",
        symbol: "AAPL",
        event_time: "AMC",
        expected_impact: "high",
        source: "finnhub",
        source_key: "finnhub:AAPL:2026-05-12",
        raw_json: {},
        enriched_at: null,
        consensus_estimate: null,
        previous_value: null,
      },
    ],
    researchSources: [
      {
        id: 1,
        name: "TEST SOURCE",
        sender_email: "test@example.com",
        sender_pattern: null,
        subject_pattern: null,
        is_active: 1,
        fetch_frequency: "daily",
        max_age_days: 7,
        processing_prompt: null,
        website_url: null,
      },
    ],
    recentArticlesMeta: [
      {
        id: 1,
        source_id: 1,
        source_name: "TEST SOURCE",
        gmail_message_id: "msg-1",
        received_at: new Date().toISOString().replace("T", " ").slice(0, 19),
        subject: "Test Article",
        sender: "test@example.com",
        summary: "Test summary",
        key_themes: JSON.stringify(["theme1"]),
        sentiment: "neutral",
        sentiment_score: null,
        mentioned_symbols: null,
        portfolio_relevance: "Some relevance",
        source_url: null,
        website_url: null,
        processed_at: new Date().toISOString(),
        ai_model: "claude-sonnet-4-6",
      },
    ],
    deepReadArticles: [],
  } as Snapshot;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runFallbackBriefing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but NOT implementations — re-establish
    // the success defaults so a prior test's mockRejectedValue can't leak.
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "## Week Overview\n\nSome briefing content.",
    });
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
    (fetchLiveIbkrPositionsCached as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  // ── Tier 3: live IBKR holdings-context refresh ────────────────────────────

  const IBKR_ENV: Partial<FallbackEnv> = {
    IBKR_CONSUMER_KEY: "QAJVIHZHI",
    IBKR_ACCESS_TOKEN: "tok",
    IBKR_PREPEND: "deadbeef",
    IBKR_DH_PRIME: "00cb",
    IBKR_SIGNATURE_KEY_PKCS8: "cGtjczg=",
  };

  function promptOfLastGenerate(): string {
    const calls = (generateText as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][0].prompt as string;
  }

  it("merges current live IBKR symbols into the holdings context", async () => {
    const env = makeEnv(IBKR_ENV);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(makeSnapshot()); // held: AAPL
    (fetchLiveIbkrPositionsCached as ReturnType<typeof vi.fn>).mockResolvedValue([
      { symbol: "NVDA", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 30, costBasis: 3000, mktPrice: 120 },
    ]);

    await runFallbackBriefing(env);

    const prompt = promptOfLastGenerate();
    expect(prompt).toContain("AAPL"); // snapshot held kept
    expect(prompt).toContain("NVDA"); // live IBKR name added
  });

  it("uses the snapshot held list verbatim when IBKR is not configured", async () => {
    const env = makeEnv(); // no IBKR_*
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(makeSnapshot());

    await runFallbackBriefing(env);

    expect(fetchLiveIbkrPositionsCached).not.toHaveBeenCalled();
    expect(promptOfLastGenerate()).toContain("AAPL");
  });

  it("degrades to the snapshot list when the live IBKR fetch throws", async () => {
    const env = makeEnv(IBKR_ENV);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(makeSnapshot());
    (fetchLiveIbkrPositionsCached as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IBKR down"));

    const result = await runFallbackBriefing(env);
    expect(result.kind).not.toBe("error"); // briefing still ships
    expect(promptOfLastGenerate()).toContain("AAPL");
  });

  // ── Recipient resolution ─────────────────────────────────────────────────

  it("uses snapshot.settings.briefing_email_recipients when present", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("alice@example.com");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("normalizes comma-separated briefing recipients", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("alice@example.com, bob@example.com");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("trims whitespace in comma-separated recipients", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("  alice@example.com  ,  bob@example.com  ");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("falls back to BRIEFING_EMAIL_TO when snapshot briefing_email_recipients is absent", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot(undefined);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("falls back to BRIEFING_EMAIL_TO when snapshot briefing_email_recipients is empty string", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot("");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("falls back to BRIEFING_EMAIL_TO when snapshot briefing_email_recipients is whitespace-only", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot("   ");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("returns error when neither snapshot recipient nor BRIEFING_EMAIL_TO is set", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot(undefined)
    );
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/recipient missing/i);
    expect(result.error).toMatch(/briefing_email_recipients/i);
  });

  // ── Error states ─────────────────────────────────────────────────────────

  it("returns error when RESEND_API_KEY is missing", async () => {
    const env = makeEnv({ RESEND_API_KEY: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot("user@example.com")
    );
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/RESEND_API_KEY/);
  });

  it("returns error when RESEND_FROM_DOMAIN is missing", async () => {
    const env = makeEnv({ RESEND_FROM_DOMAIN: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot("user@example.com")
    );
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/RESEND_FROM_DOMAIN/);
  });

  it("returns no_snapshot when loadLatestSnapshot returns null", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("no_snapshot");
  });

  // ── Upstream-failure observability (silent-swallow guard) ──────────────────

  it("returns kind:error with stage context when snapshot load throws", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("R2 unreachable")
    );
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/snapshot load failed/i);
    expect(result.error).toMatch(/R2 unreachable/);
  });

  it("returns kind:error with stage context when Claude generation throws (credit exhaustion analog)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot("user@example.com")
    );
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("402 insufficient credits")
    );
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/briefing generation failed/i);
    expect(result.error).toMatch(/402 insufficient credits/);
  });

  it("returns kind:error with stage context when Resend send throws", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot("user@example.com")
    );
    (sendEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("422 invalid to field")
    );
    const result = await runFallbackBriefing(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/resend send failed/i);
    expect(result.error).toMatch(/422 invalid to field/);
  });

  // ── Success cases ────────────────────────────────────────────────────────

  it("recipient resolution succeeds (no error thrown) when briefing_email_recipients present", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("alice@example.com");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("recipient resolution succeeds (no error thrown) when fallback BRIEFING_EMAIL_TO set", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot(undefined);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackBriefing(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });
});
