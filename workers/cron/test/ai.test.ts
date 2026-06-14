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
});
