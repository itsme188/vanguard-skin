import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test (per the
// `memory/feedback_ai_test_mocking.md` pattern: any test that touches AI
// MUST mock generateTextForFeature so the test is deterministic regardless
// of whether `.env.local` is loaded).
// ---------------------------------------------------------------------------

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(public feature: string, public modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));

// ---------------------------------------------------------------------------

import { generateTextForFeature } from "@/lib/ai/generate";
import { generateBriefingTextWithRegen } from "@/lib/calendar/briefing";

const mockedGenerate = vi.mocked(generateTextForFeature);

beforeEach(() => {
  mockedGenerate.mockReset();
});

describe("generateBriefingTextWithRegen", () => {
  it("returns the first attempt verbatim when no self-admission detected", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: "# Week of 2026-05-11\n\nClean briefing with no self-admission.",
      // The AI SDK's generateText result has more fields than this; the
      // function only reads `.text`, so the partial mock is sufficient.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "Generate a briefing for week 2026-05-11.",
    });

    expect(result).toContain("Clean briefing");
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it("regenerates once with addendum when first draft contains self-admission", async () => {
    mockedGenerate
      .mockResolvedValueOnce({
        text: "# Week of 2026-05-11\n\nThe data looks corrupted in §3.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockResolvedValueOnce({
        text: "# Week of 2026-05-11\n\nClean retry with proper data.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    const result = await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "Generate a briefing for week 2026-05-11.",
    });

    expect(result).toContain("Clean retry");
    expect(mockedGenerate).toHaveBeenCalledTimes(2);

    const secondCallArgs = mockedGenerate.mock.calls[1][1];
    expect(secondCallArgs.prompt).toContain("RETRY DUE TO SELF-ADMISSION");
    expect(secondCallArgs.prompt).toContain('"data looks corrupted"');
    expect(secondCallArgs.prompt).toContain(
      "Generate a briefing for week 2026-05-11.",
    );
  });

  it("caps retries at exactly 1 (does NOT loop forever when retry also leaks)", async () => {
    mockedGenerate
      .mockResolvedValueOnce({
        text: "The data looks corrupted.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockResolvedValueOnce({
        // Retry STILL contains a self-admission phrase — but we must not loop
        text: "I cannot verify the actuals on retry.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    const result = await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "P",
    });

    expect(result).toContain("cannot verify");
    expect(mockedGenerate).toHaveBeenCalledTimes(2); // first + 1 retry, no further
  });

  it("calls onRegen hook with matched phrases when retrying", async () => {
    mockedGenerate
      .mockResolvedValueOnce({
        text: "The data isn't available and I cannot verify the print.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockResolvedValueOnce({
        text: "Clean retry.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    const onRegen = vi.fn();
    await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "P",
      onRegen,
    });

    expect(onRegen).toHaveBeenCalledTimes(1);
    const matches = onRegen.mock.calls[0][0];
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBeGreaterThanOrEqual(2); // both phrases caught
  });

  it("respects custom maxOutputTokens parameter", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: "Clean.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "P",
      maxOutputTokens: 16384,
    });

    expect(mockedGenerate.mock.calls[0][1].maxOutputTokens).toBe(16384);
  });

  it("defaults maxOutputTokens to 8192 when omitted", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: "Clean.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "P",
    });

    expect(mockedGenerate.mock.calls[0][1].maxOutputTokens).toBe(8192);
  });

  it("returns empty string when model refuses on first attempt", async () => {
    const { AIRefusalError } = await import("@/lib/ai/generate");
    mockedGenerate.mockRejectedValueOnce(
      new AIRefusalError("briefing", "claude-fable-5"),
    );

    const result = await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "P",
    });

    expect(result).toBe("");
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it("returns empty string when model refuses on retry attempt", async () => {
    const { AIRefusalError } = await import("@/lib/ai/generate");
    mockedGenerate
      .mockResolvedValueOnce({
        text: "The data looks corrupted.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockRejectedValueOnce(
        new AIRefusalError("briefing", "claude-fable-5"),
      );

    const result = await generateBriefingTextWithRegen({
      feature: "briefing",
      prompt: "P",
    });

    expect(result).toBe("");
    expect(mockedGenerate).toHaveBeenCalledTimes(2);
  });

  it("re-throws non-refusal errors", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("Network failure"));

    await expect(
      generateBriefingTextWithRegen({
        feature: "briefing",
        prompt: "P",
      }),
    ).rejects.toThrow("Network failure");
  });
});
