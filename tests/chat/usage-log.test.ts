import { describe, it, expect, vi, afterEach } from "vitest";
import { APICallError } from "ai";
import {
  formatUsageLine,
  formatChatError,
  logChatError,
  usageTokenFields,
  USAGE_LINE_KEYS_STEP,
  USAGE_LINE_KEYS_TURN,
  type UsageStepFields,
} from "@/lib/chat/usage-log";

// Plan D6 + P15: the chat's server-log lines are allowlisted. No message
// content, no prompt text, no tool input or output, no portfolio figures.

const MARKER = "SECRET-PROMPT-MARKER-4b1d";

afterEach(() => {
  vi.restoreAllMocks();
});

function parse(line: string): Record<string, unknown> {
  expect(line.startsWith("[chat-usage] ")).toBe(true);
  return JSON.parse(line.slice("[chat-usage] ".length));
}

describe("formatUsageLine", () => {
  it("names the model class keys exactly (2026-11-13) and accepts only the three classes", () => {
    expect([...USAGE_LINE_KEYS_STEP]).toEqual([
      "kind", "conversationId", "scope", "model", "modelFamily", "modelFellBackFrom",
      "step", "noCache", "cacheWrite", "cacheRead", "output", "finishReason",
    ]);
    expect(USAGE_LINE_KEYS_TURN.slice(0, 7)).toEqual([
      "kind", "conversationId", "scope", "model", "modelFamily", "modelFellBackFrom", "steps",
    ]);
    const base = { conversationId: 1, scope: "all", model: "m", step: 0, noCache: 0, cacheWrite: 0, cacheRead: 0, output: 0, finishReason: "stop" };
    const good = parse(formatUsageLine("step", { ...base, modelFamily: "opus", modelFellBackFrom: "haiku" }));
    expect(good.modelFamily).toBe("opus");
    expect(good.modelFellBackFrom).toBe("haiku");
    const bad = parse(formatUsageLine("step", { ...base, modelFamily: MARKER, modelFellBackFrom: "fable" }));
    expect(bad.modelFamily).toBeNull();
    expect(bad.modelFellBackFrom).toBeNull();
    const turn = parse(formatUsageLine("turn", { ...base, steps: 1, modelFamily: "sonnet" }));
    expect(turn.modelFamily).toBe("sonnet");
    expect(turn.modelFellBackFrom).toBeNull();
  });

  it("the line carries only the allowed keys", () => {
    const fields = {
      conversationId: 7,
      scope: "ibkr",
      model: "model-under-test",
      step: 2,
      noCache: 10,
      cacheWrite: 20,
      cacheRead: 30,
      output: 40,
      finishReason: "tool-calls",
      // Extra keys a careless caller might pass: none may reach the log.
      text: `the answer ${MARKER}`,
      prompt: MARKER,
      toolInput: { symbol: MARKER },
      marketValue: 123.45,
    } as unknown as UsageStepFields;

    const line = formatUsageLine("step", fields);
    const obj = parse(line);
    expect(Object.keys(obj).sort()).toEqual([...USAGE_LINE_KEYS_STEP].sort());
    expect(obj).toEqual({
      kind: "step",
      conversationId: 7,
      scope: "ibkr",
      model: "model-under-test",
      modelFamily: null,
      modelFellBackFrom: null,
      step: 2,
      noCache: 10,
      cacheWrite: 20,
      cacheRead: 30,
      output: 40,
      finishReason: "tool-calls",
    });
    expect(line).not.toContain(MARKER);
    expect(line).not.toContain("123.45");
  });

  it("a turn line counts steps instead of naming one", () => {
    const obj = parse(
      formatUsageLine("turn", {
        conversationId: 1,
        scope: "all",
        model: "m",
        steps: 3,
        noCache: 1,
        cacheWrite: 2,
        cacheRead: 3,
        output: 4,
        finishReason: "stop",
      }),
    );
    expect(Object.keys(obj).sort()).toEqual([...USAGE_LINE_KEYS_TURN].sort());
    expect(obj.steps).toBe(3);
    expect("step" in obj).toBe(false);
    // A turn that was not aborted says so explicitly.
    expect(obj.abortedSteps).toBe(0);
    expect(obj.abortedOutputEstimate).toBeNull();
    expect(obj.abortedInputEstimate).toBeNull();
    expect(obj.abortedInputCache).toBeNull();
    expect(obj.abortedStepProcessed).toBeNull();
  });

  it("an aborted turn line names the aborted step and its output estimate, and nothing else", () => {
    const obj = parse(
      formatUsageLine("turn", {
        conversationId: 1,
        scope: "all",
        model: "m",
        steps: 1,
        noCache: 1,
        cacheWrite: 2,
        cacheRead: 3,
        output: 4,
        finishReason: "abort",
        abortedSteps: 1,
        abortedOutputEstimate: 7,
        abortedInputEstimate: 5000,
        abortedInputCache: "unknown",
        abortedStepProcessed: "maybe-not",
        abortedText: MARKER,
      } as unknown as Parameters<typeof formatUsageLine>[1] & { steps: number }),
    );
    expect(Object.keys(obj).sort()).toEqual([...USAGE_LINE_KEYS_TURN].sort());
    expect(obj).toMatchObject({
      abortedSteps: 1,
      abortedOutputEstimate: 7,
      abortedInputEstimate: 5000,
      abortedInputCache: "unknown",
      abortedStepProcessed: "maybe-not",
      finishReason: "abort",
    });
    expect(JSON.stringify(obj)).not.toContain(MARKER);
  });

  it("the two status keys accept only their fixed values", () => {
    const obj = parse(
      formatUsageLine("turn", {
        conversationId: 1,
        scope: "all",
        model: "m",
        steps: 0,
        noCache: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        finishReason: "abort",
        abortedSteps: 1,
        abortedInputCache: MARKER,
        abortedStepProcessed: MARKER,
      } as unknown as Parameters<typeof formatUsageLine>[1] & { steps: number }),
    );
    expect(obj.abortedInputCache).toBeNull();
    expect(obj.abortedStepProcessed).toBeNull();
    expect(JSON.stringify(obj)).not.toContain(MARKER);
  });

  it("a string smuggled into a numeric field is dropped to null", () => {
    const obj = parse(
      formatUsageLine("step", {
        conversationId: 1,
        scope: "all",
        model: "m",
        step: 0,
        noCache: MARKER as unknown as number,
        cacheWrite: undefined,
        cacheRead: 0,
        output: 5,
        finishReason: "stop",
      }),
    );
    expect(obj.noCache).toBeNull();
    expect(obj.cacheWrite).toBeNull();
    expect(JSON.stringify(obj)).not.toContain(MARKER);
  });

  it("usageTokenFields reads the SDK usage shape", () => {
    expect(
      usageTokenFields({
        inputTokens: 60,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 20 },
        outputTokens: 40,
      }),
    ).toEqual({ noCache: 10, cacheWrite: 20, cacheRead: 30, output: 40 });
    expect(usageTokenFields(undefined)).toEqual({ noCache: null, cacheWrite: null, cacheRead: null, output: null });
  });
});

