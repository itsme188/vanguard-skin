/**
 * The content-free usage line on the EXPLICIT-model helper (review round 3,
 * Analysis tab fix wave 2026-11-15, Z7). `generateObjectWithModel` writes the
 * same one `[ai-usage]` line as the feature helpers, carries the model that
 * answered as a non-enumerable `answeredModelId`, logs a billed cut-off or
 * refusal too, and a broken log sink never fails the call. Only
 * `generateObject` is mocked (the provider seam the other tests in tests/ai use).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateObject: generateObjectMock,
}));

import { NoObjectGeneratedError, jsonSchema } from "ai";
import {
  generateObjectWithModel,
  AI_USAGE_LINE_PREFIX,
  AITruncatedError,
} from "@/lib/ai/generate";

const OPUS = "claude-opus-5-5";
const SECRET_PROMPT = "PROMPT-TEXT-ZZA holds 12345 shares";
const schema = jsonSchema({
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
});

let logSpy: ReturnType<typeof vi.spyOn>;
function usageLines(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c: unknown[]) => c[0])
    .filter((l: unknown): l is string => typeof l === "string" && l.startsWith(AI_USAGE_LINE_PREFIX))
    .map((l: string) => JSON.parse(l.slice(AI_USAGE_LINE_PREFIX.length)) as Record<string, unknown>);
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  generateObjectMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const target = { modelId: OPUS, effort: "high" as const, family: "opus" as const };

describe("generateObjectWithModel usage line", () => {
  it("writes one content-free line and carries the answering model, with the result's shape unchanged", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { a: "REPLY-TEXT" },
      usage: { inputTokens: 100, outputTokens: 20 },
      finishReason: "stop",
      response: { modelId: "claude-opus-5-5-20261101" },
    });
    const r = await generateObjectWithModel("printFilingSummary", target, {
      schema, prompt: SECRET_PROMPT, maxOutputTokens: 32000,
    });
    expect(r).toEqual({ object: { a: "REPLY-TEXT" }, usage: { inputTokens: 100, outputTokens: 20 }, finishReason: "stop" });
    expect((r as { answeredModelId?: string }).answeredModelId).toBe("claude-opus-5-5-20261101");
    expect(Object.keys(r)).not.toContain("answeredModelId");
    const lines = usageLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "object", feature: "printFilingSummary", model: "claude-opus-5-5-20261101",
      input: 100, output: 20, finishReason: "stop",
    });
    const all = logSpy.mock.calls.flat().map(String).join("\n");
    expect(all).not.toContain("PROMPT-TEXT");
    expect(all).not.toContain("REPLY-TEXT");
  });

  it("falls back to the id it sent when the provider names none", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { a: "x" }, usage: {}, finishReason: "stop" });
    const r = await generateObjectWithModel("printFilingSummary", target, { schema, prompt: "p", maxOutputTokens: 100 });
    expect((r as { answeredModelId?: string }).answeredModelId).toBe(OPUS);
    expect(usageLines()[0].model).toBe(OPUS);
  });

  it("a billed reply cut off at the cap is logged, then raised as a truncation", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { a: "x" }, usage: { outputTokens: 100 }, finishReason: "length" });
    await expect(
      generateObjectWithModel("printFilingSummary", target, { schema, prompt: "p", maxOutputTokens: 100 }),
    ).rejects.toBeInstanceOf(AITruncatedError);
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0].finishReason).toBe("length");
  });

  it("a billed reply that did not parse is logged once, then raised as a truncation", async () => {
    generateObjectMock.mockRejectedValueOnce(new NoObjectGeneratedError({
      message: "No object generated",
      text: "{\"a\": \"par",
      response: { id: "r", timestamp: new Date(0), modelId: OPUS },
      usage: { inputTokens: 5, outputTokens: 100, totalTokens: 105 } as never,
      finishReason: "length",
    }));
    await expect(
      generateObjectWithModel("printFilingSummary", target, { schema, prompt: "p", maxOutputTokens: 100 }),
    ).rejects.toBeInstanceOf(AITruncatedError);
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0].output).toBe(100);
  });

  it("a broken log sink never fails the call", async () => {
    logSpy.mockImplementation(() => {
      throw new Error("sink down");
    });
    generateObjectMock.mockResolvedValueOnce({ object: { a: "x" }, usage: {}, finishReason: "stop" });
    const r = await generateObjectWithModel("printFilingSummary", target, { schema, prompt: "p", maxOutputTokens: 100 });
    expect(r.object).toEqual({ a: "x" });
  });
});
