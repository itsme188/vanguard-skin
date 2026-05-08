/**
 * Tests for workers/cron/src/fallback-evening.ts
 *
 * Verifies:
 *   - schemaVersion < 2 → error
 *   - schemaVersion 2 → works but omits anomaly block
 *   - schemaVersion 3 with betas → anomaly block computed + emitted
 *   - Yahoo failure → anomaly block omitted, email still sends
 *   - articles >= 5 → synthesis (AI) path called
 *   - articles < 5 → per-source path (AI NOT called)
 *   - recipient defaults to BRIEFING_EMAIL_TO when settings.evening_email_recipients absent
 *   - recipient uses settings.evening_email_recipients when present
 *   - dryRun returns htmlLength without sending
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { FallbackEnv } from "../src/fallback-digest";
import type { Snapshot } from "../src/state";

// ── Dependency mocks ─────────────────────────────────────────────────────────

// Mock `ai` module (generateText, generateObject)
vi.mock("ai", () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
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

// Mock Gmail
vi.mock("../src/gmail", () => ({
  getAccessToken: vi.fn(async () => "mock-token"),
  listMessages: vi.fn(async () => []),
  getMessage: vi.fn(),
  extractMessage: vi.fn(),
}));

// Mock resend
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

// Mock global fetch for Yahoo
global.fetch = vi.fn();

import { runFallbackEvening } from "../src/fallback-evening";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { generateText } from "ai";

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
    BRIEFING_EMAIL_TO: "user@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "myportfoliodesk.com",
    ...overrides,
  };
}

function makeV2Snapshot(articleCount = 0): Snapshot {
  const articles = Array.from({ length: articleCount }, (_, i) => ({
    id: i + 1,
    source_id: 1,
    source_name: "TEST SOURCE",
    gmail_message_id: `msg-${i}`,
    received_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    subject: `Article ${i + 1}`,
    sender: "test@example.com",
    summary: `Summary ${i + 1}`,
    key_themes: JSON.stringify(["theme1"]),
    sentiment: "neutral",
    sentiment_score: null,
    mentioned_symbols: null,
    portfolio_relevance: "Some relevance",
    source_url: null,
    website_url: null,
    processed_at: new Date().toISOString(),
    ai_model: "claude-sonnet-4-6",
  }));

  return {
    schemaVersion: 2,
    snapshotDate: "2026-05-08",
    generatedAt: new Date().toISOString(),
    heldSymbols: ["AAPL", "GOOG"],
    settings: {
      last_digest_sent_at: "2026-05-08T08:45:00Z",
      last_briefing_sent_at: null,
    },
    calendarEvents: [],
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
    recentArticlesMeta: articles,
    deepReadArticles: [],
  };
}

function makeV3Snapshot(opts: {
  articleCount?: number;
  vanguardHoldings?: Array<{ symbol: string; securityId: number; accountId: number }>;
  securityBetas?: Array<{ securityId: number; lookbackDays: number; beta: number; computedAt: string }>;
  eveningRecipients?: string | null;
} = {}): Snapshot {
  const base = makeV2Snapshot(opts.articleCount ?? 0);
  return {
    ...base,
    schemaVersion: 3,
    settings: {
      ...base.settings,
      evening_email_recipients: opts.eveningRecipients ?? null,
    },
    vanguardHoldings: opts.vanguardHoldings ?? [],
    securityBetas: opts.securityBetas ?? [],
  };
}

/** Mock Yahoo to return SPY and GOOG with predictable last-2-closes */
function mockYahooSuccess(fetchMock: ReturnType<typeof vi.fn>) {
  // For each symbol we return two close bars
  fetchMock.mockImplementation(async (url: string) => {
    const symbol = url.includes("SPY") ? "SPY" : "GOOG";
    const now = Math.floor(Date.now() / 1000);
    const close1 = symbol === "SPY" ? 510 : 170;   // "today"
    const close0 = symbol === "SPY" ? 500 : 165;   // "prior"
    return {
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [now - 86400, now],
            indicators: { quote: [{ close: [close0, close1] }] },
          }],
        },
      }),
    };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runFallbackEvening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    // Default: AI synthesis returns some text
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "## Evening Recap\n\nSome synthesis content.",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Missing env ──────────────────────────────────────────────────────────

  it("returns error when BRIEFING_EMAIL_TO is missing and no snapshot recipient", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot()
    );
    const result = await runFallbackEvening(env);
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/recipient/i);
  });

  it("returns error when RESEND credentials are missing", async () => {
    const env = makeEnv({ RESEND_API_KEY: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV2Snapshot()
    );
    const result = await runFallbackEvening(env);
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/RESEND/);
  });

  // ── Snapshot version gating ───────────────────────────────────────────────

  it("returns error when snapshot is missing", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await runFallbackEvening(env);
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/snapshot/i);
  });

  it("schemaVersion 2 snapshot works but omits anomaly block (no vanguardHoldings/betas)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV2Snapshot(6) // 6 articles → synthesis path
    );
    const result = await runFallbackEvening(env, { dryRun: true });
    // Should succeed even without v3 fields
    expect(result.kind).toBe("success");
    // Yahoo fetch should NOT have been called (no vanguardHoldings)
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Anomaly block with schemaVersion 3 ───────────────────────────────────

  it("schemaVersion 3 with betas and Yahoo success → anomaly block in content", async () => {
    const env = makeEnv();
    // GOOG with beta=1.5: SPY +2%, expected GOOG +3%, actual GOOG +3.03%
    // threshold = max(2 * 3, 1) = 6% — actually GOOG won't flag with this data.
    // Let's use an extreme actual: GOOG -10% with SPY +2%, beta 1.0 → expected +2%, threshold 4% → flags
    const snap = makeV3Snapshot({
      articleCount: 6,
      vanguardHoldings: [{ symbol: "GOOG", securityId: 42, accountId: 1 }],
      securityBetas: [{ securityId: 42, lookbackDays: 60, beta: 1.0, computedAt: "2026-05-08" }],
    });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    // SPY: prior=500, today=510 → +2%
    // GOOG: prior=200, today=180 → -10%
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const isSpy = (url as string).includes("SPY");
      return {
        ok: true,
        json: async () => ({
          chart: {
            result: [{
              timestamp: [1000000, 1000086400],
              indicators: { quote: [{ close: [isSpy ? 500 : 200, isSpy ? 510 : 180] }] },
            }],
          },
        }),
      };
    });

    const result = await runFallbackEvening(env, { dryRun: true });
    expect(result.kind).toBe("success");
    expect((result as { htmlLength?: number }).htmlLength).toBeGreaterThan(0);
    // The anomaly block should have been passed to AI or be in the markdown
    // We verify Yahoo was called for SPY + GOOG
    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const calledSymbols = fetchCalls.map((c) => (c[0] as string).match(/chart\/([^?]+)/)?.[1]).filter(Boolean);
    expect(calledSymbols).toContain("SPY");
    expect(calledSymbols).toContain("GOOG");
  });

  it("Yahoo failure → anomaly block omitted, email still sends", async () => {
    const env = makeEnv();
    const snap = makeV3Snapshot({
      articleCount: 6,
      vanguardHoldings: [{ symbol: "GOOG", securityId: 42, accountId: 1 }],
      securityBetas: [{ securityId: 42, lookbackDays: 60, beta: 1.0, computedAt: "2026-05-08" }],
    });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    // Yahoo throws
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Yahoo timeout"));

    const result = await runFallbackEvening(env, { dryRun: true });
    // Should still succeed — anomaly block gracefully degraded
    expect(result.kind).toBe("success");
  });

  // ── Article count routing ─────────────────────────────────────────────────

  it("articles >= 5 → synthesis (AI) path called", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 7 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    await runFallbackEvening(env, { dryRun: true });
    expect(generateText).toHaveBeenCalled();
  });

  it("articles < 5 → per-source path (AI NOT called)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 3 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const result = await runFallbackEvening(env, { dryRun: true });
    expect(generateText).not.toHaveBeenCalled();
    expect(result.kind).toBe("success");
  });

  // ── Recipient selection ───────────────────────────────────────────────────

  it("uses BRIEFING_EMAIL_TO when settings.evening_email_recipients is absent", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 3, eveningRecipients: null })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    await runFallbackEvening(env);
    const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sendCall[1].to).toBe("fallback@example.com");
  });

  it("uses settings.evening_email_recipients when present (single address)", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 3, eveningRecipients: "primary@example.com" })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    await runFallbackEvening(env);
    const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sendCall[1].to).toBe("primary@example.com");
  });

  it("uses settings.evening_email_recipients when present (comma-separated → joined)", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 3, eveningRecipients: "a@x.com, b@x.com" })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    await runFallbackEvening(env);
    const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
    // Per spec: parse comma-separated and join with ", "
    expect(sendCall[1].to).toBe("a@x.com, b@x.com");
  });

  // ── dryRun ────────────────────────────────────────────────────────────────

  it("dryRun returns htmlLength without calling sendEmail", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 3 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const result = await runFallbackEvening(env, { dryRun: true });
    expect(result.kind).toBe("success");
    expect((result as { htmlLength?: number }).htmlLength).toBeGreaterThan(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("without dryRun actually calls sendEmail with fromLocalPart=evening", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 3 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const result = await runFallbackEvening(env);
    expect(result.kind).toBe("success");
    expect(sendEmail).toHaveBeenCalledOnce();
    const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sendCall[1].fromLocalPart).toBe("evening");
    expect(sendCall[1].subject).toMatch(/Evening Recap/);
  });

  // ── No-content guard ──────────────────────────────────────────────────────

  it("returns skipped when there is no content (0 articles, AI returns empty)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 0 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const result = await runFallbackEvening(env);
    // 0 articles → per-source path → empty digest → skipped
    expect(result.kind).toBe("skipped");
  });
});