describe("logChatError (P15)", () => {
  function sdkError(): APICallError {
    return new APICallError({
      message: "Overloaded",
      url: "https://api.example.invalid/v1/messages",
      requestBodyValues: { system: [{ text: MARKER }], messages: [{ content: MARKER }] },
      statusCode: 529,
      responseBody: JSON.stringify({ error: { type: "overloaded_error", message: MARKER } }),
      data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      cause: new Error(MARKER),
    });
  }

  it("an SDK error carrying request body values logs none of them", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logChatError("streamText", sdkError());
    expect(spy).toHaveBeenCalledTimes(1);
    const printed = spy.mock.calls[0].map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    expect(printed).not.toContain(MARKER);
    expect(printed).toContain("streamText");
    expect(printed).toContain("529");
    expect(printed).toContain("overloaded_error");
    // every argument is a plain string: no object for the console to expand
    for (const arg of spy.mock.calls[0]) expect(typeof arg).toBe("string");
  });

  it("keeps only name, status, provider error type and a short message", () => {
    const out = formatChatError(sdkError());
    expect(Object.keys(out).sort()).toEqual(["message", "name", "providerErrorType", "statusCode"]);
    expect(out.statusCode).toBe(529);
    expect(out.providerErrorType).toBe("overloaded_error");
  });

  it("truncates a long message to 200 characters", () => {
    const out = formatChatError(new Error("x".repeat(500)));
    expect(out.message.length).toBe(200);
    expect(out.name).toBe("Error");
    expect(out.statusCode).toBeNull();
  });

  it("reads a retry wrapper's last error and a non-Error value safely", () => {
    const wrapped = { name: "AI_RetryError", message: "Failed after 3 attempts.", lastError: sdkError() };
    const out = formatChatError(wrapped);
    expect(out.statusCode).toBe(529);
    expect(JSON.stringify(out)).not.toContain(MARKER);
    expect(formatChatError("plain string")).toEqual({
      name: "unknown",
      statusCode: null,
      providerErrorType: null,
      message: "plain string",
    });
  });
});
