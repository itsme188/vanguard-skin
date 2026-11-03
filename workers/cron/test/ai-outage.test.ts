/**
 * The Worker's posture during an AI account outage (provider-failover slice 5).
 * Errors come from the REAL SDKs with a stubbed network (the Mac suite's
 * helper), so the classifier sees what production sees.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateObject: generateObjectMock }));

vi.mock("../src/ai", () => ({
  getModelForFeature: vi.fn(() => "mock-model"),
  structuredOutputProviderOptions: () => ({}),
  generateWithFailover: vi.fn(),
}));
vi.mock("../src/gmail", async (orig) => ({
  ...(await orig<typeof import("../src/gmail")>()),
  getAccessToken: vi.fn(async () => "token"),
  listMessages: vi.fn(async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }]),
  getMessage: vi.fn(async () => ({})),
  extractMessage: vi.fn((m: unknown) => ({
    messageId: "x",
    receivedAt: "2026-05-11 10:00:00",
    subject: "S",
    sender: "feed@example.com",
    body: "A".repeat(300),
    html: null,
    _m: m,
  })),
}));
vi.mock("../src/resend", () => ({ sendEmail: vi.fn(async () => ({ id: "mock-email" })) }));
vi.mock("../src/state", async (orig) => ({ ...(await orig<typeof import("../src/state")>()), loadLatestSnapshot: vi.fn() }));

import { generateWithFailover } from "../src/ai";
import { loadLatestSnapshot } from "../src/state";
import {
  accountFailureOf,
  getAiOutage,
  recordAiOutage,
  aiUnavailableReason,
  AI_OUTAGE_KEY,
} from "../src/ai-outage";
import { fetchAndProcessNewArticles, runFallbackDigest } from "../src/fallback-digest";
import { runFallbackBriefing } from "../src/fallback-briefing";
import { runNewsletterFetch } from "../src/newsletter-fetch";
import { sendEmail } from "../src/resend";
import { listMessages, getMessage } from "../src/gmail";
import {
  ANTHROPIC_FAILURES,
  errorFromRealSdk,
} from "@/tests/helpers/ai-sdk-real-errors";

async function realError(respond: () => Response): Promise<unknown> {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  generateObjectMock.mockImplementation(actual.generateObject as never);
  try {
    return (await errorFromRealSdk(respond, { maxRetries: 0 })).error;
  } finally {
    generateObjectMock.mockReset();
  }
}

interface Kv {
  store: Map<string, string>;
  puts: { key: string; ttl?: number }[];
}
function makeKV(seed: Record<string, string> = {}): KVNamespace & Kv {
  const store = new Map<string, string>(Object.entries(seed));
  const puts: Kv["puts"] = [];
  return {
    store,
    puts,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store.set(k, v);
      puts.push({ key: k, ttl: o?.expirationTtl });
    }),
    delete: vi.fn(async (k: string) => void store.delete(k)),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace & Kv;
}

const SOURCE = {
  id: 1, name: "Test Source", sender_email: "feed@example.com", sender_pattern: null, subject_pattern: null,
  is_active: 1, fetch_frequency: "daily", max_age_days: 7, processing_prompt: null, website_url: null,
};
function snapshot(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4, snapshotDate: "2026-05-11", generatedAt: "2026-05-11T02:00:00Z", heldSymbols: ["AAPL"],
    settings: { digest_email_recipients: "a@example.com", briefing_email_recipients: "a@example.com" },
    calendarEvents: [], researchSources: [SOURCE], recentArticlesMeta: [], deepReadArticles: [], ...over,
  } as never;
}
const ARTICLE = {
  object: { summary: "ok", key_themes: [], sentiment: "neutral", sentiment_score: 0, mentioned_symbols: [], portfolio_relevance: "", is_portfolio_relevant: true },
};

beforeEach(() => {
  vi.mocked(generateWithFailover).mockReset();
  vi.mocked(loadLatestSnapshot).mockReset();
  vi.mocked(sendEmail).mockClear();
  vi.mocked(getMessage).mockClear();
  vi.mocked(listMessages).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("accountFailureOf (the shared classifier vocabulary)", () => {
  it.each([
    ["billing", ANTHROPIC_FAILURES.billing400, "billing"],
    ["spend limit", ANTHROPIC_FAILURES.spendLimit400, "billing"],
    ["rejected key", ANTHROPIC_FAILURES.auth401, "auth"],
    ["rate limit", ANTHROPIC_FAILURES.rateLimit429, "rate_limit"],
    ["overloaded", ANTHROPIC_FAILURES.overloaded529, "outage"],
  ] as const)("%s -> %s", async (_n, respond, kind) => {
    expect(accountFailureOf(await realError(respond))).toBe(kind);
  });

  it("an article-level or unknown error is null", async () => {
    expect(accountFailureOf(await realError(ANTHROPIC_FAILURES.promptTooLong400))).toBeNull();
    expect(accountFailureOf(new Error("boom"))).toBeNull();
  });

  it("the Worker's own missing-key message is left as it was (not an account outage)", () => {
    expect(accountFailureOf(new Error("ANTHROPIC_API_KEY missing (feature: fallbackBriefing)"))).toBeNull();
  });
});

describe("the marker", () => {
  it("persistent kinds live 30 min, transient 5 min; the first `since` is kept", async () => {
    const kv = makeKV();
    await recordAiOutage(kv, "billing");
    expect(kv.puts[0]).toMatchObject({ key: AI_OUTAGE_KEY, ttl: 1800 });
    const first = await getAiOutage(kv);
    await recordAiOutage(kv, "rate_limit");
    expect(kv.puts[1].ttl).toBe(300);
    expect((await getAiOutage(kv))?.since).toBe(first?.since);
    expect((await getAiOutage(kv))?.kind).toBe("rate_limit");
  });

  it("garbage is no outage, and a KV failure never throws", async () => {
    expect(await getAiOutage(makeKV({ [AI_OUTAGE_KEY]: "nope" }))).toBeNull();
    const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } as unknown as KVNamespace;
    await expect(recordAiOutage(broken, "billing")).resolves.toBeUndefined();
  });
});

describe("newsletter fetch parks on an account outage", () => {
  const deps = (analyze: () => Promise<never>) => ({
    loadSnapshot: async () => snapshot(),
    getAccessToken: async () => "t",
    listMessages: async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    getMessage: async () => ({}),
    extractMessage: () => ({ messageId: "x", receivedAt: "2026-05-11 10:00:00", subject: "S", sender: "f", body: "A".repeat(300), html: null }),
    analyzeArticle: analyze as never,
  });

  it("a billing failure stops at the FIRST article (not one doomed call per article) and says so", async () => {
    const err = await realError(ANTHROPIC_FAILURES.billing400);
    const analyze = vi.fn(async () => { throw err; });
    const kv = makeKV();
    const r = await runNewsletterFetch({ CRON_KV: kv, ARCHIVE: {} } as never, deps(analyze as never));
    expect(r.kind).toBe("ai_unavailable");
    expect(r.reason).toBe(aiUnavailableReason("billing"));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((await getAiOutage(kv))?.kind).toBe("billing");
  });

  it("while the marker is live it does no Gmail or model work at all", async () => {
    const kv = makeKV();
    await recordAiOutage(kv, "billing");
    const load = vi.fn(async () => snapshot());
    const analyze = vi.fn();
    const r = await runNewsletterFetch({ CRON_KV: kv, ARCHIVE: {} } as never, { ...deps(analyze as never), loadSnapshot: load });
    expect(r.kind).toBe("ai_unavailable");
    expect(load).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("an article-level failure does NOT park: the next article is still tried", async () => {
    const bad = await realError(ANTHROPIC_FAILURES.promptTooLong400);
    const analyze = vi.fn().mockRejectedValueOnce(bad).mockResolvedValue({
      summary: "s", key_themes: [], sentiment: "neutral", sentiment_score: 0, mentioned_symbols: [], portfolio_relevance: "", is_portfolio_relevant: true,
    });
    const kv = makeKV();
    const r = await runNewsletterFetch({ CRON_KV: kv, ARCHIVE: {} } as never, deps(analyze as never));
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(r.kind).toBe("success");
    expect(await getAiOutage(kv)).toBeNull();
  });
});

describe("digest / evening shared article loop", () => {
  const env = () => ({ CRON_KV: makeKV(), ARCHIVE: {}, RESEND_API_KEY: "k", RESEND_FROM_DOMAIN: "example.com" } as never);

  it("stops at the first account-level failure and notes the outage", async () => {
    vi.mocked(generateWithFailover).mockRejectedValue(await realError(ANTHROPIC_FAILURES.billing400));
    const e = env() as { CRON_KV: KVNamespace };
    const r = await fetchAndProcessNewArticles(e as never, snapshot());
    expect(r.aiUnavailable).toBe("billing");
    expect(generateWithFailover).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect((await getAiOutage(e.CRON_KV))?.kind).toBe("billing");
  });

  it("an article-level failure keeps going; the happy path is unchanged", async () => {
    vi.mocked(generateWithFailover)
      .mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.promptTooLong400))
      .mockResolvedValue(ARTICLE as never);
    const r = await fetchAndProcessNewArticles(env(), snapshot());
    expect(r.aiUnavailable).toBeUndefined();
    expect(r.articleErrors).toBe(1);
    expect(r.processed).toHaveLength(2);
  });

  it("a Gmail failure is never read as an AI outage", async () => {
    vi.mocked(getMessage).mockRejectedValueOnce(new Error("fetch failed"));
    vi.mocked(generateWithFailover).mockResolvedValue(ARTICLE as never);
    const e = env() as { CRON_KV: KVNamespace };
    const r = await fetchAndProcessNewArticles(e as never, snapshot());
    expect(r.aiUnavailable).toBeUndefined();
    expect(await getAiOutage(e.CRON_KV)).toBeNull();
  });

  it("digest with nothing to send and a dead account reports ai_unavailable, not a generic error", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshot());
    vi.mocked(generateWithFailover).mockRejectedValue(await realError(ANTHROPIC_FAILURES.billing400));
    const r = await runFallbackDigest(env());
    expect(r.kind).toBe("ai_unavailable");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("briefing", () => {
  it("an account-level failure returns ai_unavailable (no email, outage noted); other failures stay errors", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshot());
    const kv = makeKV();
    const e = { CRON_KV: kv, ARCHIVE: {}, RESEND_API_KEY: "k", RESEND_FROM_DOMAIN: "example.com", BRIEFING_EMAIL_TO: "a@example.com" } as never;
    vi.mocked(generateWithFailover).mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.billing400));
    const r = await runFallbackBriefing(e);
    expect(r.kind).toBe("ai_unavailable");
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await getAiOutage(kv))?.kind).toBe("billing");

    vi.mocked(generateWithFailover).mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.promptTooLong400));
    const r2 = await runFallbackBriefing(e);
    expect(r2.kind).toBe("error");
  });
});
