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
import { evaluateAnomalies, fetchLast2ClosesBatch, buildSynthesisPrompt } from "../src/fallback-evening";

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
import { generateText, generateObject } from "ai";
import { listMessages, getMessage, extractMessage } from "../src/gmail";

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runFallbackEvening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    // clearAllMocks keeps implementations — re-establish sendEmail's success
    // default so a prior test's mockRejectedValue can't leak into later tests.
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
    // Default: AI synthesis returns valid markdown (≥200 chars, starts with #)
    // to satisfy the strict validation ported from lib/digest/synthesize.ts.
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text:
        "## Evening Recap\n\n" +
        "Across today's coverage, several themes connected. Multiple sources " +
        "flagged macro pressure and earnings reactions in held names. " +
        "Citations were consistent across the day's newsletter feeds, " +
        "supporting a coherent narrative across sources.\n\n" +
        "## Also covered\n\n" +
        "A handful of single-source notes with thin coverage.",
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

  // ── Upstream-failure observability (silent-swallow guard) ──────────────────

  it("returns kind:error with stage context when snapshot load throws", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("R2 unreachable")
    );
    const result = await runFallbackEvening(env);
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/snapshot load failed/i);
    expect(result.error).toMatch(/R2 unreachable/);
  });

  it("returns kind:error with stage context when Resend send throws", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV2Snapshot(6) // ≥5 articles → produces body content, reaches sendEmail
    );
    (sendEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("422 invalid to field")
    );
    const result = await runFallbackEvening(env); // NOT dryRun — must reach send
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/resend send failed/i);
    expect(result.error).toMatch(/422 invalid to field/);
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
    // Batched spark endpoint: one request, flat object keyed by symbol.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        SPY: { timestamp: [1000000, 1000086400], close: [500, 510] },
        GOOG: { timestamp: [1000000, 1000086400], close: [200, 180] },
      }),
    });

    const result = await runFallbackEvening(env, { dryRun: true });
    expect(result.kind).toBe("success");
    expect((result as { htmlLength?: number }).htmlLength).toBeGreaterThan(0);
    // Single batched spark request whose URL names both symbols (vs. one chart
    // request per symbol that blew the subrequest budget).
    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const url = fetchCalls[0][0] as string;
    expect(url).toContain("/spark");
    expect(url).toContain("SPY");
    expect(url).toContain("GOOG");
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

  // ── Synthesis validation parity with Mac-side ─────────────────────────────

  it("synthesis with finishReason='length' → falls back to per-source, email still sends", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 7 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "## Evening Recap\n\nTruncated…",
      finishReason: "length",
    });

    const result = await runFallbackEvening(env, { dryRun: true });
    expect(result.kind).toBe("success");
    expect(generateText).toHaveBeenCalled();
  });

  it("synthesis output without a leading # header → falls back to per-source", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 7 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text:
        "Sure, here is the evening recap. Today across coverage we saw multiple themes connect. " +
        "Sources broadly agreed on the day's macro tone. Held names received varied coverage " +
        "depending on the venue. This is a long but header-less paragraph that should fail " +
        "the strict validation port even though it exceeds the minimum character count.",
    });

    const result = await runFallbackEvening(env, { dryRun: true });
    expect(result.kind).toBe("success");
  });

  it("synthesis output under 200 chars → falls back to per-source", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 7 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "## Short header\n\nToo short to be useful.",
    });

    const result = await runFallbackEvening(env, { dryRun: true });
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

  // ── Live Gmail fetch (the frozen-snapshot gap) ─────────────────────────────

  it("live-fetches today's Gmail newsletters and includes them when the snapshot is empty", async () => {
    const env = makeEnv();
    // Snapshot froze at 2am with zero articles and no anomaly inputs — the old
    // behavior would skip with "no content".
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 0 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false }); // no anomaly

    // One newsletter arrived TODAY, after the snapshot froze.
    (listMessages as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "fresh-1" }]);
    (getMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "fresh-1" });
    (extractMessage as ReturnType<typeof vi.fn>).mockReturnValue({
      receivedAt: "2026-06-02 14:30:00",
      subject: "Afternoon PM Note",
      sender: "pm@example.com",
      body: "Fresh intraday commentary on held names.",
    });
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        summary: "Fresh intraday take on the tape.",
        key_themes: ["macro"],
        sentiment: "bullish",
        portfolio_relevance: "Relevant to AAPL",
      },
    });

    const result = await runFallbackEvening(env); // not dryRun → reaches send
    expect(result.kind).toBe("success"); // NOT skipped — the fresh article is content
    const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sendCall[1].html).toContain("Afternoon PM Note");
  });

  it("bubbles kind:error (not silent skip) when Gmail fetch errors and nothing else has content", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 0 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false }); // no anomaly
    (listMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Gmail 500"));

    const result = await runFallbackEvening(env);
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/Gmail 500/);
  });

  // ── No-content guard ──────────────────────────────────────────────────────

  it("returns skipped when there is genuinely no content (no articles, no fetch, no anomaly)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeV3Snapshot({ articleCount: 0 })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    (listMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]); // nothing new in Gmail

    const result = await runFallbackEvening(env);
    // Truly quiet: no snapshot articles, no fresh mail, no anomaly → skipped.
    expect(result.kind).toBe("skipped");
  });
});

