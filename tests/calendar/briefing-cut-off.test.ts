import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(public feature: string, public modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { generateBriefingTextWithRegen } from "@/lib/calendar/briefing";

const mocked = vi.mocked(generateTextForFeature);
const reply = (text: string, finishReason: string) =>
  ({ text, finishReason }) as unknown as Awaited<ReturnType<typeof generateTextForFeature>>;
const run = () => generateBriefingTextWithRegen({ feature: "briefing", prompt: "p" });

beforeEach(() => {
  mocked.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("generateBriefingTextWithRegen cut-off handling", () => {
  it("a complete first reply is returned after one call", async () => {
    mocked.mockResolvedValueOnce(reply("Full briefing AAA.", "stop"));
    expect(await run()).toBe("Full briefing AAA.");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("asks for room for thinking: cap of at least 16,000", async () => {
    mocked.mockResolvedValueOnce(reply("ok", "stop"));
    await run();
    expect(mocked.mock.calls[0][1].maxOutputTokens).toBeGreaterThanOrEqual(16_000);
  });

  it("a cut-off first reply is retried once and the complete retry is returned", async () => {
    mocked
      .mockResolvedValueOnce(reply("Section one. Section tw", "length"))
      .mockResolvedValueOnce(reply("Complete briefing ZZZ.", "stop"));
    expect(await run()).toBe("Complete briefing ZZZ.");
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("cut off twice throws and never returns the partial text", async () => {
    mocked
      .mockResolvedValueOnce(reply("part one", "length"))
      .mockResolvedValueOnce(reply("part two", "length"));
    await expect(run()).rejects.toThrow(/cut off at the output cap/);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("self-admission then a cut-off retry throws", async () => {
    mocked
      .mockResolvedValueOnce(reply("The data looks corrupted in section 3.", "stop"))
      .mockResolvedValueOnce(reply("Clean but cut o", "length"));
    await expect(run()).rejects.toThrow(/cut off at the output cap/);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("a cut-off first reply never stacks with a self-admission regen (two calls total)", async () => {
    mocked
      .mockResolvedValueOnce(reply("The data looks corrupted in section 3. cut", "length"))
      .mockResolvedValueOnce(reply("Final text.", "stop"));
    expect(await run()).toBe("Final text.");
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("a refusal still returns an empty string", async () => {
    mocked.mockRejectedValueOnce(new AIRefusalError("briefing", "m"));
    expect(await run()).toBe("");
  });
});
