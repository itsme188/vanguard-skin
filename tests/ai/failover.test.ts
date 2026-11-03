/**
 * Provider failover executor (design slice 2, §4/§8): parity-before-eligibility
 * tests. Errors come from the REAL SDKs with a stubbed network
 * (tests/helpers/ai-sdk-real-errors.ts), so the classifier sees what
 * production sees. Only `generateText` / `generateObject` are mocked.
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

import { generateTextForFeature, generateObjectForFeature } from "@/lib/ai/generate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import {
  FAILOVER_ELIGIBLE_CEILING,
  FAILOVER_ENABLED_DEFAULT,
  FAILOVER_PARKED,
  setFailoverEnabledSource,
  setFailoverRecorder,
  failoverTargets,
  type FailoverEvent,
} from "@/lib/ai/failover";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import {
  ANTHROPIC_FAILURES,
  OPENAI_FAILURES,
  errorFromRealSdk,
  errorFromRealOpenAiSdk,
} from "../helpers/ai-sdk-real-errors";

const ENABLED: FeatureKey[] = ["newsletterProcessing", "chat", "printWatchFirstPass"];

let events: FailoverEvent[] = [];

beforeEach(() => {
  generateTextMock.mockReset();
  generateObjectMock.mockReset();
  events = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-not-real");
  // No gateway, no Workers AI: that leg must stay inert.
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
  vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "");
  setFeatureModelOverrideSource(null);
  setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  setFailoverEnabledSource(() => new Set(ENABLED));
  setFailoverRecorder((e) => events.push(e));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setFailoverEnabledSource(null);
  setFailoverRecorder(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * The error helpers drive the REAL generateObject; this file mocks it, so each
 * helper call runs with the mock delegating to the real function, then the
 * mock is cleared again.
 */
async function realError(
  make: () => Promise<{ error: unknown }>,
): Promise<unknown> {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  generateObjectMock.mockImplementation(actual.generateObject as never);
  try {
    return (await make()).error;
  } finally {
    generateObjectMock.mockReset();
  }
}
const anthropicError = (respond: () => Response, ) =>
  realError(() => errorFromRealSdk(respond, { maxRetries: 0 }));
const openAiError = (respond: () => Response) =>
  realError(() => errorFromRealOpenAiSdk(respond, { maxRetries: 0 }));
const creditError = () => anthropicError(ANTHROPIC_FAILURES.billing400);

describe("failover policy tables", () => {
  it("the rollout ships empty: no live path changes until a feature is flipped", () => {
    expect(FAILOVER_ENABLED_DEFAULT.size).toBe(0);
  });

  it("no parked feature is in the eligible ceiling", () => {
    for (const f of FAILOVER_PARKED) expect(FAILOVER_ELIGIBLE_CEILING.has(f)).toBe(false);
  });

  it("fallback legs follow anthropic → openai → workers-ai at the feature's tier", () => {
    expect(failoverTargets("newsletterProcessing")).toEqual([
      { provider: "openai", modelId: "gpt-6.1-sol" },
      { provider: "workers-ai", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    ]);
    expect(failoverTargets("chat")[0]).toEqual({ provider: "openai", modelId: "gpt-6-astra" });
  });
});

describe("(a) account-level Anthropic failure on an eligible feature is served by OpenAI", () => {
  it("text path: billing on Anthropic → OpenAI answers, switch recorded", async () => {
    generateTextMock
      .mockRejectedValueOnce(await creditError())
      .mockResolvedValueOnce({ text: "from openai", finishReason: "stop" });
    const r = await generateTextForFeature("newsletterProcessing", { prompt: "hi" });
    expect(r.text).toBe("from openai");
    expect(generateTextMock.mock.calls[1][0].model.provider).toMatch(/openai/);
    expect(generateTextMock.mock.calls[1][0].model.modelId).toBe("gpt-6.1-sol");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      feature: "newsletterProcessing",
      from: { provider: "anthropic" },
      to: { provider: "openai", modelId: "gpt-6.1-sol" },
      kind: "billing",
    });
  });

  it("object path: a rejected key (auth) → OpenAI answers", async () => {
    const authErr = await anthropicError(ANTHROPIC_FAILURES.auth401);
    generateObjectMock
      .mockRejectedValueOnce(authErr)
      .mockResolvedValueOnce({ object: { summary: "ok" } });
    const r = await generateObjectForFeature("chat", { prompt: "hi", schema: {} as never });
    expect(r.object).toEqual({ summary: "ok" });
    expect(generateObjectMock.mock.calls[1][0].model.modelId).toBe("gpt-6-astra");
    expect(events[0].kind).toBe("auth");
  });

  it("a missing Anthropic key (config) also fails over", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    generateTextMock.mockResolvedValueOnce({ text: "from openai", finishReason: "stop" });
    const r = await generateTextForFeature("newsletterProcessing", { prompt: "hi" });
    expect(r.text).toBe("from openai");
    expect(events[0].kind).toBe("config");
  });

  it("the Workers AI leg is inert while the gateway is unconfigured: OpenAI serves, nothing throws", async () => {
    generateTextMock
      .mockRejectedValueOnce(await creditError())
      .mockResolvedValueOnce({ text: "ok", finishReason: "stop" });
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).resolves.toBeTruthy();
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("OpenAI also dead (billing) → the next leg is tried when configured", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "tok");
    const openAiDead = await openAiError(OPENAI_FAILURES.creditBalanceExhausted429);
    generateTextMock
      .mockRejectedValueOnce(await creditError())
      .mockRejectedValueOnce(openAiDead)
      .mockResolvedValueOnce({ text: "from cloudflare", finishReason: "stop" });
    const r = await generateTextForFeature("newsletterProcessing", { prompt: "x" });
    expect(r.text).toBe("from cloudflare");
    expect(events[0].to.provider).toBe("workers-ai");
  });
});