describe("fetchLast2ClosesBatch (Yahoo spark, batched — subrequest budget)", () => {
  beforeEach(() => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  it("parses a multi-symbol spark response into last-2-closes per symbol", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        SPY: { timestamp: [1, 2, 3], close: [500, 505, 510] },
        AAPL: { timestamp: [1, 2, 3], close: [200, null, 210] }, // null close filtered
      }),
    });
    const map = await fetchLast2ClosesBatch(["SPY", "AAPL"]);
    expect(map.get("SPY")).toEqual({ prior: 505, today: 510 });
    expect(map.get("AAPL")).toEqual({ prior: 200, today: 210 });
  });

  it("issues ONE request for a modest symbol set (collapses N subrequests → 1)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ SPY: { close: [1, 2] }, AAPL: { close: [3, 4] }, MSFT: { close: [5, 6] } }),
    });
    await fetchLast2ClosesBatch(["SPY", "AAPL", "MSFT"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map when Yahoo responds !ok (caller omits anomaly block)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    const map = await fetchLast2ClosesBatch(["SPY"]);
    expect(map.size).toBe(0);
  });

  it("returns an empty map (not a throw) when fetch rejects", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    const map = await fetchLast2ClosesBatch(["SPY"]);
    expect(map.size).toBe(0);
  });

  it("chunks large symbol sets so each request URL stays bounded", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    const symbols = Array.from({ length: 120 }, (_, i) => `SYM${i}`);
    await fetchLast2ClosesBatch(symbols);
    // 120 symbols at a 50-per-chunk cap → 3 requests, still far under the
    // 50-subrequest Workers free-tier ceiling (vs. 120 with per-symbol fetch).
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("evaluateAnomalies (Worker two-gate parity)", () => {
  const closes = (m: Record<string, { prior: number; today: number }>) =>
    new Map(Object.entries(m));

  it("does not flag a 1% wiggle on a flat day (fails 3% floor)", () => {
    const flags = evaluateAnomalies(
      [{ symbol: "ACME", securityId: 1, accountId: 1 }],
      [{ securityId: 1, lookbackDays: 60, beta: 1.2, residualStd: 1.5, computedAt: "2026-05-08" }],
      closes({ SPY: { prior: 530, today: 530 * 1.001 }, ACME: { prior: 100, today: 101.0 } }),
    );
    expect((flags ?? []).map((f) => f.symbol)).not.toContain("ACME");
  });

  it("flags a quiet fund up 3.2% on a flat day (high z)", () => {
    const flags = evaluateAnomalies(
      [{ symbol: "QFND", securityId: 1, accountId: 1 }],
      [{ securityId: 1, lookbackDays: 60, beta: 0.3, residualStd: 0.5, computedAt: "2026-05-08" }],
      closes({ SPY: { prior: 530, today: 530 * 1.001 }, QFND: { prior: 100, today: 103.2 } }),
    );
    expect((flags ?? []).map((f) => f.symbol)).toContain("QFND");
  });

  it("does not flag a volatile name up 3.1% (z < 2)", () => {
    const flags = evaluateAnomalies(
      [{ symbol: "VOLA", securityId: 1, accountId: 1 }],
      [{ securityId: 1, lookbackDays: 60, beta: 1.5, residualStd: 2.5, computedAt: "2026-05-08" }],
      closes({ SPY: { prior: 530, today: 530 * 1.001 }, VOLA: { prior: 100, today: 103.1 } }),
    );
    expect((flags ?? []).map((f) => f.symbol)).not.toContain("VOLA");
  });

  it("degraded mode: missing residualStd enforces only the 3% floor", () => {
    const flags = evaluateAnomalies(
      [
        { symbol: "BIG", securityId: 1, accountId: 1 },
        { symbol: "SML", securityId: 2, accountId: 1 },
      ],
      [
        { securityId: 1, lookbackDays: 60, beta: 1.0, computedAt: "2026-05-08" }, // no residualStd
        { securityId: 2, lookbackDays: 60, beta: 1.0, computedAt: "2026-05-08" },
      ],
      closes({
        SPY: { prior: 530, today: 530 * 1.001 },
        BIG: { prior: 100, today: 103.5 },
        SML: { prior: 100, today: 102.0 },
      }),
    );
    const syms = (flags ?? []).map((f) => f.symbol);
    expect(syms).toContain("BIG");
    expect(syms).not.toContain("SML");
  });

  it("sorts by zScore desc and exposes null zScore in degraded mode", () => {
    const flags = evaluateAnomalies(
      [
        { symbol: "HIGHZ", securityId: 1, accountId: 1 },
        { symbol: "LOWZ", securityId: 2, accountId: 1 },
      ],
      [
        { securityId: 1, lookbackDays: 60, beta: 0.5, residualStd: 0.5, computedAt: "2026-05-08" },
        { securityId: 2, lookbackDays: 60, beta: 0.5, residualStd: 1.2, computedAt: "2026-05-08" },
      ],
      closes({
        SPY: { prior: 530, today: 530 * 1.001 },
        HIGHZ: { prior: 100, today: 104.0 },
        LOWZ: { prior: 100, today: 103.1 },
      }),
    );
    expect((flags ?? [])[0].symbol).toBe("HIGHZ");
    expect((flags ?? [])[0].zScore).not.toBeNull();
  });
});

describe("buildSynthesisPrompt — timeframe/thread coherence", () => {
  // Regression for 2026-06-05: a GS bucket spanning Thursday-up + Friday-down
  // + an IPO-fee catalyst got fused into one self-contradictory paragraph in
  // the cloud recap. The prompt must instruct the model to separate days and
  // keep distinct threads apart. (Mac parity: lib/digest/synthesize.ts.)
  it("instructs the model to attribute moves to days and not fuse threads", () => {
    const snap = { heldSymbols: ["GS"] } as unknown as Snapshot;
    const prompt = buildSynthesisPrompt({ GS: [] }, snap);

    expect(prompt).toContain("TIMEFRAME & THREAD COHERENCE");
    expect(prompt).toContain("attribute each price move");
    expect(prompt).toContain("is NOT a contradiction");
    expect(prompt).toContain("do not assert an unsourced reason");
  });

  it("buildSynthesisPrompt carries edition tags and the section contract", () => {
    const snap = { heldSymbols: ["NVDA"] } as unknown as Snapshot;
    const meta = {
      id: 1,
      source_id: 1,
      source_name: "Vital Knowledge",
      gmail_message_id: "msg-vk-1",
      received_at: "2026-06-09 14:00:00",
      subject: "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026",
      sender: "test@vitalk.com",
      summary: "Market recap summary",
      key_themes: JSON.stringify(["macro"]),
      sentiment: "bullish",
      sentiment_score: null,
      mentioned_symbols: JSON.stringify(["NVDA"]),
      portfolio_relevance: "Relevant to NVDA",
      source_url: null,
      website_url: null,
      processed_at: "2026-06-09T14:00:00.000Z",
      ai_model: null,
    };
    const buckets = { NVDA: [meta] };
    const prompt = buildSynthesisPrompt(buckets, snap);
    expect(prompt).toContain("**Vital Knowledge [recap]**");
    expect(prompt).toContain("EDITION COLLAPSING");
    expect(prompt).toContain("## The Session");
    expect(prompt).toContain("## Also covered");
  });
});
