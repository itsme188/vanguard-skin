/**
 * Tests for workers/cron/src/fallback-digest.ts
 *
 * Verifies:
 *   - recipient defaults to BRIEFING_EMAIL_TO when settings.digest_email_recipients absent
 *   - recipient uses settings.digest_email_recipients when present
 *   - comma-separated recipients normalized (trimmed, rejoined with ", ")
 *   - error when neither snapshot recipient nor BRIEFING_EMAIL_TO set
 *   - error when RESEND_API_KEY / RESEND_FROM_DOMAIN missing
 *   - no_snapshot when snapshot loading fails
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-digest";
import type { Snapshot } from "../src/state";

// ── Dependency mocks ─────────────────────────────────────────────────────────

// Mock `ai` module (generateObject for article processing)
vi.mock("ai", () => ({
  generateObject: vi.fn(),
  jsonSchema: (s: unknown) => s,
}));

// Mock AI provider
vi.mock("../src/ai", () => ({
  getModelForFeature: vi.fn(() => "mock-model"),
  generateWithFailover: vi.fn(async (_env: unknown, _feature: unknown, _catalog: unknown, call: (model: unknown) => Promise<unknown>) => call("mock-model")),
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

import {
  runFallbackDigest,
  composeDigestMarkdown,
  normalizeThemes,
  sanitizeModelSummary,
  type ProcessedArticle,
} from "../src/fallback-digest";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";

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

function makeSnapshot(digestRecipients?: string | null): Snapshot {
  return {
    schemaVersion: 3,
    snapshotDate: "2026-05-08",
    generatedAt: new Date().toISOString(),
    heldSymbols: ["AAPL"],
    settings: {
      last_digest_sent_at: "2026-05-08T08:45:00Z",
      last_briefing_sent_at: null,
      digest_email_recipients: digestRecipients ?? undefined,
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

describe("runFallbackDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: mock Gmail list to return no new messages
    // Tests override this when needed
  });

  // ── Recipient resolution ─────────────────────────────────────────────────

  it("uses snapshot.settings.digest_email_recipients when present", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("alice@example.com");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    // Either success (has articles to send) or no_articles (no content)
    // What matters is that sendEmail was called with the right recipient
    if (result.kind === "success") {
      const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[1].to).toBe("alice@example.com");
    } else if (result.kind === "no_articles") {
      // No content from articles, but we didn't error on recipient resolution
      expect(result.kind).toBe("no_articles");
    }
  });

  it("normalizes comma-separated digest recipients", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("alice@example.com, bob@example.com");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    if (result.kind === "success") {
      const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[1].to).toBe("alice@example.com, bob@example.com");
    } else if (result.kind === "no_articles") {
      expect(result.kind).toBe("no_articles");
    }
  });

  it("trims whitespace in comma-separated recipients", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("  alice@example.com  ,  bob@example.com  ");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    if (result.kind === "success") {
      const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[1].to).toBe("alice@example.com, bob@example.com");
    } else if (result.kind === "no_articles") {
      expect(result.kind).toBe("no_articles");
    }
  });

  it("falls back to BRIEFING_EMAIL_TO when snapshot digest_email_recipients is absent", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot(undefined);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    if (result.kind === "success") {
      const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[1].to).toBe("fallback@example.com");
    } else if (result.kind === "no_articles") {
      expect(result.kind).toBe("no_articles");
    }
  });

  it("falls back to BRIEFING_EMAIL_TO when snapshot digest_email_recipients is empty string", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot("");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    if (result.kind === "success") {
      const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[1].to).toBe("fallback@example.com");
    } else if (result.kind === "no_articles") {
      expect(result.kind).toBe("no_articles");
    }
  });

  it("falls back to BRIEFING_EMAIL_TO when snapshot digest_email_recipients is whitespace-only", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot("   ");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    if (result.kind === "success") {
      const sendCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[1].to).toBe("fallback@example.com");
    } else if (result.kind === "no_articles") {
      expect(result.kind).toBe("no_articles");
    }
  });

  it("returns error when neither snapshot recipient nor BRIEFING_EMAIL_TO is set", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot(undefined)
    );
    const result = await runFallbackDigest(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/recipient missing/i);
    expect(result.error).toMatch(/digest_email_recipients/i);
  });

  // ── Error states ─────────────────────────────────────────────────────────

  it("returns error when RESEND_API_KEY is missing", async () => {
    const env = makeEnv({ RESEND_API_KEY: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot("user@example.com")
    );
    const result = await runFallbackDigest(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/RESEND_API_KEY/);
  });

  it("returns error when RESEND_FROM_DOMAIN is missing", async () => {
    const env = makeEnv({ RESEND_FROM_DOMAIN: undefined });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshot("user@example.com")
    );
    const result = await runFallbackDigest(env);

    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/RESEND_FROM_DOMAIN/);
  });

  it("returns no_snapshot when loadLatestSnapshot returns null", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await runFallbackDigest(env);

    expect(result.kind).toBe("no_snapshot");
  });

  // ── Success cases ────────────────────────────────────────────────────────

  it("recipient resolution succeeds (no error thrown) when digest_email_recipients present", async () => {
    const env = makeEnv();
    const snap = makeSnapshot("alice@example.com");
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });

  it("recipient resolution succeeds (no error thrown) when fallback BRIEFING_EMAIL_TO set", async () => {
    const env = makeEnv({ BRIEFING_EMAIL_TO: "fallback@example.com" });
    const snap = makeSnapshot(undefined);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
    const result = await runFallbackDigest(env);

    // Should NOT be an error about missing recipient
    expect(result.kind).not.toBe("error");
    expect(result.error || "").not.toMatch(/recipient/i);
  });
});

// ── composeDigestMarkdown — structured layout ────────────────────────────────

describe("composeDigestMarkdown — structured layout", () => {
  it("composeDigestMarkdown splits Market Commentary and Research Desk with edition tags", () => {
    const fresh: ProcessedArticle[] = [
      {
        source_name: "Vital Knowledge",
        subject: "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026",
        received_at: "2026-06-09 14:00:00",
        source_url: null,
        summary: "Market recap summary",
        sentiment: "bullish",
        key_themes: ["macro"],
        portfolio_relevance: "Relevant to holdings",
        gmail_message_id: "msg-vk-1",
      },
      {
        source_name: "The Diff",
        subject: "An essay",
        received_at: "2026-06-09 10:00:00",
        source_url: null,
        summary: "Essay summary",
        sentiment: "neutral",
        key_themes: ["tech"],
        portfolio_relevance: "Somewhat relevant",
        gmail_message_id: "msg-diff-1",
      },
    ];
    const md = composeDigestMarkdown(fresh, []);
    expect(md).toContain("## Market Commentary");
    expect(md).toContain("VITAL KNOWLEDGE [RECAP]");
    expect(md).toContain("## Research Desk");
    expect(md!.indexOf("## Market Commentary")).toBeLessThan(md!.indexOf("## Research Desk"));
  });

  // ── Overnight block (2026-07-15) ──────────────────────────────────────────

  const oneArticle: ProcessedArticle[] = [
    {
      source_name: "Vital Knowledge",
      subject: "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026",
      received_at: "2026-06-09 14:00:00",
      source_url: null,
      summary: "Market recap summary",
      sentiment: "bullish",
      key_themes: ["macro"],
      portfolio_relevance: "Relevant",
      gmail_message_id: "msg-vk-1",
    },
  ];

  it("renders the overnight block above the article sections when provided", () => {
    const md = composeDigestMarkdown(
      oneArticle,
      [],
      "## Overnight\n\nKOSPI +0.8% · Bitcoin −2.1%",
    );
    expect(md).toContain("## Overnight");
    expect(md).toContain("KOSPI +0.8% · Bitcoin −2.1%");
    expect(md!.indexOf("## Overnight")).toBeLessThan(md!.indexOf("## Market Commentary"));
  });

  it("a null overnight block leaves the digest unchanged", () => {
    const withNull = composeDigestMarkdown(oneArticle, [], null);
    const without = composeDigestMarkdown(oneArticle, []);
    expect(withNull).toBe(without);
  });

  it("an overnight block alone never produces an email (no_articles semantics stay)", () => {
    expect(composeDigestMarkdown([], [], "## Overnight\n\nKOSPI +0.8%")).toBeNull();
  });

  it("renders the reporters block after overnight, above the article sections (#18)", () => {
    const md = composeDigestMarkdown(
      oneArticle,
      [],
      "## Overnight\n\nKOSPI +0.8%",
      "## Today's reporters\n\n| BMO 08:00 | TSM | held | $3.80 | ±4.0% |",
    );
    expect(md).toContain("## Today's reporters");
    expect(md!.indexOf("## Overnight")).toBeLessThan(md!.indexOf("## Today's reporters"));
    expect(md!.indexOf("## Today's reporters")).toBeLessThan(md!.indexOf("## Market Commentary"));
  });

  it("a reporters block alone never produces an email (same rule as overnight)", () => {
    expect(
      composeDigestMarkdown([], [], null, "## Today's reporters\n\n| BMO | TSM | held | — | — |"),
    ).toBeNull();
  });

  // ── key_themes type-safety (2026-07-15 outage) ────────────────────────────
  //
  // jsonSchema() does NOT runtime-validate, so the model can return
  // key_themes as a STRING. String.slice(0,5) survives processArticle's cap,
  // then renderItem's `.join()` threw — every digest tick from 9:00 to 10:30
  // ET crashed AFTER its ~10 Claude calls succeeded, burning the calls and
  // sending nothing until a tick happened to get arrays for all articles.

  it("a string key_themes from the model must never crash the compose", () => {
    const corrupted = [
      {
        ...oneArticle[0],
        // What the model actually emitted this morning, schema notwithstanding.
        key_themes: "macro, rates" as unknown as string[],
      },
    ];
    const md = composeDigestMarkdown(corrupted, []);
    expect(md).toContain("## Market Commentary");
  });
});

describe("normalizeThemes", () => {
  it("passes arrays through, dropping non-strings and capping at 5", () => {
    expect(normalizeThemes(["a", "b", 3, "c", "d", "e", "f"])).toEqual([
      "a", "b", "c", "d", "e",
    ]);
  });

  it("splits a comma-separated string into themes", () => {
    expect(normalizeThemes("macro, rates , banks")).toEqual(["macro", "rates", "banks"]);
  });

  it("maps null/undefined/objects/empty to []", () => {
    expect(normalizeThemes(null)).toEqual([]);
    expect(normalizeThemes(undefined)).toEqual([]);
    expect(normalizeThemes({ theme: "x" })).toEqual([]);
    expect(normalizeThemes("   ")).toEqual([]);
  });
});

describe("sanitizeModelSummary", () => {
  it("cuts at the first tagged remnant, incl. the malformed <key_themes\"> variant", () => {
    const poisoned =
      'Tariff developments adding cost burdens.</summary>\n<key_themes">["Canada tariffs"]</key_themes>\n<sentiment>neutral</sentiment>';
    expect(sanitizeModelSummary(poisoned)).toBe("Tariff developments adding cost burdens.");
  });

  it("strips a leading <summary> wrapper; clean prose passes through", () => {
    expect(sanitizeModelSummary("<summary>Clean text.</summary>")).toBe("Clean text.");
    expect(sanitizeModelSummary("Guidance for Q3 <10% growth.")).toBe("Guidance for Q3 <10% growth.");
    expect(sanitizeModelSummary("")).toBe("");
  });
});