describe("(b) a non-account error does not switch", () => {
  it.each([
    ["rate limit", ANTHROPIC_FAILURES.rateLimit429],
    ["overloaded", ANTHROPIC_FAILURES.overloaded529],
    ["server error", ANTHROPIC_FAILURES.apiError500],
    ["bad request", ANTHROPIC_FAILURES.promptTooLong400],
  ] as const)("%s rethrows the original error, no second call", async (_n, respond) => {
    const err = await anthropicError(respond);
    generateTextMock.mockRejectedValueOnce(err);
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).rejects.toBe(err);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("a refusal does not switch", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "", finishReason: "content-filter" });
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).rejects.toMatchObject({
      name: "AIRefusalError",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("(c) parked and non-enabled features never switch", () => {
  it.each([...FAILOVER_PARKED])("%s: billing error is rethrown, no fallback call", async (feature) => {
    // Enable everything, including the parked names: the ceiling must still hold.
    setFailoverEnabledSource(() => new Set<FeatureKey>([...FAILOVER_PARKED, ...FAILOVER_ELIGIBLE_CEILING]));
    // alertSuggestion's own route is the Cloudflare leg: configure it so the
    // primary model builds and the mocked call is what fails.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "tok");
    const err = await creditError();
    generateTextMock.mockRejectedValueOnce(err);
    await expect(generateTextForFeature(feature, { prompt: "x" })).rejects.toBe(err);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("an eligible feature that is not in the rollout set stays put", async () => {
    const err = await creditError();
    generateTextMock.mockRejectedValueOnce(err);
    await expect(generateTextForFeature("briefing", { prompt: "x" })).rejects.toBe(err);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("with the shipped default rollout nothing switches", async () => {
    setFailoverEnabledSource(null);
    const err = await creditError();
    generateTextMock.mockRejectedValueOnce(err);
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).rejects.toBe(err);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("(d) every provider down parks exactly as today", () => {
  it("rethrows the ORIGINAL Anthropic error, each leg tried at most once", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "tok");
    const primary = await creditError();
    const openAiDead = await openAiError(OPENAI_FAILURES.invalidApiKey401);
    const cfDead = await openAiError(OPENAI_FAILURES.creditBalanceExhausted429);
    generateTextMock
      .mockRejectedValueOnce(primary)
      .mockRejectedValueOnce(openAiDead)
      .mockRejectedValueOnce(cfDead);
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).rejects.toBe(primary);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(0);
  });

  it("OpenAI unconfigured and the gateway unconfigured: original error, one call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const primary = await creditError();
    generateTextMock.mockRejectedValueOnce(primary);
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).rejects.toBe(primary);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("a request-level failure on the fallback also parks on the original error", async () => {
    const primary = await creditError();
    const badReq = await anthropicError(ANTHROPIC_FAILURES.promptTooLong400);
    generateTextMock.mockRejectedValueOnce(primary).mockRejectedValueOnce(badReq);
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).rejects.toBe(primary);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("a failing recorder never fails a served call", async () => {
    setFailoverRecorder(() => {
      throw new Error("db gone");
    });
    generateTextMock
      .mockRejectedValueOnce(await creditError())
      .mockResolvedValueOnce({ text: "ok", finishReason: "stop" });
    await expect(generateTextForFeature("newsletterProcessing", { prompt: "x" })).resolves.toMatchObject({ text: "ok" });
  });
});
