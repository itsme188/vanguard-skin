import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateTextMock, generateObjectMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  generateObjectMock: vi.fn(),
}));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: generateTextMock,
  generateObject: generateObjectMock,
}));

import {
  generateTextForFeature,
  generateObjectForFeature,
  isForcedToolUnsupported,
  AIRefusalError,
} from "@/lib/ai/generate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

class FakeNotFound extends Error { statusCode = 404; constructor() { super("model not_found"); } }

describe("generateTextForFeature", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("returns text on success", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "ok", finishReason: "stop" });
    const r = await generateTextForFeature("chat", { prompt: "hi" });
    expect(r.text).toBe("ok");
  });

  it("on not_found, drops the dead model and retries once with the next rung", async () => {
    generateTextMock
      .mockRejectedValueOnce(new FakeNotFound())                  // fable 404s
      .mockResolvedValueOnce({ text: "ok2", finishReason: "stop" }); // opus succeeds
    const r = await generateTextForFeature("chat", { prompt: "hi" });
    expect(r.text).toBe("ok2");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    // Prove the first call used Fable and the retry used the NEXT rung (Opus), not Fable again.
    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe("claude-fable-5");
    expect(generateTextMock.mock.calls[1][0].model.modelId).toBe("claude-opus-4-8");
  });

  it("on refusal finishReason, throws AIRefusalError (graceful, named)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "", finishReason: "content-filter" });
    await expect(generateTextForFeature("chat", { prompt: "hi" })).rejects.toBeInstanceOf(AIRefusalError);
  });
});

// QA: analysis-trade-reviews--generate-review-dies-raw-anthropic-tool-choice-error
//
// @ai-sdk/anthropic's getModelCapabilities() knows no 5-generation model id, so
// it scores `claude-fable-5-1` supportsStructuredOutput:false and generateObject
// falls back to a synthetic `json` tool pinned with `tool_choice: {type:"any"}`.
// The Fable/Mythos 5 family rejects forced tool use with a 400. The wrapper now
// asks for Anthropic's native structured output up front (provider option
// `structuredOutputMode: "outputFormat"` → `output_config.format`, no tool and
// no tool_choice in the body), and retries once with it forced if the 400 still
// arrives from a caller that set the mode itself.
const TOOL_CHOICE_400 =
  'tool_choice: type "tool" and "any" are not supported for this model.';

class FakeForcedToolUnsupported extends Error {
  statusCode = 400;
  constructor() {
    super(TOOL_CHOICE_400);
  }
}

function anthropicOptionsOf(callIndex: number): Record<string, unknown> | undefined {
  const args = generateObjectMock.mock.calls[callIndex][0] as {
    providerOptions?: { anthropic?: Record<string, unknown> };
  };
  return args.providerOptions?.anthropic;
}

describe("generateObjectForFeature", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("asks the Anthropic provider for native structured output, not the json-tool fallback", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { ok: true } });
    await generateObjectForFeature("tradeReviewMain", { prompt: "hi", schema: {} as never });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(anthropicOptionsOf(0)?.structuredOutputMode).toBe("outputFormat");
  });

  it("respects a caller-set structuredOutputMode", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { ok: true } });
    await generateObjectForFeature("tradeReviewMain", {
      prompt: "hi",
      schema: {} as never,
      providerOptions: { anthropic: { structuredOutputMode: "jsonTool" } },
    } as never);
    expect(anthropicOptionsOf(0)?.structuredOutputMode).toBe("jsonTool");
  });

  it("preserves other provider options while merging the mode in", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { ok: true } });
    await generateObjectForFeature("tradeReviewMain", {
      prompt: "hi",
      schema: {} as never,
      providerOptions: { anthropic: { effort: "high" } },
    } as never);
    expect(anthropicOptionsOf(0)).toEqual({
      effort: "high",
      structuredOutputMode: "outputFormat",
    });
  });

  it("on a forced-tool-unsupported 400, retries EXACTLY once with outputFormat forced", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new FakeForcedToolUnsupported())
      .mockResolvedValueOnce({ object: { ok: true } });
    const res = (await generateObjectForFeature("tradeReviewMain", {
      prompt: "hi",
      schema: {} as never,
      // A caller that overrode the mode is the only way this 400 can still fire.
      providerOptions: { anthropic: { structuredOutputMode: "jsonTool" } },
    } as never)) as unknown as { object: { ok: boolean } };

    expect(res.object.ok).toBe(true);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(anthropicOptionsOf(0)?.structuredOutputMode).toBe("jsonTool");
    expect(anthropicOptionsOf(1)?.structuredOutputMode).toBe("outputFormat");
    // Same model — a capability mismatch is not a dead model.
    const first = generateObjectMock.mock.calls[0][0] as { model: { modelId: string } };
    const second = generateObjectMock.mock.calls[1][0] as { model: { modelId: string } };
    expect(second.model.modelId).toBe(first.model.modelId);
  });

  it("does not retry a second time when the forced-tool retry also fails", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new FakeForcedToolUnsupported())
      .mockRejectedValueOnce(new FakeForcedToolUnsupported());
    await expect(
      generateObjectForFeature("tradeReviewMain", { prompt: "hi", schema: {} as never }),
    ).rejects.toBeInstanceOf(FakeForcedToolUnsupported);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("still fails over on not_found, dropping the dead model for the next rung", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new FakeNotFound())
      .mockResolvedValueOnce({ object: { ok: true } });
    await generateObjectForFeature("tradeReviewMain", { prompt: "hi", schema: {} as never });
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    const first = generateObjectMock.mock.calls[0][0] as { model: { modelId: string } };
    const second = generateObjectMock.mock.calls[1][0] as { model: { modelId: string } };
    expect(first.model.modelId).toBe("claude-fable-5");
    expect(second.model.modelId).toBe("claude-opus-4-8");
    // The failover request still carries the native-structured-output ask.
    expect(anthropicOptionsOf(1)?.structuredOutputMode).toBe("outputFormat");
  });

  it("rethrows an unrelated error untouched", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("schema validation failed"));
    await expect(
      generateObjectForFeature("tradeReviewMain", { prompt: "hi", schema: {} as never }),
    ).rejects.toThrow("schema validation failed");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });
});

describe("isForcedToolUnsupported", () => {
  it("matches Anthropic's exact forced-tool 400 prose", () => {
    expect(isForcedToolUnsupported(new Error(TOOL_CHOICE_400))).toBe(true);
  });

  it("matches the same text inside a full error envelope", () => {
    expect(
      isForcedToolUnsupported(
        new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"${TOOL_CHOICE_400}"}}`),
      ),
    ).toBe(true);
  });

  it("does not match an unrelated 400", () => {
    expect(isForcedToolUnsupported(new Error("messages.0.content.0.pdf: invalid"))).toBe(false);
    expect(isForcedToolUnsupported(new FakeNotFound())).toBe(false);
  });
});
