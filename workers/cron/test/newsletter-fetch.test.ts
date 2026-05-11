/**
 * Tests for cloud-side newsletter ingestion fallback.
 *
 * Same shape as level-scan tests: DI seam for snapshot / Gmail / Claude;
 * fake KV namespace mirrors real KV semantics for prefix-list + put +
 * delete. The Claude pass is replaced with a deterministic stub so the
 * assertions stay pure.
 */

import { describe, it, expect } from "vitest";
import {
  runNewsletterFetch,
  shouldRunNewsletterFetch,
  type ArticleAnalysis,
} from "../src/newsletter-fetch";
import type { Snapshot } from "../src/state";

interface FakeKV {
  store: Map<string, string>;
  get: KVNamespace["get"];
  put: KVNamespace["put"];
  delete: KVNamespace["delete"];
  list: KVNamespace["list"];
}

function makeKV(seed: Record<string, string> = {}): FakeKV {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: (async (k: string) => store.get(k) ?? null) as any,
    put: (async (k: string, v: string) => {
      store.set(k, v);
    }) as any,
    delete: (async (k: string) => {
      store.delete(k);
    }) as any,
    list: (async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    }) as any,
  };
}

function makeSnapshot(opts: {
  sources?: Snapshot["researchSources"];
  recentMeta?: Snapshot["recentArticlesMeta"];
} = {}): Snapshot {
  return {
    schemaVersion: 4,
    snapshotDate: "2026-05-11",
    generatedAt: "2026-05-11T02:00:00Z",
    heldSymbols: ["AAPL"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [],
    researchSources: opts.sources ?? [],
    recentArticlesMeta: opts.recentMeta ?? [],
    deepReadArticles: [],
  };
}

function makeSource(overrides: Partial<Snapshot["researchSources"][number]> = {}): Snapshot["researchSources"][number] {
  return {
    id: 1,
    name: "Test Source",
    sender_email: "feed@example.com",
    sender_pattern: null,
    subject_pattern: null,
    is_active: 1,
    fetch_frequency: "daily",
    max_age_days: 7,
    processing_prompt: null,
    website_url: null,
    ...overrides,
  };
}

function makeEnv(seed: Record<string, string> = {}) {
  const kv = makeKV(seed);
  const env: any = { CRON_KV: kv, ARCHIVE: {} };
  return { env, kv };
}

const RELEVANT: ArticleAnalysis = {
  summary: "Macro tilt analysis",
  key_themes: ["fed policy"],
  sentiment: "bearish",
  sentiment_score: -0.2,
  mentioned_symbols: ["AAPL"],
  portfolio_relevance: "Direct AAPL exposure",
  is_portfolio_relevant: true,
};

const OFF_TOPIC: ArticleAnalysis = {
  summary: "Crypto sideline piece",
  key_themes: ["doge"],
  sentiment: "neutral",
  sentiment_score: 0,
  mentioned_symbols: [],
  portfolio_relevance: "No connection",
  is_portfolio_relevant: false,
};

function detail(messageId: string) {
  return {
    messageId,
    receivedAt: "2026-05-11 10:00:00",
    subject: `Subject ${messageId}`,
    sender: "feed@example.com",
    body: "A".repeat(500),
    html: null,
  };
}

describe("shouldRunNewsletterFetch", () => {
  it("fires only at minute=0 within ET 06:00-20:59", () => {
    expect(shouldRunNewsletterFetch(6, 0)).toBe(true);
    expect(shouldRunNewsletterFetch(12, 0)).toBe(true);
    expect(shouldRunNewsletterFetch(20, 0)).toBe(true);
    expect(shouldRunNewsletterFetch(21, 0)).toBe(false);
    expect(shouldRunNewsletterFetch(5, 0)).toBe(false);
    expect(shouldRunNewsletterFetch(12, 15)).toBe(false);
    expect(shouldRunNewsletterFetch(12, 30)).toBe(false);
    expect(shouldRunNewsletterFetch(12, 45)).toBe(false);
  });
});

describe("runNewsletterFetch — gating", () => {
  it("skips when mac-recent-newsletter-sync marker is present", async () => {
    const { env } = makeEnv({ "mac-recent-newsletter-sync": "2026-05-11T10:00:00Z" });
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () => makeSnapshot({ sources: [makeSource()] }),
      getAccessToken: async () => "token",
      listMessages: async () => [{ id: "m1" }],
      getMessage: async () => ({}),
      extractMessage: () => detail("m1"),
      analyzeArticle: async () => RELEVANT,
    });
    expect(result.kind).toBe("skipped");
  });

  it("returns no_snapshot when R2 has no state file", async () => {
    const { env } = makeEnv();
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () => null,
      getAccessToken: async () => "token",
      listMessages: async () => [],
      getMessage: async () => ({}),
      extractMessage: () => null,
      analyzeArticle: async () => RELEVANT,
    });
    expect(result.kind).toBe("no_snapshot");
  });

  it("returns no_articles when all sources return zero messages", async () => {
    const { env } = makeEnv();
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () => makeSnapshot({ sources: [makeSource()] }),
      getAccessToken: async () => "token",
      listMessages: async () => [],
      getMessage: async () => ({}),
      extractMessage: () => null,
      analyzeArticle: async () => RELEVANT,
    });
    expect(result.kind).toBe("no_articles");
  });
});

