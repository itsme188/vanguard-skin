/**
 * Cross-provider failover is unchanged by "always the latest model of each
 * class" (owner condition, 2026-11-12): "when I run out of API credits for
 * Anthropic models, we should automatically switch over to my OpenAI API
 * credits." The new resolver only decides WHICH Anthropic id a tier names
 * and where a not-found inside the Anthropic ladder goes (the next class,
 * never an older version of the same class). An account-level Anthropic
 * failure must still reach the OpenAI leg, from the primary call and from
 * the reactive retry alike, and must not be swallowed or redirected inside
 * the Anthropic ladder. Errors come from the REAL SDKs with a stubbed
 * network (tests/helpers/ai-sdk-real-errors.ts); only generateText /
 * generateObject are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { generateTextMock, generateObjectMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  generateObjectMock: vi.fn(),
}));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: generateTextMock,
  generateObject: generateObjectMock,
}));

import { generateTextForFeature } from "@/lib/ai/generate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { setFailoverEnabledSource, setFailoverRecorder, type FailoverEvent } from "@/lib/ai/failover";
import { PROVIDER_TIER_MODELS } from "@/lib/ai/model-tiers";
import { ANTHROPIC_FAILURES, errorFromRealSdk } from "../helpers/ai-sdk-real-errors";

/** Every generation still served, the way /v1/models lists them. */
const CATALOG = [
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-5-5",
  "claude-haiku-4-5-20251001",
];

let events: FailoverEvent[] = [];

beforeEach(() => {
  generateTextMock.mockReset();
  generateObjectMock.mockReset();
  events = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-not-real");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
  vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "");
  setFeatureModelOverrideSource(null);
  // Re-registering also clears any model a previous test dropped.
  setModelCatalogSource(() => CATALOG);
  setFailoverEnabledSource(() => new Set(["newsletterProcessing", "printWatchFirstPass", "chat"] as const));
  setFailoverRecorder((e) => events.push(e));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setFailoverEnabledSource(null);
  setFailoverRecorder(null);
  setModelCatalogSource(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function realError(respond: () => Response): Promise<unknown> {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  generateObjectMock.mockImplementation(actual.generateObject as never);
  try {
    return (await errorFromRealSdk(respond, { maxRetries: 0 })).error;
  } finally {
    generateObjectMock.mockReset();
  }
}

const modelOf = (i: number) => generateTextMock.mock.calls[i][0].model as { provider: string; modelId: string };

describe("credits run out on Anthropic: still served by OpenAI", () => {
  it.each([
    ["newsletterProcessing", "workhorse", "claude-sonnet-5-5"],
    ["printWatchFirstPass", "frontier", "claude-opus-5-5"],
  ] as const)("%s: primary is the current %s id; a billing error goes straight to OpenAI", async (feature, tier, primary) => {
    generateTextMock
      .mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.billing400))
      .mockResolvedValueOnce({ text: "from openai", finishReason: "stop" });

    const r = await generateTextForFeature(feature, { prompt: "hi" });

    expect(r.text).toBe("from openai");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(modelOf(0).modelId).toBe(primary);
    expect(modelOf(1).provider).toMatch(/openai/);
    expect(modelOf(1).modelId).toBe(PROVIDER_TIER_MODELS.openai[tier]);
    expect(events).toEqual([
      expect.objectContaining({
        feature,
        from: { provider: "anthropic", modelId: primary },
        to: { provider: "openai", modelId: PROVIDER_TIER_MODELS.openai[tier] },
        kind: "billing",
      }),
    ]);
  });

  it("a billing error is not treated as a missing model: no second Anthropic id is tried", async () => {
    generateTextMock
      .mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.billing400))
      .mockResolvedValueOnce({ text: "from openai", finishReason: "stop" });
    await generateTextForFeature("newsletterProcessing", { prompt: "hi" });
    const anthropicCalls = generateTextMock.mock.calls.filter((c) => /anthropic/.test(String(c[0].model.provider)));
    expect(anthropicCalls).toHaveLength(1);
  });
});

describe("the newest model is missing: next class inside Anthropic, never an older version", () => {
  it("not_found on Sonnet 5.5 retries on Haiku 5.5, not Sonnet 5 or 4.6, and no provider switch", async () => {
    generateTextMock
      .mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.notFound404))
      .mockResolvedValueOnce({ text: "from haiku", finishReason: "stop" });

    const r = await generateTextForFeature("newsletterProcessing", { prompt: "hi" });

    expect(r.text).toBe("from haiku");
    expect(modelOf(0).modelId).toBe("claude-sonnet-5-5");
    expect(modelOf(1).modelId).toBe("claude-haiku-5-5");
    expect(events).toHaveLength(0);
  });

  it("credits run out on that retry: the account failure still reaches OpenAI", async () => {
    generateTextMock
      .mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.notFound404))
      .mockRejectedValueOnce(await realError(ANTHROPIC_FAILURES.billing400))
      .mockResolvedValueOnce({ text: "from openai", finishReason: "stop" });

    const r = await generateTextForFeature("newsletterProcessing", { prompt: "hi" });

    expect(r.text).toBe("from openai");
    expect(modelOf(1).modelId).toBe("claude-haiku-5-5");
    expect(modelOf(2).provider).toMatch(/openai/);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("billing");
  });
});
