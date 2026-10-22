import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateObject: generateObjectMock,
}));

import { APICallError, NoObjectGeneratedError, jsonSchema } from "ai";
import {
  generateObjectWithModel,
  AITruncatedError,
  AIModelUnavailableError,
  AIRefusalError,
} from "@/lib/ai/generate";
import { getModelForId } from "@/lib/ai/provider";

// Catalog-fixture ids (tests only).
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-1";

const schema = jsonSchema({
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
});

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  generateObjectMock.mockReset();
});

function ok(finishReason = "stop") {
  return { object: { a: "x" }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason };
}

describe("getModelForId", () => {
  it("builds an Anthropic model for the exact id", () => {
    const m = getModelForId("printFilingSummary", OPUS) as { modelId: string; provider: string };
    expect(m.modelId).toBe(OPUS);
    expect(m.provider).toMatch(/anthropic/);
  });

  it("throws for a non-claude id", () => {
    expect(() => getModelForId("printFilingSummary", "gpt-5")).toThrow();
  });
});

describe("generateObjectWithModel", () => {
  it("sends the exact model, maxRetries 0, effort, and adaptive thinking for opus", async () => {
    generateObjectMock.mockResolvedValueOnce(ok());
    const r = await generateObjectWithModel(
      "printFilingSummary",
      { modelId: OPUS, effort: "high", family: "opus" },
      { schema, prompt: "p", maxOutputTokens: 32000 },
    );
    expect(r.object).toEqual({ a: "x" });
    expect(r.finishReason).toBe("stop");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0][0];
    expect(call.model.modelId).toBe(OPUS);
    expect(call.maxRetries).toBe(0);
    expect(call.maxOutputTokens).toBe(32000);
    expect(call.providerOptions.anthropic).toEqual({
      structuredOutputMode: "outputFormat",
      effort: "high",
      thinking: { type: "adaptive" },
    });
  });

  it("omits thinking for fable", async () => {
    generateObjectMock.mockResolvedValueOnce(ok());
    await generateObjectWithModel(
      "printFilingSummary",
      { modelId: FABLE, effort: "medium", family: "fable" },
      { schema, prompt: "p", maxOutputTokens: 32000 },
    );
    const call = generateObjectMock.mock.calls[0][0];
    expect(call.model.modelId).toBe(FABLE);
    expect(call.providerOptions.anthropic.effort).toBe("medium");
    expect("thinking" in call.providerOptions.anthropic).toBe(false);
  });

  it("finishReason length rejects AITruncatedError", async () => {
    generateObjectMock.mockResolvedValueOnce(ok("length"));
    await expect(
      generateObjectWithModel(
        "printFilingSummary",
        { modelId: OPUS, effort: "high", family: "opus" },
        { schema, prompt: "p", maxOutputTokens: 32000 },
      ),
    ).rejects.toBeInstanceOf(AITruncatedError);
  });

  it("an unparseable truncated object (NoObjectGeneratedError, length) rejects AITruncatedError", async () => {
    generateObjectMock.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        message: "no object",
        text: "{\"a\":",
        response: { id: "r", timestamp: new Date(0), modelId: OPUS },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "length",
      } as ConstructorParameters<typeof NoObjectGeneratedError>[0]),
    );
    await expect(
      generateObjectWithModel(
        "printFilingSummary",
        { modelId: OPUS, effort: "high", family: "opus" },
        { schema, prompt: "p", maxOutputTokens: 32000 },
      ),
    ).rejects.toBeInstanceOf(AITruncatedError);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it("finishReason content-filter rejects AIRefusalError", async () => {
    generateObjectMock.mockResolvedValueOnce(ok("content-filter"));
    await expect(
      generateObjectWithModel(
        "printFilingSummary",
        { modelId: OPUS, effort: "high", family: "opus" },
        { schema, prompt: "p", maxOutputTokens: 32000 },
      ),
    ).rejects.toBeInstanceOf(AIRefusalError);
  });

  it("a 404 rejects AIModelUnavailableError with no failover", async () => {
    generateObjectMock.mockRejectedValueOnce(
      new APICallError({
        message: "model not_found",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 404,
      }),
    );
    const p = generateObjectWithModel(
      "printFilingSummary",
      { modelId: OPUS, effort: "high", family: "opus" },
      { schema, prompt: "p", maxOutputTokens: 32000 },
    );
    await expect(p).rejects.toBeInstanceOf(AIModelUnavailableError);
    await expect(p).rejects.toMatchObject({ modelId: OPUS, feature: "printFilingSummary" });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it("other errors pass through unchanged", async () => {
    const boom = new Error("boom");
    generateObjectMock.mockRejectedValueOnce(boom);
    await expect(
      generateObjectWithModel(
        "printFilingSummary",
        { modelId: OPUS, effort: "high", family: "opus" },
        { schema, prompt: "p", maxOutputTokens: 32000 },
      ),
    ).rejects.toBe(boom);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });
});