describe("runNewsletterFetch — KV writes", () => {
  it("writes one cloud-fetched-newsletter-* per processed message", async () => {
    const { env, kv } = makeEnv();
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () =>
        makeSnapshot({ sources: [makeSource()] }),
      getAccessToken: async () => "token",
      listMessages: async () => [{ id: "m1" }, { id: "m2" }],
      getMessage: async () => ({}),
      extractMessage: (msg: any) => {
        // alternate ids by stuffing the input — works because we control both ends
        const idx = kv.store.size;
        return detail(idx === 0 ? "m1" : "m2");
      },
      analyzeArticle: async () => RELEVANT,
    });

    expect(result.kind).toBe("success");
    expect(result.fetched).toBe(2);
    const keys = Array.from(kv.store.keys()).filter((k) =>
      k.startsWith("cloud-fetched-newsletter-"),
    );
    expect(keys).toHaveLength(2);
    const payload = JSON.parse(kv.store.get(keys[0])!);
    expect(payload.summary).toBe("Macro tilt analysis");
    expect(payload.is_portfolio_relevant).toBe(true);
    expect(payload.fetched_by).toBe("cloud");
  });

  it("dedups against snapshot.recentArticlesMeta (already-ingested)", async () => {
    const { env, kv } = makeEnv();
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () =>
        makeSnapshot({
          sources: [makeSource()],
          recentMeta: [
            {
              id: 1,
              source_id: 1,
              source_name: "Test Source",
              gmail_message_id: "m1",
              received_at: "2026-05-11 10:00:00",
              subject: "Already in DB",
              sender: "x",
              summary: null,
              key_themes: null,
              sentiment: null,
              sentiment_score: null,
              mentioned_symbols: null,
              portfolio_relevance: null,
              source_url: null,
              website_url: null,
              processed_at: "2026-05-11 10:30:00",
              ai_model: null,
            },
          ],
        }),
      getAccessToken: async () => "token",
      listMessages: async () => [{ id: "m1" }],
      getMessage: async () => ({}),
      extractMessage: () => detail("m1"),
      analyzeArticle: async () => RELEVANT,
    });

    expect(result.kind).toBe("no_articles");
    expect(Array.from(kv.store.keys())).toHaveLength(0);
  });

  it("dedups against existing cloud-fetched-newsletter-* KV entries (cross-tick safety)", async () => {
    const { env, kv } = makeEnv({
      "cloud-fetched-newsletter-m1": JSON.stringify({ stub: true }),
    });
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () => makeSnapshot({ sources: [makeSource()] }),
      getAccessToken: async () => "token",
      listMessages: async () => [{ id: "m1" }],
      getMessage: async () => ({}),
      extractMessage: () => detail("m1"),
      analyzeArticle: async () => RELEVANT,
    });

    expect(result.kind).toBe("no_articles");
    // Existing KV entry is preserved, no new one written
    expect(Array.from(kv.store.keys())).toEqual(["cloud-fetched-newsletter-m1"]);
  });

  it("persists is_portfolio_relevant=false payloads (Mac applies the D3 gate during reconcile)", async () => {
    const { env, kv } = makeEnv();
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () => makeSnapshot({ sources: [makeSource()] }),
      getAccessToken: async () => "token",
      listMessages: async () => [{ id: "m1" }],
      getMessage: async () => ({}),
      extractMessage: () => detail("m1"),
      analyzeArticle: async () => OFF_TOPIC,
    });

    expect(result.kind).toBe("success");
    const payload = JSON.parse(kv.store.get("cloud-fetched-newsletter-m1")!);
    expect(payload.is_portfolio_relevant).toBe(false);
    expect(payload.portfolio_relevance).toBe("No connection");
  });

  it("skips a source whose listMessages throws and continues with the next source", async () => {
    const { env, kv } = makeEnv();
    let callCount = 0;
    const result = await runNewsletterFetch(env, {
      loadSnapshot: async () =>
        makeSnapshot({
          sources: [
            makeSource({ id: 1, name: "Broken", sender_email: "a@x" }),
            makeSource({ id: 2, name: "Working", sender_email: "b@x" }),
          ],
        }),
      getAccessToken: async () => "token",
      listMessages: async (_t, query) => {
        callCount++;
        if (query.includes("a@x")) throw new Error("Gmail 500");
        return [{ id: "mb" }];
      },
      getMessage: async () => ({}),
      extractMessage: () => detail("mb"),
      analyzeArticle: async () => RELEVANT,
    });

    expect(result.kind).toBe("success");
    expect(result.fetched).toBe(1);
    expect(callCount).toBe(2);
    const keys = Array.from(kv.store.keys()).filter((k) => k.startsWith("cloud-fetched-newsletter-"));
    expect(keys).toEqual(["cloud-fetched-newsletter-mb"]);
  });
});
