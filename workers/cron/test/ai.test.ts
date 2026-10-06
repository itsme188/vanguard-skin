import { describe, it, expect, vi } from "vitest";
import { generateWithFailover } from "../src/ai";

describe("worker reactive failover", () => {
  it("fails over on a 404", async () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    const call = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("not_found"), { statusCode: 404 }))
      .mockResolvedValueOnce("ok");
    const out = await generateWithFailover(env as never, "fallbackBriefing", ["claude-fable-5", "claude-opus-4-8"], call);
    expect(out).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("re-throws on non-404 errors", async () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error("rate_limited"), { statusCode: 429 }));
    await expect(
      generateWithFailover(env as never, "fallbackBriefing", ["claude-opus-4-8"], call),
    ).rejects.toThrow("rate_limited");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("succeeds on first try without failover", async () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    const call = vi.fn().mockResolvedValueOnce("first-ok");
    const out = await generateWithFailover(env as never, "fallbackEvening", ["claude-sonnet-4-6"], call);
    expect(out).toBe("first-ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries ONCE with jsonTool when native structured output is rejected", async () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    const call = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("output_config.format: json_schema is not supported"), { statusCode: 400 }))
      .mockResolvedValueOnce("ok");
    const out = await generateWithFailover(env as never, "fallbackBriefing", ["claude-fable-5"], call);
    expect(out).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][1]).toBe("outputFormat");
    expect(call.mock.calls[1][1]).toBe("jsonTool");
  });

  it("does not jsonTool-retry a forced-tool 400", async () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    const call = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('tool_choice: type "tool" and "any" are not supported for this model.'), { statusCode: 400 }),
    );
    await expect(
      generateWithFailover(env as never, "fallbackBriefing", ["claude-fable-5"], call),
    ).rejects.toThrow("tool_choice");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
