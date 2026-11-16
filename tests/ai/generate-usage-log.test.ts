/**
 * The content-free usage line and the answering model id on the feature
 * helpers (Analysis AI plumbing, 2026-11-15).
 *
 * Every completed call through generateTextForFeature / generateObjectForFeature
 * writes ONE `[ai-usage]` line: feature, the model that answered, token counts,
 * finish reason and duration. Never prompt text, reply text or a figure from
 * the request. The result also carries `answeredModelId`, so a caller can
 * record the model that answered after a failover instead of the one first
 * resolved. Only `generateText` / `generateObject` are mocked (the provider
 * seam the other tests in tests/ai use).
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

import { NoObjectGeneratedError } from "ai";
import {
  generateTextForFeature,
  generateObjectForFeature,
  formatAiUsageLine,
  AI_USAGE_LINE_PREFIX,
  AIRefusalError,
} from "@/lib/ai/generate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

class FakeNotFound extends Error {
  statusCode = 404;
  constructor() {
    super("model not_found");
  }
}

const SECRET_PROMPT = "PROMPT-TEXT-ZZA holds 12345 shares";
const SECRET_REPLY = "REPLY-TEXT-ZZB is a growth name";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning?: number) {
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input - cacheRead - cacheWrite, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    outputTokens: output,
    outputTokenDetails: { textTokens: output - (reasoning ?? 0), reasoningTokens: reasoning },
    totalTokens: input + output,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

function usageLines(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c: unknown[]) => c[0])
    .filter((l: unknown): l is string => typeof l === "string" && l.startsWith(AI_USAGE_LINE_PREFIX))
    .map((l: string) => JSON.parse(l.slice(AI_USAGE_LINE_PREFIX.length)) as Record<string, unknown>);
}

function everyLoggedString(): string {
  return [...logSpy.mock.calls, ...(console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls]
    .flat()
    .map((x) => String(x))
    .join("\n");
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  generateTextMock.mockReset();
  generateObjectMock.mockReset();
  setFeatureModelOverrideSource(null);
  setModelCatalogSource(() => ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateTextForFeature usage line", () => {
  it("writes one allowlisted line per completed call, with no prompt or reply text", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: SECRET_REPLY,
      finishReason: "stop",
      usage: usage(1000, 200, 300, 50, 120),
      response: { modelId: "claude-sonnet-5-5" },
    });
    await generateTextForFeature("analysisFactorNarrative", { prompt: SECRET_PROMPT, maxOutputTokens: 100 });
    const lines = usageLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.kind).toBe("text");
    expect(line.feature).toBe("analysisFactorNarrative");
    expect(line.model).toBe("claude-sonnet-5-5");
    expect(line.input).toBe(1000);
    expect(line.noCache).toBe(650);
    expect(line.cacheRead).toBe(300);
    expect(line.cacheWrite).toBe(50);
    expect(line.output).toBe(200);
    expect(line.reasoning).toBe(120);
    expect(line.finishReason).toBe("stop");
    expect(typeof line.durationMs).toBe("number");
    const all = everyLoggedString();
    expect(all).not.toContain("PROMPT-TEXT");
    expect(all).not.toContain("REPLY-TEXT");
    expect(all).not.toContain("12345");
  });

  it("prefers the multi-step total usage when the SDK reports one", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: usage(10, 5),
      totalUsage: usage(40, 20),
    });
    await generateTextForFeature("chat", { prompt: "hi" });
    expect(usageLines()[0].input).toBe(40);
    expect(usageLines()[0].output).toBe(20);
  });

  it("exposes the model that answered; after a not_found failover it is the next rung", async () => {
    generateTextMock
      .mockRejectedValueOnce(new FakeNotFound())
      .mockResolvedValueOnce({ text: "ok", finishReason: "stop", usage: usage(10, 5) });
    const res = await generateTextForFeature("chat", { prompt: "hi" });
    expect(res.answeredModelId).toBe("claude-haiku-5-5");
    // One line: the failed call did not complete.
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0].model).toBe("claude-haiku-5-5");
  });

  it("reads the provider's response model id when there is one", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      response: { modelId: "claude-sonnet-5-5-20261101" },
    });
    const res = await generateTextForFeature("chat", { prompt: "hi" });
    expect(res.answeredModelId).toBe("claude-sonnet-5-5-20261101");
  });

  it("keeps the result's own fields and shape (the added field is not enumerable)", async () => {
    const raw = { text: "ok", finishReason: "stop" };
    generateTextMock.mockResolvedValueOnce(raw);
    const res = await generateTextForFeature("chat", { prompt: "hi" });
    expect(res).toEqual({ text: "ok", finishReason: "stop" });
    expect(res.text).toBe("ok");
  });

  it("logs a refused call (it was billed) and still throws AIRefusalError", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "", finishReason: "content-filter", usage: usage(10, 1) });
    await expect(generateTextForFeature("chat", { prompt: "hi" })).rejects.toBeInstanceOf(AIRefusalError);
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0].finishReason).toBe("content-filter");
  });

  it("never throws into the caller when the log line itself fails", async () => {
    logSpy.mockImplementation(() => {
      throw new Error("log sink broken");
    });
    generateTextMock.mockResolvedValueOnce({ text: "ok", finishReason: "stop", usage: usage(1, 1) });
    const res = await generateTextForFeature("chat", { prompt: "hi" });
    expect(res.text).toBe("ok");
  });

  it("survives a result with hostile usage values (non-numbers become null)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: "PROMPT-TEXT", outputTokens: Number.NaN },
    });
    await generateTextForFeature("chat", { prompt: "hi" });
    expect(usageLines()[0].input).toBeNull();
    expect(usageLines()[0].output).toBeNull();
    expect(everyLoggedString()).not.toContain("PROMPT-TEXT");
  });
});

describe("generateObjectForFeature usage line", () => {
  it("writes one line and exposes the answering model", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { secret: SECRET_REPLY },
      finishReason: "stop",
      usage: usage(500, 80),
    });
    const res = await generateObjectForFeature("tradeReviewMain", { prompt: SECRET_PROMPT, schema: {} as never });
    expect(res.answeredModelId).toBe("claude-sonnet-5-5");
    const lines = usageLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("object");
    expect(lines[0].feature).toBe("tradeReviewMain");
    expect(lines[0].input).toBe(500);
    expect(everyLoggedString()).not.toContain("REPLY-TEXT");
    expect(everyLoggedString()).not.toContain("PROMPT-TEXT");
  });

  it("after a not_found failover the answering model is the next rung", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new FakeNotFound())
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: "stop" });
    const res = await generateObjectForFeature("tradeReviewMain", { prompt: "hi", schema: {} as never });
    expect(res.answeredModelId).toBe("claude-haiku-5-5");
    expect(usageLines()[0].model).toBe("claude-haiku-5-5");
  });

  it("logs a cut-off call the SDK could not parse (it was billed), then rethrows", async () => {
    const err = new NoObjectGeneratedError({
      message: "No object generated",
      text: SECRET_REPLY,
      response: { id: "r", timestamp: new Date(0), modelId: "claude-sonnet-5-5" },
      usage: usage(900, 16000) as never,
      finishReason: "length",
    });
    generateObjectMock.mockRejectedValueOnce(err);
    await expect(
      generateObjectForFeature("tradeReviewMain", { prompt: "hi", schema: {} as never }),
    ).rejects.toBe(err);
    const lines = usageLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].finishReason).toBe("length");
    expect(lines[0].output).toBe(16000);
    expect(everyLoggedString()).not.toContain("REPLY-TEXT");
  });
});

describe("formatAiUsageLine", () => {
  it("is built from the allowlist only", () => {
    const line = formatAiUsageLine({
      kind: "text",
      feature: "chat",
      model: "claude-sonnet-5-5",
      finishReason: "stop",
      durationMs: 12,
      usage: { ...usage(1, 2), prompt: SECRET_PROMPT } as never,
      // An extra field never reaches the line.
      ...({ prompt: SECRET_PROMPT } as object),
    } as never);
    expect(line.startsWith(AI_USAGE_LINE_PREFIX)).toBe(true);
    expect(line).not.toContain("PROMPT-TEXT");
    expect(Object.keys(JSON.parse(line.slice(AI_USAGE_LINE_PREFIX.length)))).toEqual([
      "kind",
      "feature",
      "model",
      "input",
      "noCache",
      "cacheRead",
      "cacheWrite",
      "output",
      "reasoning",
      "finishReason",
      "durationMs",
    ]);
  });
});
